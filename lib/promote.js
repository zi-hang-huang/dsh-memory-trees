/**
 * v3 promote: which session memories become long-term records, and how they stay bounded.
 *
 * The policy lives in `dsh-memory-promote-plan.md`; this file is its pure core. Three
 * steps, each independently testable and none of them touching storage:
 *
 *   selectPromotable  pick candidates out of a session tree
 *   toLtmRecord       give a candidate a stable, content-derived identity + provenance
 *   mergeLtm          fold new records into the existing store and evict down to budget
 *
 * Two decisions here are load-bearing and easy to get wrong later:
 *
 * 1. **Identity is the content hash, not the tree id.** A session tree id is
 *    `s1234-decision-m0` — meaningless outside that session. Hashing the normalized
 *    text instead makes the same fact from two sessions one record, which is what
 *    keeps the LTM bounded without inventing a similarity metric (embeddings are
 *    explicitly out of scope, plan §1.2).
 *
 * 2. **`episode` is never promoted.** D7 stores a pointer, not the tool output; once
 *    the session's log rotates the pointer refers to nothing. A record that says
 *    "tool ok" is not knowledge, it is a dangling reference.
 */
import { createHash } from "node:crypto";

import { dedupKey } from "./consolidate.js";
import { priceString } from "./pricing.js";
import { ID_PATTERN } from "./tree.js";

/** Node kinds allowed to become long-term records. */
export const PROMOTE_KINDS = Object.freeze(["task", "decision"]);

/**
 * Markers that make a `task` a standing instruction rather than a one-off request.
 *
 * A `task` node is always pinned and always weighs 1, so weight says nothing about it;
 * without this filter the LTM fills up with "read that file for me". The list is
 * deliberately narrow — missing a real standing instruction costs one forgotten rule,
 * while accepting a one-off costs permanent noise in every later session's recall.
 */
export const INSTRUCTION_PATTERNS = Object.freeze([
  /记住/,
  /以后/,
  /今后/,
  /始终/,
  /一律/,
  /别再/,
  /不要再/,
  /下次/,
  /永久/,
  /\balways\b/i,
  /\bnever\b/i,
  /from now on/i,
  /remember\s+(that|to)\b/i,
  /\bdo not\b/i,
]);

/** Default weight a `decision` needs to qualify. */
export const DEFAULT_MIN_WEIGHT = 0.5;

/**
 * Markers that make a `decision` *process chatter* rather than knowledge.
 *
 * The failure this guards against (measured live): a working session's step-by-step
 * talk gets distilled into `decision` nodes — "关键证据在 index.js 14–15 行",
 * "好了，先看实测状态再决定", "把 X 更正写进文档" — and, once their weight clears the
 * floor, they are promoted into the LTM and re-surfaced by recall in later sessions.
 * A record that describes *what the agent was doing* is not a fact; it is a diary
 * entry. This list rejects those, purely lexically (no model call).
 *
 * Kept deliberately narrow and high-precision: a process phrase must be *led* by or
 * *dominated* by one of these. Missing a real fact costs one forgotten fact; accepting
 * a diary entry pollutes every later session's recall, which is the costlier error.
 */
