/**
 * v3 promote runner: the "session tree → long-term memory" pipeline, wired as pure
 * logic with injected I/O so it can be tested offline (this repo's rule: `lib/*.js`
 * never imports `@deepseek-ai/*`; only `index.js` does, at the wiring layer).
 *
 * What it does, in order (promote-plan §10 steps 1→2→3):
 *   1. `selectPromotable(nodes)`     — pick candidates out of a session tree (gates live
 *                                      in promote.js: kind / content / weight).
 *   2. `toLtmRecord(node, meta)`      — give each a content-hash id + provenance; we now
 *                                      also derive `subject` via extractSubject (§10 blank).
 *   3. `mergeLtm(existing, incoming)` — fold into the store, mark supersedes, evict to
 *                                      budget.
 *
 * The runner does NOT touch storage. It takes the current records and returns the merged
 * set + stats. `index.js` owns the open domain and does the actual `put` of every record
 * whose value changed (including archived / superseded marks).
 *
 * Idempotency: feeding the same nodes twice yields the same store. `mergeLtm` keeps one
 * record per id and only *marks* retirement; re-running does not double-count `superseded`
 * (promote-plan §6.2). `hits`/`rev` do increment on a genuine re-promotion of the same
 * content from a *different* source, which is intended (a fact repeated is stronger).
 *
 * @module dsh-memory/promote-runner
 */

import { selectPromotable, toLtmRecord, mergeLtm, applyWorkPivots } from "./promote.js";
import { extractSubject } from "./subject.js";

/**
 * Run one promote pass over a batch of session nodes.
 *
 * @param {object} input - pass inputs.
 * @param {object[]} input.nodes - session tree nodes (already reconstructed from the
 *   event log by the caller; this module does not read logs).
 * @param {object[]} input.existing - current LTM records (from the store).
 * @param {string} input.sessionId - owning session id, for provenance.
 * @param {number} [input.turn] - the turn these nodes belong to (provenance).
 * @param {number} [input.now] - wall clock for `promotedAt` / supersede stamp; caller
 *   supplies it so the same input is reproducible (never `Date.now()` here).
 * @param {string} [input.work] - v8 work key (`work:<name>`) applied to every node in
 *   this pass. null/omitted ⇒ no work grouping (pre-v8 behaviour).
 * @param {object} [input.limits] - `{ minWeight, max, maxNodes, maxTokens, tombstone }`
 *   forwarded to selectPromotable / mergeLtm / applyWorkPivots. Undefined keys fall back
 *   to promote.js DEFAULTS.
 * @returns {{ records: object[], stats: object }} merged store + merge stats
 *   (`{ added, updated, superseded, evicted, kept, selected, pivotsCreated, pivotsLinked }`).
 */
export function runPromotePass(input = {}) {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const existing = Array.isArray(input.existing) ? input.existing : [];
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "unknown";
  const turn = Number.isFinite(input.turn) ? input.turn : undefined;
  const now = Number.isFinite(input.now) ? input.now : 0;
  const limits = input.limits ?? {};
  // v8: the work key (already derived by the caller via extractWork). One value applies
  // to every node in this pass — a promote pass runs against one session's tree, which
  // belongs to one piece of work. null/omitted ⇒ pre-v8 behaviour (no work grouping).
  const work = typeof input.work === "string" && input.work.trim() !== "" ? input.work.trim() : null;

  // 1. pick candidates (gates are inside selectPromotable).
  const picked = selectPromotable(nodes, {
    minWeight: limits.minWeight,
    max: limits.max,
  });

  // 2. turn each into an LTM record with a subject, so supersedes can fire.
  const incoming = picked.map((node) => {
    const subject = extractSubject(node);
    return toLtmRecord(node, {
      sessionId,
      turn,
      promotedAt: now,
      // Only pass subject when we actually derived one; passing `null` is the same as
      // omitting it for toLtmRecord, but being explicit documents the intent.
      ...(subject === null ? {} : { subject }),
      // The event span this node was distilled from (carried by `distillTurn`).
      // `toLtmRecord` records it as `sources[].seqRange`; together with the source
      // `sessionId` it is what lets a later session replay the original text via
      // `memory_fetch(seq, sessionId)` instead of only seeing the excerpt.
      ...(Array.isArray(node?.seqRange) && node.seqRange.length === 2
        ? { seqRange: node.seqRange }
        : {}),
      // v8: attach the work grouping edge when the caller supplied one.
      ...(work === null ? {} : { work }),
    });
  });

  // 3. merge into the store (supersede + evict to budget).
  const merged = mergeLtm(existing, incoming, {
    maxNodes: limits.maxNodes,
    maxTokens: limits.maxTokens,
    now,
    tombstone: limits.tombstone === true,
  });

  // 4. v8: lazy work pivots. Attach a pivot to any work with ≥2 live records and point
  // its records at it. Runs after merge (needs the settled live set) and re-applies the
  // budget so pivots cannot push the store past its ceiling. Idempotent.
  const pivoted = applyWorkPivots(merged.records, {
    maxNodes: limits.maxNodes,
    maxTokens: limits.maxTokens,
    now,
  });

  return {
    records: pivoted.records,
    stats: {
      ...merged.stats,
      selected: incoming.length,
      pivotsCreated: pivoted.stats.pivotsCreated,
      pivotsLinked: pivoted.stats.pivotsLinked,
    },
  };
}

/**
 * Diff two record sets by id+rev to find which records the store must (re)write.
 *
 * `mergeLtm` returns the *whole* store; writing all of it every pass is wasteful and
 * would churn `domain/changed` events for untouched records. We only return records whose
 * `rev` (bumped on every update) or whose retirement marks differ from what is stored.
 * New ids are included. A record present in the store but absent from `nextRecords` is a
 * genuine deletion (mergeLtm never drops ids, so this is normally empty).
 *
 * @param {object[]} stored - records currently in the store.
 * @param {object[]} nextRecords - merged records from `runPromotePass`.
 * @returns {{ put: object[], deletedIds: string[] }} writes to apply.
 */
export function diffForWrite(stored, nextRecords) {
  const byId = new Map();
  for (const record of stored ?? []) {
    if (record?.id) byId.set(record.id, record);
  }

  const put = [];
  const seen = new Set();
  for (const record of nextRecords ?? []) {
    if (!record?.id) continue;
    seen.add(record.id);
    const previous = byId.get(record.id);
    if (previous === undefined) {
      put.push(record); // new
      continue;
    }
    // Cheap equality on the fields merge can change. `rev` catches merges; the explicit
    // retirement flags catch archival / supersede transitions that don't bump rev.
    if (
      previous.rev !== record.rev ||
      previous.archived !== record.archived ||
      previous.supersededAt !== record.supersededAt ||
      previous.subject !== record.subject ||
      // v8: a work or pivot change means the record must be rewritten even though rev
      // did not bump (pivot attachment is a structural edit, not a merge).
      previous.work !== record.work ||
      previous.pivotId !== record.pivotId ||
      previous.parentId !== record.parentId ||
      (previous.supersedes?.length ?? 0) !== (record.supersedes?.length ?? 0)
    ) {
      put.push(record);
    }
  }

  const deletedIds = [...byId.keys()].filter((id) => !seen.has(id));
  return { put, deletedIds };
}

export default runPromotePass;