export const PROCESS_PATTERNS = Object.freeze([
  /^(好了|好的|行|可以|嗯|对)[，,、。\s]/,
  /^(先|接下来|下面|然后|现在|接着)(看|做|改|跑|试|查|写|处理|确认|分析)/,
  /关键证据(在|是)/,
  /^(我|我们)(们)?(看|查|试|跑|改|读|写|确认)了/,
  /(试了|试一下|改了|跑一下|看一下|查一下|读一下|写一下)/,
  /把.{0,20}(更正|补|改|写|加|删|挪)(进|到|入|上)/,
  /(待办|下一步|TODO|todo)[：:]/,
  /(继续|接着)(写|做|改|分析|确认|整理)/,

  // --- English agent-action monologue (v8-b, measured live 2026-11-07).
  // Real LTM records captured from a working session were FIRST-PERSON ACTION NARRATION,
  // not facts: "I'll search for recent high-impact hydrogen sensor papers.",
  // "I'm hitting a couple of blockers. Let me try alternative sources.",
  // "E-utilities works. Let me fetch summaries...", "Found strong hits. Let me pull...",
  // "PyMuPDF is available. Let me extract the text." These are the agent narrating what it
  // is doing mid-turn — diary entries, not knowledge. The Chinese patterns above never
  // caught them because they never occur in Chinese. High-precision only: each pattern
  // targets an unmistakable first-person / "Let me <verb>" tell, so a factual English
  // sentence ("Adv. Mater. 2024 reports a 3.8 MB supplement.") is NOT rejected.
  /^\s*I['’](ll|m|ve|d)\b/i, // I'll … / I'm … / I've … / I'd …
  /^\s*I\s+(will|can|need|should|am)\b/i, // I will … / I need … / I am …
  /\bLet me\s+\w+/i, // Let me fetch / Let me read / Let me try …
  /^\s*(Found|Searching|Looking|Reading|Fetching|Extracting|Querying|Checking|Running|Loading|Trying|Pulling|Getting|Opening)\b/i, // bare action verb at start
  /^\s*(The\s+\w+\s+is|This\s+is)\b[^.]{0,60}?\bLet me\b/i, // "The PDF is X. Let me read it."
]);

/** Default LTM ceilings. */
export const DEFAULT_LTM_MAX_NODES = 500;
export const DEFAULT_LTM_MAX_TOKENS = 200_000;

/**
 * Does this text read like a standing instruction?
 * @param {string} text - node title + body.
 * @returns {boolean} true when it carries a long-term marker.
 */
export function isStandingInstruction(text) {
  const value = String(text ?? "");
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Does this text read like process chatter (a diary entry) rather than knowledge?
 * @param {string} text - node title + body.
 * @returns {boolean} true when it carries a process marker and should NOT be promoted.
 */
export function isProcessChatter(text) {
  const value = String(text ?? "");
  return PROCESS_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Pick the nodes that may leave the session tree.
 *
 * @param {object[]} nodes - consolidated session nodes.
 * @param {object} [options] - tuning.
 * @param {number} [options.minWeight] - weight a `decision` needs.
 * @param {number} [options.max] - cap on returned candidates.
 * @returns {object[]} promotable nodes, in their original order.
 */
export function selectPromotable(nodes, options = {}) {
  const minWeight = Number.isFinite(options.minWeight) ? options.minWeight : DEFAULT_MIN_WEIGHT;
  const max = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;

  const picked = [];
  for (const node of nodes ?? []) {
    if (picked.length >= max) break;
    if (node === null || typeof node !== "object") continue;
    // Archived nodes were retired for a reason; a consolidation pass that retired a
    // node must not have its decision undone by promoting it anyway.
    if (node.archived === true) continue;
    if (!PROMOTE_KINDS.includes(node.kind)) continue;
    const text = `${node.title ?? ""}\n${node.body ?? ""}`;
    if (text.trim().length === 0) continue;

    if (node.kind === "task") {
      // Weight is constant for tasks, so it can only be an instruction filter.
      if (!isStandingInstruction(text)) continue;
      picked.push(node);
      continue;
    }
    // A decision must clear the weight floor AND not read like process chatter:
    // "关键证据在 index.js 14–15 行" / "好了，先看实测状态" are diary entries, not facts.
    if (!(Number(node.weight ?? 0) >= minWeight)) continue;
    if (isProcessChatter(text)) continue;
    picked.push(node);
  }
  return picked;
}

/**
 * Stable long-term id for a node's content.
 *
 * @param {object} node - memory node.
 * @returns {string} `ltm-<16 hex>`.
 */
export function ltmId(node) {
  const digest = createHash("sha256").update(dedupKey(node)).digest("hex").slice(0, 16);
  const id = `ltm-${digest}`;
  // `validateNode` enforces ID_PATTERN; hashing can never produce anything else, but
  // the check is cheap and this id is the record's primary key.
  if (!ID_PATTERN.test(id)) throw new Error(`promote: bad ltm id ${JSON.stringify(id)}`);
  return id;
}

/**
 * Turn a session node into a long-term record.
 *
 * `sources` is append-only: every promotion adds one entry, and nothing rewrites the
 * older ones. That is the only defence against the "model wrote its own mistake into
 * memory" failure — you can always ask a record where it came from.
 *
 * @param {object} node - promotable session node.
 * @param {object} meta - provenance.
 * @param {string} meta.sessionId - owning session.
 * @param {number} [meta.turn] - turn the material belonged to.
 * @param {string} [meta.work] - v8 work key (`work:<name>`); grouping edge, no date.
 * @param {[number, number]} [meta.seqRange] - event range in that session.
 * @param {number} [meta.promotedAt] - wall clock of the promotion.
 * @returns {object} long-term record.
 */
export function toLtmRecord(node, meta = {}) {
  const turn = Number.isFinite(meta.turn) ? meta.turn : typeof node?.born === "number" ? node.born : 0;
  const source = {
    sessionId: typeof meta.sessionId === "string" ? meta.sessionId : "unknown",
    turn,
    ...(Array.isArray(meta.seqRange) && meta.seqRange.length === 2 ? { seqRange: [...meta.seqRange] } : {}),
    promotedAt: Number.isFinite(meta.promotedAt) ? meta.promotedAt : 0,
  };
  // A subject is the "what is this about" key that lets two *different values* of the
  // same fact be related. The hash alone cannot do it: two values differ in text, so
  // they get two ids and both match the same keyword query. Normalised here so
  // `Config.RetainTokens` and `config.retaintokens ` are the same key.
  const subject =
    typeof meta.subject === "string" ? meta.subject.trim().toLowerCase() || null : null;
  // v8: the work key groups "several facts about the same piece of work". It is a
  // grouping edge only — not a ranking signal — and it carries NO date (see work.js):
  // the same work on any day / session must share one key. null ⇒ fall back to the old
  // subject/session family, i.e. pre-v8 behaviour.
  const work = typeof meta.work === "string" ? meta.work.trim() || null : null;
  return {
    id: ltmId(node),
    // LTM hits render into the recall zone (plan D12), never into volatile.
    zone: "recall",
    kind: node.kind,
    parentId: null,
    order: 0,
    // v8: `work` is the grouping edge; `pivotId` is set by the promote-runner when this
    // record is attached to a work pivot (lazy). Both default off so pre-v8 callers and
    // records are unaffected.
    work,
    pivotId: null,
    title: String(node.title ?? ""),
    body: String(node.body ?? ""),
    weight: Number.isFinite(node.weight) ? node.weight : 1,
    pinned: node.kind === "task",
    rev: 1,
    born: turn,
    archived: false,
    firstSeenTurn: turn,
    // NOT used for ranking in v3 (promote plan §8: an echoed mistake would raise its
    // own weight). Recorded so a later version can rank on it once a correction signal
    // exists.
    hits: 1,
    sources: [source],
    // Phase A: the supersede triple. Defaults keep the pre-existing behaviour — a
    // record with no subject can never supersede or be superseded.
    subject,
    supersedes: Array.isArray(meta.supersedes) ? [...meta.supersedes] : [],
    supersededAt: Number.isFinite(meta.supersededAt) ? meta.supersededAt : null,
    // `frozen` outranks eviction the same way `pinned` does, but it is a human
    // decision ("this must stay correct even if unused for a year"), so it is never
    // derived from content.
    frozen: meta.frozen === true,
  };
}

/**
 * May this record appear in a search result?
 *
 * Three separate retirements exist (promote-plan §6.1) and every one of them must be
 * filtered here, because `mergeLtm` only *marks* records — it never removes them from
 * the store. Skipping this check would silently cancel out both eviction and
 * superseding: the store would look correct while the recall index kept serving
 * retired values.
 *
 * @param {object} record - LTM record.
 * @returns {boolean} true when the record may be searched.
 */
export function isSearchable(record) {
  if (!record) return false;
  if (record.archived === true) return false;
  if (record.forgottenAt != null) return false;
  if (record.supersededAt != null) return false;
  return true;
}

/**
 * Retire a record to a tombstone: clear the body, keep the shell.
 *
 * This is a *reversible* retirement, not a deletion. What survives — `id`, `title`,
 * `subject`, `supersedes`, `sources` — is exactly what a human needs to answer "where
 * did this come from, and what did it replace". The body is the only part that costs
 * real tokens (measured: title is 30% of a node, body 70%), so clearing it is where
 * the saving is.
 *
 * @param {object} record - LTM record.
 * @param {object} [options] - retirement options.
 * @param {number} [options.now] - turn or timestamp to stamp; must be supplied by the
 *   caller so the same input stays reproducible.
 * @returns {object} tombstoned record.
 */
export function tombstone(record, options = {}) {
  if (!record) return record;
  const now = Number.isFinite(options.now) ? options.now : 0;
  return {
    ...record,
    body: "",
    supersededAt: Number.isFinite(record.supersededAt) ? record.supersededAt : now,
  };
}

/**
 * Is this incoming record merely a *re-sighting* of a source the store already recorded?
 *
 * The same session node is re-promoted on every `agent/pre-step` — two or three times per
 * turn, and again on every later turn that still carries it in the fold tree. Without this
 * guard each re-seen fact appended another `source`, incremented `hits`/`rev`, and re-read
 * a huge `sources` array every fold: measured live, one record reached 55 duplicate
 * sources (all the same session, same turn, milliseconds apart), which is pure churn and
 * inflates the store for no signal.
 *
 * A source is "the same sighting" only when BOTH the session and the turn are known
 * numbers and both match one already recorded. A repeat from a *different* turn or a
 * *different* session is a genuine new sighting and still counts (a fact repeated
 * elsewhere is stronger — that intent stands). When the turn is unknown (`undefined`),
 * we do NOT dedup: an absent turn cannot prove two sightings are the same moment, and
 * collapsing them would silently drop provenance a caller deliberately re-supplied.
 *
 * @param {object} previous - the record currently in the store.
 * @param {object} incoming - the freshly built record.
 * @returns {boolean} true when the incoming record adds no new sighting.
 */
export function isSameSource(previous, incoming) {
  const prevSources = Array.isArray(previous?.sources) ? previous.sources : [];
  const nextSources = Array.isArray(incoming?.sources) ? incoming.sources : [];
  if (nextSources.length === 0) return false;
  return nextSources.every(
    (candidate) =>
      Number.isFinite(candidate?.turn) &&
      prevSources.some(
        (seen) => seen?.sessionId === candidate?.sessionId && seen?.turn === candidate?.turn,
      ),
  );
}

/**
 * Merge incoming records into the store and evict down to budget.
 *
 * Re-promoting the same content keeps one record, takes the larger weight, the earlier
 * birth, appends the new source and increments `hits`. A re-sighting from the *same*
 * (session, turn) — which happens several times per turn — is de-duplicated and does NOT
 * append another source nor bump `hits`/`rev` (see {@link isSameSource}).
 *
 * Eviction is archival, ordered by (weight, born, id) so the same store always evicts
 * the same records. Pinned and frozen records are never evicted: a standing
 * instruction or a human "keep this correct" is removed by the user, not by an
 * algorithm that cannot read it.
 *
 * @param {object[]} existing - current store.
 * @param {object[]} incoming - records from `toLtmRecord`.
 * @param {object} [options] - budgets.
 * @param {number} [options.maxNodes] - node ceiling.
 * @param {number} [options.maxTokens] - token ceiling.
 * @param {number} [options.now] - stamped on newly superseded records; pass it so the
 *   same input produces the same output.
 * @param {boolean} [options.tombstone] - clear the body of every superseded record.
 *   Off by default: silently discarding text must be opt-in.
 * @returns {{records: object[], stats: {added: number, updated: number, superseded: number, evicted: number, kept: number}}} result.
 */
export function mergeLtm(existing, incoming, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_LTM_MAX_NODES;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_LTM_MAX_TOKENS;

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const record of existing ?? []) {
    if (record?.id) byId.set(record.id, record);
  }

  let added = 0;
  let updated = 0;
  for (const record of incoming ?? []) {
    if (!record?.id) continue;
    const previous = byId.get(record.id);
    if (previous === undefined) {
      byId.set(record.id, record);
      added += 1;
      continue;
    }
    // Same (session, turn) as a sighting we already recorded: this is the per-step
    // re-promotion of an unchanged node. Leave the stored record untouched — no extra
    // source, no hits/rev bump — or the sources array grows every step (measured: 55
    // duplicate entries for one fact in a single turn).
    if (isSameSource(previous, record)) {
      continue;
    }
    byId.set(record.id, {
      ...previous,
      // Keep the strongest importance seen and the earliest birth: a fact repeated
      // across sessions is at least as important as its strongest mention, and it is
      // older than any single sighting suggests.
      weight: Math.max(previous.weight ?? 0, record.weight ?? 0),
      born: Math.min(previous.born ?? record.born ?? 0, record.born ?? previous.born ?? 0),
      firstSeenTurn: Math.min(
        previous.firstSeenTurn ?? previous.born ?? 0,
        record.firstSeenTurn ?? record.born ?? 0,
      ),
      sources: [...(previous.sources ?? []), ...(record.sources ?? [])],
      hits: (previous.hits ?? 1) + (record.hits ?? 1),
      rev: (previous.rev ?? 1) + 1,
      archived: false,
      // v8: `work`/`pivotId` are structural fields, not accumulated counters. Adopt the
      // incoming value when it supplies one (a pre-v8 record that gains a work key on a
      // later pass must pick it up), otherwise keep what we had. Pivot linkage is set by
      // applyWorkPivots after merge, so we only ever fill in from `record` here.
      work: record.work ?? previous.work ?? null,
      pivotId: record.pivotId ?? previous.pivotId ?? null,
    });
    updated += 1;
  }

  // --- Supersede pass.
  //
  // A live record with the same non-null `subject` is outdated the moment a new one
  // for that subject arrives. We do NOT delete it: the old value is the only evidence
  // that the new one is correct, and deleting it is what turns `hits` accumulation
  // into an echo chamber (promote-plan §8 risk 4). The record is marked here; clearing
  // its body is a separate, opt-in step (`tombstone`).
  //
  // `superseded` only counts *newly* marked records, so re-running the same merge is
  // idempotent.
  const now = Number.isFinite(options.now) ? options.now : 0;
  let superseded = 0;
  for (const record of incoming ?? []) {
    if (!record?.subject) continue;
    const winner = byId.get(record.id);
    if (!winner) continue;
    for (const [id, existing] of byId) {
      if (id === winner.id) continue;
      if (existing?.subject !== record.subject) continue;
      // A human said "keep this correct"; that outranks a newer value. The conflict is
      // left visible rather than resolved by an algorithm that cannot judge it.
      if (existing.frozen === true) continue;
      if (existing.supersededAt != null) continue;
      byId.set(id, { ...existing, supersededAt: now });
      const next = byId.get(winner.id);
      byId.set(winner.id, {
        ...next,
        supersedes: [...new Set([...(next.supersedes ?? []), id])],
      });
      if (options.tombstone === true) byId.set(id, tombstone(byId.get(id), { now }));
      superseded += 1;
    }
  }

  /** A superseded record is an audit trail, not knowledge: it must not eat the budget. */
  const isTombstoned = (record) => record.supersededAt != null;

  const live = [...byId.values()].filter((record) => record.archived !== true && !isTombstoned(record));
  const tokens = () => live.reduce((sum, record) => sum + priceString(`${record.title ?? ""}: ${record.body ?? ""}`), 0);

  let evicted = 0;
  const evictable = () =>
    live
      .filter((record) => record.pinned !== true && record.frozen !== true)
      .sort((left, right) => {
        // Written out rather than chained with `||`: `a - b || c - d || x < y ? -1 : 1`
        // parses as `(a-b || c-d || x<y) ? -1 : 1`, which makes the comparator return
        // -1 for every pair whose weights differ — a sort that looks plausible and
        // evicts the wrong record.
        const byWeight = (left.weight ?? 0) - (right.weight ?? 0);
        if (byWeight !== 0) return byWeight;
        const byBirth = (left.born ?? 0) - (right.born ?? 0);
        if (byBirth !== 0) return byBirth;
        return String(left.id) < String(right.id) ? -1 : 1;
      });

  while (live.length > maxNodes || tokens() > maxTokens) {
    const victim = evictable()[0];
    if (victim === undefined) break; // everything left is pinned; over budget on purpose
    victim.archived = true;
    live.splice(live.indexOf(victim), 1);
    evicted += 1;
  }

  const records = [...byId.values()];
  return { records, stats: { added, updated, superseded, evicted, kept: live.length } };
}

/** Stable id for a work pivot. Content-independent: one pivot per work key. */
export function pivotIdFor(work) {
  const digest = createHash("sha256").update(`work-pivot:${work}`).digest("hex").slice(0, 16);
  const id = `ltm-${digest}`;
  if (!ID_PATTERN.test(id)) throw new Error(`promote: bad pivot id ${JSON.stringify(id)}`);
  return id;
}

/**
 * v8 lazy work pivots: give each work with ≥2 live records one pivot node, and point its
 * records at it via `parentId` + `pivotId`.
 *
 * Why lazy (not one pivot per work up front): a pivot that only ever has a single child
 * is a lone parent — it costs budget and adds nothing to expand. We only materialise a
 * pivot once a work actually has ≥2 live records, at which point grouping is meaningful.
 *
 * Why a pivot is a *record*, not a side table: everything that reads LTM already handles
 * records (recall, fetch, diff). A `kind: "work-summary"` record with a stable id rides
 * on all of that for free, and `selectPromotable` never emits that kind, so it cannot
 * feed back into itself.
 *
 * Budget: pivots cost tokens like any record. After attaching we do one conservative
 * eviction pass so adding pivots cannot push the store past its ceiling — but a pivot is
 * never *itself* the first victim while it still groups ≥2 live children; the leaves are
 * evicted first (weight/born order), matching mergeLtm's ordering.
 *
 * Idempotent: re-running on the same records regenerates the same pivot ids and the same
 * parentId/pivotId assignments, so diffForWrite sees no change on the second run.
 *
 * @param {object[]} records - merged store (from mergeLtm), may be mutated copies.
 * @param {object} [options] - budget + stamp.
 * @param {number} [options.maxNodes] - node ceiling.
 * @param {number} [options.maxTokens] - token ceiling.
 * @param {number} [options.now] - stamp for a freshly created pivot's born/promotedAt.
 * @returns {{records: object[], stats: {pivotsCreated: number, pivotsLinked: number, pivotsRevived: number, evicted: number}}} result.
 */
export function applyWorkPivots(records, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_LTM_MAX_NODES;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_LTM_MAX_TOKENS;
  const now = Number.isFinite(options.now) ? options.now : 0;

  const byId = new Map();
  for (const record of records ?? []) {
    if (record?.id) byId.set(record.id, record);
  }

  const isLive = (record) =>
    record && record.archived !== true && record.supersededAt == null && record.kind !== "work-summary";

  // Group live records by work key.
  /** @type {Map<string, object[]>} */
  const byWork = new Map();
  for (const record of byId.values()) {
    if (!isLive(record)) continue;
    if (typeof record.work !== "string" || record.work === "") continue;
    let list = byWork.get(record.work);
    if (!list) byWork.set(record.work, (list = []));
    list.push(record);
  }

  let pivotsCreated = 0;
  let pivotsLinked = 0;
  let pivotsRevived = 0;
  for (const [work, members] of byWork) {
    if (members.length < 2) continue; // lazy: no pivot for a lone record
    const pid = pivotIdFor(work);
    let pivot = byId.get(pid);
    // v10-fix: a group that still has ≥2 live members deserves a live pivot. If a prior
    // budget pass archived this pivot (eviction) the store may later fall back under
    // budget while the members stay — and because the pivot id is content-independent,
    // the old code kept re-linking members onto the archived pivot forever, hiding the
    // whole group from the panel/recall while its data sat orphaned. A pivot for a group
    // that provably has ≥2 live members must be live; revive it. (This only un-archives a
    // pivot whose *members* are alive — a pivot whose group dissolved below 2 never reaches
    // here, and if re-adding pushes the store over budget the eviction pass below re-archives
    // the lowest-weight leaf/pivot, so this cannot cause an unbounded budget breach.)
    if (pivot && pivot.archived === true) {
      pivot = { ...pivot, archived: false };
      byId.set(pid, pivot);
      pivotsRevived += 1;
    }
    if (!pivot) {
      const first = members[0];
      pivot = {
        id: pid,
        zone: "recall",
        kind: "work-summary",
        parentId: null,
        order: 0,
        work,
        pivotId: pid,
        title: `工作：${work.replace(/^work:/, "")}`,
        // Placeholder outline of the work's contents; a later (model) pass may replace
        // it with a real summary. NOT model-generated in v8-a.
        body: members
          .map((r) => String(r.title ?? "").trim())
          .filter((t) => t !== "")
          .slice(0, 12)
          .join("；"),
        weight: Math.max(...members.map((r) => (Number.isFinite(r.weight) ? r.weight : 0)), 0),
        // Pivots are not pinned: an unused work should be able to age out with its leaves.
        pinned: false,
        rev: 1,
        born: Number.isFinite(first?.born) ? first.born : now,
        archived: false,
        firstSeenTurn: Number.isFinite(first?.firstSeenTurn) ? first.firstSeenTurn : now,
        hits: 1,
        // Provenance: a pivot is derived, so it points at the work key, not a session.
        sources: [{ sessionId: "work-pivot", turn: now, promotedAt: now }],
        subject: null,
        supersedes: [],
        supersededAt: null,
        frozen: false,
      };
      byId.set(pid, pivot);
      pivotsCreated += 1;
    }
    // Point every live member at the pivot.
    for (const member of members) {
      if (member.parentId !== pid || member.pivotId !== pid) {
        byId.set(member.id, { ...member, parentId: pid, pivotId: pid });
        pivotsLinked += 1;
      }
    }
  }

  // --- Conservative budget pass: if adding pivots pushed us over, evict leaves first,
  // and prefer a pivot over evicting its last remaining child while it still groups ≥2.
  let evicted = 0;
  const liveAll = () =>
    [...byId.values()].filter(
      (r) => r.archived !== true && r.supersededAt == null,
    );
  const tokenSum = (list) =>
    list.reduce((sum, r) => sum + priceString(`${r.title ?? ""}: ${r.body ?? ""}`), 0);

  const evictOrder = (list) =>
    list
      .filter((r) => r.pinned !== true && r.frozen !== true)
      .sort((left, right) => {
        // Evict ordinary (non-pivot) leaves before pivots of equal weight.
        const leftPivot = left.kind === "work-summary" ? 1 : 0;
        const rightPivot = right.kind === "work-summary" ? 1 : 0;
        if (leftPivot !== rightPivot) return leftPivot - rightPivot;
        const byWeight = (left.weight ?? 0) - (right.weight ?? 0);
        if (byWeight !== 0) return byWeight;
        const byBirth = (left.born ?? 0) - (right.born ?? 0);
        if (byBirth !== 0) return byBirth;
        return String(left.id) < String(right.id) ? -1 : 1;
      });

  while (liveAll().length > maxNodes || tokenSum(liveAll()) > maxTokens) {
    const victim = evictOrder(liveAll())[0];
    if (victim === undefined) break; // everything left is pinned; over budget on purpose
    byId.set(victim.id, { ...victim, archived: true });
    evicted += 1;
  }

  return { records: [...byId.values()], stats: { pivotsCreated, pivotsLinked, pivotsRevived, evicted } };
}

/**
 * v8-b: fold refined work names back into the store.
 *
 * The background refinement (work-name.js + index.js) maps each temporary work key
 * (`work:session-xxx`) to a human name (`work:<name>`), and — crucially — maps two
 * different temporary keys to the SAME name when they are the same piece of work. This
 * function applies that mapping:
 *
 *   1. rewrite every non-pivot record whose `work` is a key in the mapping to
 *      `work:<name>` (this is the merge: two temp keys sharing a name collapse to one
 *      work family);
 *   2. retire (archive) the pivots of the old work keys — their grouping is now wrong;
 *   3. rebuild pivots for the new work keys via {@link applyWorkPivots}.
 *
 * Records with a work key NOT in the mapping are left untouched (a partial model answer
 * just refines fewer groups). Records with no work are untouched. Idempotent: applying
 * the same mapping twice produces the same store (the second pass finds nothing to
 * rewrite and the pivots already exist).
 *
 * @param {object[]} records - current store.
 * @param {Map<string,string>|object} mapping - old work key (e.g. `work:session-x`) →
 *   refined name (e.g. `LTM 组织性改造`).
 * @param {object} [options] - budget + stamp.
 * @param {number} [options.maxNodes] - node ceiling (re-applied after rebuild).
 * @param {number} [options.maxTokens] - token ceiling.
 * @param {number} [options.now] - stamp for new pivots.
 * @returns {{records: object[], stats: {renamed: number, pivotsRetired: number, pivotsCreated: number}}} result.
 */
export function applyWorkNames(records, mapping, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_LTM_MAX_NODES;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_LTM_MAX_TOKENS;
  const now = Number.isFinite(options.now) ? options.now : 0;

  // Normalise the mapping to Map<oldKey, newWorkKey> with `work:` prefix + lowercase body
  // matching work.js's key format.
  const toNewWork = new Map();
  const entries = mapping instanceof Map ? [...mapping.entries()] : Object.entries(mapping ?? {});
  for (const [oldKey, name] of entries) {
    const body = normaliseWorkBody(name);
    if (typeof oldKey === "string" && oldKey !== "" && body !== "") {
      toNewWork.set(oldKey, `work:${body}`);
    }
  }
  if (toNewWork.size === 0) {
    return { records: [...(records ?? [])], stats: { renamed: 0, pivotsRetired: 0, pivotsCreated: 0 } };
  }

  const byId = new Map();
  for (const record of records ?? []) {
    if (record?.id) byId.set(record.id, record);
  }

  const oldKeys = new Set(toNewWork.keys());
  let renamed = 0;
  let pivotsRetired = 0;

  // 1 & 2: rewrite member work keys, archive pivots of the old keys.
  for (const record of [...byId.values()]) {
    if (record.kind === "work-summary") {
      // A pivot belonging to a work key we are renaming is now stale — archive it.
      if (typeof record.work === "string" && oldKeys.has(record.work) && record.archived !== true) {
        byId.set(record.id, { ...record, archived: true });
        pivotsRetired += 1;
      }
      continue;
    }
    const newWork = record.work != null ? toNewWork.get(record.work) : undefined;
    if (newWork === undefined) continue;
    if (record.work !== newWork) {
      // Detach from the stale pivot; applyWorkPivots will re-link under the new one.
      byId.set(record.id, { ...record, work: newWork, parentId: null, pivotId: null });
      renamed += 1;
    }
  }

  // 3: rebuild pivots for the (now merged) work keys.
  const rebuilt = applyWorkPivots([...byId.values()], { maxNodes, maxTokens, now });
  return {
    records: rebuilt.records,
    stats: {
      renamed,
      pivotsRetired,
      pivotsCreated: rebuilt.stats.pivotsCreated,
    },
  };
}

/**
 * Normalise a refined work name into the key body (mirrors work.js normaliseWorkName for * the fields that matter here: trim, collapse space, lowercase ASCII, strip edge junk).
 * @param {unknown} raw - refined name.
 * @returns {string} body suitable for `work:<body>`.
 */
function normaliseWorkBody(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .slice(0, 48);
}

/**
 * v8-c-1: write model-generated summaries onto work pivots.
 *
 * `summaries` is a Map (or plain object) of workKey → summary text. For each live,
 * non-archived `work-summary` pivot whose `work` has a usable summary, replace its
 * `body` and bump `rev`. Unchanged / missing / empty summaries leave the pivot as-is
 * (a failed model pass simply keeps the mechanical body applyWorkPivots built).
 * Pure: returns a new records array; never mutates input.
 *
 * @param {object[]} records
 * @param {Map<string,string>|Record<string,string>} summaries
 * @returns {{records: object[], stats: {updated: number}}}
 */
export function applyWorkSummaries(records, summaries) {
  const entries =
    summaries instanceof Map ? [...summaries.entries()] : Object.entries(summaries ?? {});
  const byWork = new Map();
  for (const [work, text] of entries) {
    const body = String(text ?? "").trim();
    if (typeof work === "string" && work !== "" && body !== "") byWork.set(work, body);
  }
  if (byWork.size === 0) return { records: [...(records ?? [])], stats: { updated: 0 } };

  let updated = 0;
  const out = (records ?? []).map((record) => {
    if (
      record &&
      record.kind === "work-summary" &&
      record.archived !== true &&
      typeof record.work === "string" &&
      byWork.has(record.work)
    ) {
      const nextBody = byWork.get(record.work);
      if (record.body === nextBody) return record;
      updated += 1;
      return { ...record, body: nextBody, rev: (Number(record.rev) || 1) + 1 };
    }
    return record;
  });
  return { records: out, stats: { updated } };
}

/**
 * v10: split an over-merged work into sub-groups carrying their own work keys.
 *
 * The inverse of {@link applyWorkNames}. Given ONE source work and a partition of its live
 * members into sub-groups (each with a name), this:
 *
 *   1. moves every listed member to `work:<subName>` (detach from the old pivot);
 *   2. retires (archives) the source work's pivot — it no longer describes one group;
 *   3. rebuilds pivots via {@link applyWorkPivots} for whatever works now have ≥2 members.
 *
 * A sub-group whose name normalises back to the source work's own body is a no-op (the
 * member is already there) — this is how "keep this batch, split only the rest" works: the
 * model gives the untouched members the original work name and they stay put.
 *
 * Members NOT named in the partition are left on the source work untouched (a partial
 * answer splits fewer members — safe, never loses a member). Names that collide with an
 * existing work merge into it (same semantics as applyWorkNames). Idempotent: applying the
 * same partition twice rewrites nothing the second time.
 *
 * @param {object[]} records - current store.
 * @param {string} sourceWork - the work key being split (e.g. `work:acs`).
 * @param {Array<{name: string, memberIds: number[]}>} groups - sub-groups; `memberIds`
 *   index into the source work's LIVE member list in store order (the same order the split
 *   prompt enumerated as m0, m1, …). Assembly of that ordering is the caller's job.
 * @param {object} [options] - budget + stamp.
 * @param {number} [options.maxNodes]
 * @param {number} [options.maxTokens]
 * @param {number} [options.now]
 * @returns {{records: object[], stats: {moved: number, pivotsRetired: number, pivotsCreated: number}}}
 */
export function applyWorkSplit(records, sourceWork, groups, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_LTM_MAX_NODES;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_LTM_MAX_TOKENS;
  const now = Number.isFinite(options.now) ? options.now : 0;

  const byId = new Map();
  for (const record of records ?? []) {
    if (record?.id) byId.set(record.id, record);
  }

  const srcBody = normaliseWorkBody(String(sourceWork ?? "").replace(/^work:/, ""));
  if (srcBody === "") {
    return { records: [...(records ?? [])], stats: { moved: 0, pivotsRetired: 0, pivotsCreated: 0 } };
  }

  // The live, non-pivot members of the source work, in store order — the ordering the
  // caller used to enumerate m0..mN when building the prompt.
  const members = [...byId.values()].filter(
    (r) =>
      r &&
      r.kind !== "work-summary" &&
      r.archived !== true &&
      r.supersededAt == null &&
      r.work === sourceWork,
  );

  // Map member index → target work key. A name that normalises to the source body targets
  // the source work itself (i.e. "leave here"), so we only rewrite members that really move.
  const indexToWork = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    const body = normaliseWorkBody(g?.name);
    if (body === "") continue;
    const target = `work:${body}`;
    for (const idx of Array.isArray(g?.memberIds) ? g.memberIds : []) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= members.length) continue;
      if (!indexToWork.has(idx)) indexToWork.set(idx, target);
    }
  }

  let moved = 0;
  for (const [idx, target] of indexToWork) {
    if (target === sourceWork) continue; // keep-in-place partition
    const member = members[idx];
    if (!member) continue;
    if (member.work === target) continue;
    byId.set(member.id, { ...member, work: target, parentId: null, pivotId: null });
    moved += 1;
  }

  // Retire the source work's pivot if its grouping no longer holds (we moved at least one
  // member away, so the old summary is stale).
  let pivotsRetired = 0;
  const srcPivotId = pivotIdFor(sourceWork);
  const srcPivot = byId.get(srcPivotId);
  if (srcPivot && srcPivot.archived !== true && moved > 0) {
    byId.set(srcPivotId, { ...srcPivot, archived: true });
    pivotsRetired += 1;
  }

  const rebuilt = applyWorkPivots([...byId.values()], { maxNodes, maxTokens, now });

  // Guard against a "phantom retire": if we retired the source pivot because members moved
  // away, but the rebuild left the source work's members with NO live pivot (e.g. every
  // "moved" target failed to materialise, or the remaining in-place members dropped below
  // the ≥2 threshold), the old grouping is still the best structure we have. Un-archive it
  // so the work never ends up hidden with orphaned, un-pivoted members.
  if (pivotsRetired > 0) {
    const rebuiltById = new Map();
    for (const record of rebuilt.records) {
      if (record?.id) rebuiltById.set(record.id, record);
    }
    // How many members still live under the source work after the split?
    const srcRemaining = rebuilt.records.filter(
      (r) =>
        r &&
        r.kind !== "work-summary" &&
        r.archived !== true &&
        r.supersededAt == null &&
        r.work === sourceWork,
    ).length;
    const srcHasLivePivot = (() => {
      const rp = rebuiltById.get(srcPivotId);
      return rp && rp.archived !== true;
    })();
    // Only restore the old pivot when the source work KEEPS members (≥2, so a pivot is
    // warranted) yet the rebuild failed to give it a live pivot. If the source work was
    // emptied (or dropped below 2), retiring its pivot is the correct outcome — leave it.
    if (srcRemaining >= 2 && !srcHasLivePivot) {
      const rp = rebuiltById.get(srcPivotId);
      if (rp) {
        rebuilt.records = rebuilt.records.map((r) =>
          r.id === srcPivotId ? { ...r, archived: false } : r,
        );
        pivotsRetired = 0; // net effect: nothing retired
      }
    }
  }

  return {
    records: rebuilt.records,
    stats: { moved, pivotsRetired, pivotsCreated: rebuilt.stats.pivotsCreated },
  };
}
