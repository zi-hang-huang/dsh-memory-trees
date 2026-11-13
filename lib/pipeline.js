/**
 * Fold and self pipelines, independent of the Cordis plugin surface.
 *
 * Split out of `index.js` so the two operations that mutate a session can be tested
 * against a fake session without the harness installed: `index.js` needs
 * schemastery and `dsh-tools` at import time, and dragging those in would make the
 * append contract untestable outside a running profile. The split is not
 * cosmetic — the append sequence is the part the session layer accepts or rejects
 * wholesale, so it is the part that most needs a test.
 *
 * One rule for everything here: the tree lives in the log (`message.source.nodes`).
 * A checkpoint carries its own nodes; a resume or fork recovers memory by reading
 * the surface back. That makes "write memory before replacing context" (plan D5)
 * structurally unviolatable, because the write and the replace are one event.
 */

import { randomUUID } from "node:crypto";

import { makeKindFilter } from "./admit.js";
import { distillTurn, segmentAnchor } from "./distill.js";
import { distillWithLlm, shouldUseLlm } from "./distill-llm.js";
import { applyNewestBarrierPolicy, describeNode, planFold, runIsClosed, FOLD_SKIP } from "./fold.js";
import { priceMessage, priceString } from "./pricing.js";
import { defaultSelfNodes, findSelfInSurface, selfContent, selfSource, surfaceSeq } from "./self.js";
import { readSelfOverride } from "./self-store.js";
import { VOLATILE_BUDGET, mergeNodes, renderZoneTree, trimToBudget } from "./tree.js";

/** `source.kind` of the checkpoint message. Distinct from `memory:self`. */
export const MEMORY_SOURCE_KIND = "memory";

/**
 * Fresh counters for the `memory_stats` tool.
 *
 * In-process only by design: the durable record is the append sequence itself,
 * which is what a resumed session is rebuilt from. Counters exist to answer "is
 * this doing anything" without reading a log.
 * @returns {object} counters.
 */
export function createStats() {
  return {
    folds: 0,
    skipped: /** @type {Record<string, number>} */ ({}),
    shadowedTokens: 0,
    selfPublished: 0,
    selfReplaced: 0,
    droppedNodes: 0,
    oversized: 0,
    // v2 counters. `llmRequested` counts folds that met the span threshold; the
    // difference between it and `llmUsed` is the fallback rate, which is the number
    // that matters — a silent fallback every time is indistinguishable from "v2 was
    // never enabled" unless it is counted.
    llmRequested: 0,
    llmUsed: 0,
    llmFailed: 0,
    llmRejected: 0,
    // Session-log recall counters. `recallPublished` counts steps where a block was
    // injected; `recallEvents` sums the events it showed. Both staying 0 while
    // `sessionRecallEnabled` is true means the backend is absent or the query never
    // matched — the two failure modes worth being able to tell apart.
    recallPublished: 0,
    recallEvents: 0,
    // `recallAttempts` counts steps where recall actually ran a search (config on, a
    // human query was found, and a backend was present). `recallEmpty` counts the subset
    // that then found nothing. Without these, a fundamentally broken match — which is
    // exactly what shipped in v5: attempts happened, every one returned zero — is
    // indistinguishable from recall never being switched on. The two counters make
    // "ran but matched nothing" visible instead of silent.
    recallAttempts: 0,
    recallEmpty: 0,
  };
}

/**
 * Resolve the per-agent dependency set once, so a step does not rebuild the
 * allowlist and barrier set per call.
 * @param {object} config - resolved plugin config.
 * @returns {{admit: Function, barriers: Set<string>}} filters.
 */
export function createFilters(config) {
  return { admit: makeKindFilter(config.admitKinds), barriers: new Set(config.barrierKinds) };
}

// -----------------------------------------------------------------------------
// Self tree
// -----------------------------------------------------------------------------

/**
 * Read the self tree currently visible in a surface.
 *
 * Called *before* the fold, because the fold may legitimately remove the message:
 * carrying the nodes here is what makes removing it safe. Reading after the fold
 * would silently fall back to the defaults and lose anything the human had
 * confirmed, which is exactly the persona-loss failure mode P9 exists to prevent.
 *
 * @param {object} agent - the agent owning this step.
 * @returns {object[]|null} nodes, or null when no copy is visible.
 */
export function captureSelfNodes(agent) {
  const session = agent.session;
  const nodes = session.surface?.nodes ?? [];
  const existing = findSelfInSurface(nodes, (seq) => messageAt(session, seq));
  return existing === null ? null : readSelfNodes(existing.message);
}

/**
 * The most recent human message's text on the current surface, for a recall query.
 *
 * Reads backwards from the tail and stops at the first `user/message` whose source kind
 * is a memory-admitted kind. Framework injections (`skill-catalog`, `agent-instructions`,
 * `memory`, `memory:self`) sit on the surface too and must not become the query — asking
 * the log to search for a skill catalogue would return noise. Returns `""` when there is
 * no human text yet (turn 1 before the prompt is up), which callers treat as "don't recall".
 *
 * @param {object} agent - the agent owning this step.
 * @param {Set<string>} [admit] - which source kinds count as human input.
 * @returns {string} the latest user text, or `""`.
 */
export function currentUserText(agent, admit) {
  const session = agent?.session;
  const surface = session?.surface?.nodes ?? [];
  const kinds = admit ?? new Set(["user", "agent-message", "goal"]);
  for (let index = surface.length - 1; index >= 0; index -= 1) {
    const seq = surface[index];
    if (session.eventAt?.(seq)?.type !== "user/message") continue;
    const message = messageAt(session, seq);
    if (!message) continue;
    if (!kinds.has(message?.source?.kind)) continue;
    const text = textOfMessage(message);
    if (text.trim() !== "") return text;
  }
  return "";
}

/**
 * Build the transient recall message appended into this step's request only.
 *
 * Same mechanism `dsh-agent`'s own `modelSwitchNotice` uses: a `user/message` handed back
 * from the `agent/pre-step` waterfall, never appended to the surface. That matters twice:
 * it cannot be folded (it is not a surface node), and it is not persisted, so the recalled
 * excerpt is re-derived each turn rather than accumulating. `source.kind` is `memory-recall`
 * so a consumer can tell it from real human input.
 *
 * @param {string} block - the rendered recall block (non-empty).
 * @returns {object} frozen message.
 */
export function makeRecallMessage(block) {
  // The block is injected as a `user` message (the only role the pre-step waterfall can
  // hand back), and it sits at the END of this step's messages — i.e. after the real
  // human turn. Without an explicit frame the model reads the last `user` message as
  // "what the user is asking", sees a pile of recalled facts, and replies "I don't see an
  // actual request". This one line tells it, unambiguously, that the block is background
  // memory and MUST NOT be treated as the user's request. Fixed text ⇒ still deterministic
  // (identical every turn, so it does not churn the prompt cache beyond the first send).
  const framed =
    "[系统自动注入的长期记忆，仅供参考，不是用户的提问。请结合下面的用户消息来回答。]\n" +
    String(block ?? "");
  return makeMessage({
    content: [{ type: "text", text: framed }],
    source: { kind: "memory-recall", zone: "recall" },
  });
}

/**
 * Default store reader for {@link publishSelf}: the user's persisted self override,
 * or null when none exists.
 *
 * `self-store.js` depends only on Node built-ins (fs/os/path), so importing it here
 * keeps `pipeline.js` free of harness imports and unit-testable against a fake
 * session. A missing/unreadable override is not an error — it just means "no
 * override", and the caller falls back to the surface copy then the defaults.
 * @returns {import('./tree.js').MemoryNode[]|null} override nodes or null.
 */
function defaultLoadSelfOverride() {
  return readSelfOverride();
}

/**
 * Publish the self tree, or replace the existing copy in place.
 *
 * Replacing rather than appending is what keeps exactly one copy in the surface.
 * `skill-catalog` demonstrates the alternative: it appends and never retires the
 * old copy, and 28.0% of its tokens on this machine are stale.
 *
 * The message goes at the *end* of the surface, not right after the system prompt.
 * A change costs the tokens that follow it, and at the end nothing follows: the
 * whole tree costs ~250 tokens on commit instead of invalidating an entire
 * transcript whose P50 here is 44,033 tokens.
 *
 * `memory:self` is deliberately *not* a fold barrier. Barrier semantics exist for
 * injections that decide whether to re-publish by consulting the surface —
 * `skill-catalog` and `agent-instructions` both do, so hiding their copy makes them
 * re-send the whole payload. This message has a different owner: we re-publish it
 * ourselves from {@link captureSelfNodes}. Marking it a barrier bought nothing and
 * cost everything: a copy anywhere before the retained tail sits inside every later
 * fold range, and because a replace must be contiguous the planner could only cut
 * down to the checkpoint itself, then stall on `too-few-nodes` for the rest of the
 * session — memory frozen at turn one while the transcript kept growing.
 *
 * @param {object} agent - the agent owning this step.
 * @param {object} stats - counters.
 * @param {object[]|null} [nodes] - nodes captured before the fold, if any.
 * @param {{loadOverride?: () => import('./tree.js').MemoryNode[]|null}} [options]
 *   override hook; omit to read the persisted `~/.dsh/storages/dsh_memory_self.json`.
 * @returns {void}
 */
export function publishSelf(agent, stats, nodes, options = {}) {
  const session = agent.session;
  const surface = session.surface?.nodes ?? [];
  // Never publish before the system prompt exists.
  //
  // `agent/pre-step` fires before the harness appends this step's `system/message`,
  // so on turn 1 the surface is empty and appending here would put `memory:self` at
  // index 0 with the system prompt landing at index 1. The session format forbids
  // that — `dsh-session-format-v3-to-v4`'s `foldSurface` throws
  // `system/message requires a protected first surface head` once any non-system
  // node has claimed the head — which is exactly how the A-group session became
  // unreadable. Skipping one step costs nothing: the tree is published next step,
  // and until then the model simply runs with the default persona.
  //
  // `surface.nodes` holds seq numbers, not descriptors, so the type has to be read
  // back off the event. Reading `node.type` here silently yielded `undefined` on
  // every node and the guard never fired.
  const hasSystemHead = surface.some((seq) => session.eventAt?.(seq)?.type === "system/message");
  if (!hasSystemHead) return;

  const existing = findSelfInSurface(surface, (seq) => messageAt(session, seq));

  // v12: source-of-truth order is store → surface → defaults.
  //
  // The store is a user override written from the Settings page. It MUST win over
  // the surface copy, otherwise an edit would be visible only until the next
  // surface read, and would never reach a brand-new session (which has no surface
  // copy at all). `options.loadOverride` exists so tests — and any future embedder
  // — can inject a store reader instead of touching the real `~/.dsh` file; the
  // production default reads `~/.dsh/storages/dsh_memory_self.json` and returns
  // null when it does not exist, which keeps behaviour byte-identical to before.
  const loadOverride =
    typeof options?.loadOverride === "function"
      ? options.loadOverride
      : defaultLoadSelfOverride;
  const override = loadOverride();
  const carried = override ?? nodes ?? readSelfNodes(existing?.message) ?? defaultSelfNodes();
  const content = selfContent(carried);
  if (content.length === 0) return;

  // Revision increments on every publication, including the first. It is debug
  // metadata only — the decision to publish is made by comparing rendered text, so
  // a tree that round-tripped through the log is not republished just because its
  // revision differs.
  const rev = (existing?.message?.source?.rev ?? 0) + 1;
  const message = makeMessage({
    content,
    source: { ...selfSource(rev), nodes: carried },
  });

  if (!existing) {
    session.append("user/message", message, { surfaceOp: "append" });
    stats.selfPublished += 1;
    return;
  }

  // Already up to date? Compare rendered text, not revision: a tree that was read
  // back from the log must not look changed just because it round-tripped.
  if (textOfMessage(existing.message) === textOfMessage(message)) return;

  session.append("user/message", message, {
    surfaceOp: { op: "replace", startSeq: existing.seq, endSeq: existing.seq },
    sourceEventSeqs: [existing.seq],
  });
  stats.selfReplaced += 1;
}

/**
 * Recover the node array a `memory:self` message carried.
 * @param {object|undefined} message - the visible self message.
 * @returns {object[]|null} nodes, or null when it carried none.
 */
function readSelfNodes(message) {
  const nodes = message?.source?.nodes;
  return Array.isArray(nodes) && nodes.length > 0 ? nodes : null;
}

// -----------------------------------------------------------------------------
// Fold
// -----------------------------------------------------------------------------

/**
 * Assign each described surface node the turn it belongs to.
 *
 * `turn/start` events are logged but never surface, so their turn numbers do not
 * reach the message list. Walking the log once in seq order and remembering the
 * most recent `turn/start` is both cheaper and more accurate than inferring turns
 * from message shapes — a single turn can emit 598 messages (measured P95 is
 * 158), so adjacency tells nothing.
 *
 * The surface is **not** ascending by seq: a fold splices a checkpoint carrying the
 * highest seq into an early slot, so `described[i].seq` jumps up and back down. A
 * cursor walked in step with `seq` stops advancing at the checkpoint and leaves every
 * later node unlabelled — which is why every distilled episode used to read `T0`, and
 * why `latestTurn` used to be 0 (silently disabling the aging rule in `mergeNodes`).
 * Lookup is therefore by seq, so surface order does not matter.
 *
 * Mutates `described` in place; nodes before the first `turn/start` keep
 * `turn: null` and are skipped by distillation.
 *
 * @param {object} session - owning session.
 * @param {object[]} described - described surface nodes, in surface order.
 * @returns {void}
 */
export function assignTurns(session, described) {
  if (described.length === 0) return;
  const lastSeq = described.reduce((max, node) => (node.seq > max ? node.seq : max), 0);
  const turnOf = new Map();
  let current = null;
  for (let seq = 0; seq <= lastSeq; seq += 1) {
    const event = session.eventAt?.(seq);
    if (!event) continue;
    if (event.type === "turn/start" && typeof event.data?.turn === "number") {
      current = event.data.turn;
    }
    if (current !== null) turnOf.set(seq, current);
  }
  for (const node of described) {
    const turn = turnOf.get(node.seq);
    if (typeof turn === "number") node.turn = turn;
  }
}

/**
 * Fold when the surface is over budget. Idempotent within a step: once folded the
 * surface no longer exceeds the budget, so a second call skips.
 *
 * Async because v2 distillation may await a model call. Callers must await it: a
 * fire-and-forget fold would append its checkpoint after the request was assembled,
 * which is indistinguishable from a fold that never happened.
 *
 * @param {object} agent - owning agent.
 * @param {AbortSignal|undefined} signal - step cancellation.
 * @param {object} deps - resolved dependencies.
 * @param {Set<string>} deps.barriers - barrier source kinds.
 * @param {object} deps.config - resolved plugin config.
 * @param {object} [deps.logger] - plugin logger.
 * @param {object} deps.stats - counters.
 * @param {object} [deps.llm] - `ctx.llm`, only read when `distillPolicy === "llm"`.
 * @returns {Promise<void>} resolves once the fold (or its skip) is done.
 */
export async function foldIfNeeded(agent, signal, deps) {
  const { barriers, config, logger, stats } = deps;
  const session = agent.session;
  const nodes = session.surface?.nodes ?? [];
  if (nodes.length === 0) return;

  const described = nodes.map((node, index) => {
    const seq = surfaceSeq(node);
    // A node without a seq cannot be priced, folded or cited, and dropping it would
    // shift every later index out of alignment with the surface — which is how a
    // fold range ends up citing the wrong events. Fail loudly instead.
    if (typeof seq !== "number") {
      throw new Error(`memory: surface node ${index} has no sequence number (got ${typeof node})`);
    }
    const event = session.eventAt?.(seq);
    const message = messageAt(session, seq);
    return describeNode({
      seq,
      // The event type is authoritative: surface nodes carry no type, and
      // `tool/result` vs `assistant/message` decides the tool-pairing balance.
      type: event?.type ?? "unknown",
      message,
      tokens: priceMessage(message),
      index,
    });
  });

  // Turn numbers are not on the messages; they are carried by `turn/start`
  // events, which are logged but never surface. One ascending walk over the log
  // assigns every described node its turn, so distillation groups by real turns
  // instead of guessing from message shape.
  assignTurns(session, described);

  // Only the newest visible copy of each barrier kind must stay. Older copies are
  // stale duplicates the surface-aware plugin can no longer reach (it scans backwards
  // for the newest visible one), so keeping them pinned costs their full size for
  // nothing: measured 56,387 tok of catalog on a 6-catalog session, of which 46,877
  // was dead weight. `barrierPolicy: "all"` restores the old behaviour.
  if ((config.barrierPolicy ?? "newest") === "newest") {
    applyNewestBarrierPolicy(described, barriers);
  }

  const plan = planFold({
    nodes: described,
    barriers,
    retainTokens: config.retainTokens,
    minNodesToFold: config.minNodesToFold,
    // Prefer the run that already holds a checkpoint. The tree lives in the
    // checkpoint, so folding a different run would create a second one carrying a
    // different (incomplete) tree, and neither copy would describe the session.
    carryKind: MEMORY_SOURCE_KIND,
  });

  // Cooldown: refuse to fold the same turn twice. Folding is evaluated every step; a
  // long turn that appends many tool results re-crosses `retainTokens` on each step, and
  // without this each step folds — and under v2 re-distils — almost the same range:
  // measured live, one turn folded 19 times over material that never shrank (4.4k–5.6k
  // chars). The reference is the turn the current tail sits in, not the turn the last
  // fold *covered*: during one long turn those differ, and using the covered range let
  // the turn keep folding.
  //
  // This runs BEFORE `plan.skip` is reported. The plan's own skip reason (under-budget,
  // too-few-nodes) describes *whether there is material worth folding*; the cooldown
  // describes *whether this turn is allowed to fold at all*. When a turn's first fold has
  // already happened, "nothing new is foldable" and "this turn may not fold again" are
  // both true — but the second is the real, intended reason, and the human-protection
  // boundary in `planFold` can make the first fire where previously only the second
  // would. Checking cooldown first keeps the counter meaningful: a long turn shows up as
  // a cooldown skip, not as a spurious too-few-nodes. `foldMinTurnGap: 0` disables it.
  const gap = Number.isFinite(config.foldMinTurnGap) ? config.foldMinTurnGap : 0;
  if (gap > 0) {
    const lastFoldTurn = lastCheckpointTurn(session, described);
    const currentTurn = currentTailTurn(described);
    if (lastFoldTurn !== null && currentTurn !== null && currentTurn - lastFoldTurn < gap) {
      stats.skipped[FOLD_SKIP.cooldown] = (stats.skipped[FOLD_SKIP.cooldown] ?? 0) + 1;
      if (config.verbose) {
        logger?.info?.(`fold skipped: ${FOLD_SKIP.cooldown} (turn ${currentTurn}, last fold turn ${lastFoldTurn})`);
      }
      return;
    }
  }

  if (plan.skip) {
    stats.skipped[plan.skip] = (stats.skipped[plan.skip] ?? 0) + 1;
    if (config.verbose) logger?.info?.(`fold skipped: ${plan.skip}`);
    return;
  }

  signal?.throwIfAborted?.();

  // --- Distil exactly the shadowed range. A segment already carried by the
  // checkpoint being replaced is not re-distilled; its nodes survive the merge.
  //
  // Coverage matters because a checkpoint can only be replaced by a fold that
  // reaches its own run, and a run bounded by barriers on both sides is closed for
  // good: once folded, it never receives new material again. Several such closed
  // gaps coexist in one session, so the model sees more than one memory block. Each
  // block therefore records the turns it covers, and the render states that the
  // later block wins — otherwise two same-shaped `<memory>` blocks disagree with no
  // way to tell which one is current.
  const carriedSource = readMemorySource(session, described, plan);
  const carried = carriedSource?.nodes ?? [];
  const coveredTurns = unionTurns(carriedSource?.coveredTurns, turnRangeOf(described, plan));
  const carriedIds = new Set(carried.map((node) => node.id));
  const segment = `s${plan.startSeq}`;
  const fresh = [];
  if (!carriedIds.has(segment)) {
    const material = materialForRange(session, described, plan);
    const anchor = (count) => segmentAnchor(segment, material.turn, plan.startSeq, count);
    const count =
      material.userMessages.length + material.assistantMessages.length + material.toolResults.length;

    // v2 path: only folds big enough to be worth a request, only when asked for, and
    // never at the cost of the fold. A model call that fails, times out, returns junk
    // or returns nothing usable falls through to the rule distiller — the fold must
    // still happen, because "no fold" means the context grows unbounded.
    let children = null;
    if (deps.llm !== undefined && shouldUseLlm(config, plan.shadowedTokens)) {
      stats.llmRequested += 1;
      try {
        const result = await distillWithLlm({
          llm: deps.llm,
          agent,
          material,
          plan,
          turn: material.turn,
          maxNodes: config.llmMaxNodes,
          maxInputTokens: config.llmMaxInputTokens,
          signal,
          timeoutMs: config.llmTimeoutMs,
        });
        stats.llmRejected += result.rejected.length;
        if (result.nodes.length > 0) {
          // The anchor must be emitted with its children; without it every node is an
          // orphan and the renderer throws, which is the failure v0 shipped silently.
          children = [anchor(count), ...result.nodes];
          stats.llmUsed += 1;
        }
      } catch (error) {
        stats.llmFailed += 1;
        logger?.warn?.(`dsh-memory: llm distillation fell back to rules: ${error?.message ?? error}`);
      }
    }

    if (children === null) children = distillTurn({ segment, turn: material.turn, ...material });
    if (children.length > 0) fresh.push(anchor(count), ...children);
  }

  const latestTurn = described.reduce(
    (max, node) => (typeof node.turn === "number" && node.turn > max ? node.turn : max),
    0,
  );
  const merged = mergeNodes(carried, fresh, latestTurn);
  const trimmed = trimToBudget(merged, config.volatileBudget ?? VOLATILE_BUDGET, (node) =>
    priceString(`${node.title}\n${node.body}`),
  );
  stats.droppedNodes += trimmed.dropped.length;
  if (trimmed.oversized) stats.oversized += 1;

  const body = renderZoneTree(trimmed.kept, { depth: 3, origin: "memory" });
  if (body === "") return;

  // --- A run that has a barrier after it can never receive new material again: new
  // messages are appended at the tail, past the last barrier. A fold inside such a
  // run therefore seals a snapshot that will never be revised, and the model may end
  // up reading two `<memory>` blocks that disagree. Say which is which.
  const sealed = runIsClosed(described, plan.endIndex, barriers);

  const spanText = coveredTurns ? `第 ${coveredTurns[0]}–${coveredTurns[1]} 轮` : "";
  const lines = ['<memory zone="volatile">', body, "</memory>"];
  if (sealed) {
    lines.push(`以上是本会话${spanText}已沉入记忆并封存的部分（这一段不会再更新）。`);
    lines.push("与更晚出现的记忆块冲突时，以更晚的为准。");
  } else {
    lines.push(`以上是本会话${spanText}已沉入记忆的部分。`);
    lines.push("若同时存在多个记忆块，轮次更晚的更新；同一事实冲突时以更晚的块为准。");
  }
  lines.push("按需引用，不要原样复述。");
  const text = lines.join("\n");

  const message = makeMessage({
    content: [{ type: "text", text }],
    source: {
      kind: MEMORY_SOURCE_KIND,
      zone: "volatile",
      ...(coveredTurns ? { coveredTurns } : {}),
      ...(sealed ? { sealed: true } : {}),
      nodes: trimmed.kept,
      shadowedTokens: plan.shadowedTokens,
      oversized: trimmed.oversized,
    },
  });

  // The replace must cite every shadowed surface node, densely and in order, or
  // the session layer rejects it with "sourceEventSeqs must include every shadowed
  // surface node". `compaction-basic` builds this list the same way.
  const shadowedSeqs = described.slice(plan.startIndex, plan.endIndex + 1).map((node) => node.seq);

  session.append("user/message", message, {
    surfaceOp: { op: "replace", startSeq: plan.startSeq, endSeq: plan.endSeq },
    sourceEventSeqs: shadowedSeqs,
  });

  stats.folds += 1;
  stats.shadowedTokens += plan.shadowedTokens;
  if (config.verbose) {
    logger?.info?.(
      `folded ${shadowedSeqs.length} node(s), ${plan.shadowedTokens} tok shadowed, ${trimmed.kept.length} node(s) kept`,
    );
  }
}

/**
 * The checkpoint inside the fold range, as its whole `source` record.
 *
 * Read from the surface rather than from memory so that a resumed or forked
 * session continues the same tree: the checkpoint is the tree's only durable form
 * in v1.
 *
 * Only a checkpoint that is itself being shadowed can be carried forward. The fold
 * replacement is contiguous, so a checkpoint sitting in another run cannot be
 * reached; its tree deliberately stays where it is instead of being copied, which
 * is why `coveredTurns` has to be recorded per block.
 *
 * @param {object} session - owning session.
 * @param {object[]} described - described surface nodes.
 * @param {object} plan - fold plan.
 * @returns {object|null} the checkpoint's `source`, `null` when there is none.
 */
function readMemorySource(session, described, plan) {
  for (let index = plan.startIndex; index <= plan.endIndex; index += 1) {
    const message = messageAt(session, described[index].seq);
    if (message?.source?.kind !== MEMORY_SOURCE_KIND) continue;
    if (Array.isArray(message.source.nodes)) return message.source;
  }
  return null;
}

/**
 * Turn in which the newest checkpoint was written, for the cooldown check.
 *
 * Taken from the checkpoint's own described node, whose `turn` comes from the
 * `turn/start` events via `assignTurns` — i.e. the turn the fold happened in. The
 * `coveredTurns` it carries is deliberately not used: that records which turns its
 * *material* spanned, which lags behind the current turn during a long single-turn fold.
 *
 * @param {object} session - owning session.
 * @param {object[]} described - described surface nodes with turns assigned.
 * @returns {number|null} the last folded turn, or `null` when nothing has folded.
 */
function lastCheckpointTurn(session, described) {
  let best = null;
  for (const node of described) {
    const message = messageAt(session, node.seq);
    if (message?.source?.kind !== MEMORY_SOURCE_KIND) continue;
    const turn = typeof node.turn === "number" ? node.turn : null;
    if (turn !== null && (best === null || turn > best)) best = turn;
  }
  return best;
}

/**
 * The turn the newest surface material belongs to.
 *
 * @param {object[]} described - described surface nodes with turns assigned.
 * @returns {number|null} highest assigned turn, or `null` when none is known.
 */
function currentTailTurn(described) {
  let best = null;
  for (const node of described) {
    const turn = typeof node.turn === "number" && node.turn > 0 ? node.turn : null;
    if (turn !== null && (best === null || turn > best)) best = turn;
  }
  return best;
}

/**
 * Turn range covered by the nodes a plan is about to shadow.
 *
 * @param {object[]} described - described surface nodes with turns assigned.
 * @param {object} plan - fold plan.
 * @returns {[number, number]|null} inclusive `[from, to]`, or null when unknown.
 */
function turnRangeOf(described, plan) {
  let from = Infinity;
  let to = -Infinity;
  for (let index = plan.startIndex; index <= plan.endIndex; index += 1) {
    const turn = described[index]?.turn;
    if (typeof turn !== "number" || turn <= 0) continue;
    if (turn < from) from = turn;
    if (turn > to) to = turn;
  }
  return from <= to ? [from, to] : null;
}

/**
 * Widen a carried range with the range being folded now.
 *
 * @param {[number, number]|undefined} previous - carried coverage.
 * @param {[number, number]|null} range - coverage of this fold.
 * @returns {[number, number]|null} union, or null when neither side knows.
 */
function unionTurns(previous, range) {
  const hasPrevious = Array.isArray(previous) && previous.length === 2;
  if (!range) return hasPrevious ? previous : null;
  if (!hasPrevious) return range;
  return [Math.min(previous[0], range[0]), Math.max(previous[1], range[1])];
}

/**
 * Gather the material of a fold range for distillation.
 *
 * Selection is by position in the range, not by turn: a token window routinely
 * ends inside a turn (median turn = 21 messages, P95 = 158), so keeping only
 * whole turns would either stall the fold or drop the part it could not cover.
 * Messages that survive in the retained tail are never collected here, so nothing
 * is both summarised and kept.
 *
 * @param {object} session - owning session.
 * @param {object[]} described - described surface nodes with turns assigned.
 * @param {object} plan - fold plan.
 * @returns {{turn: number, userMessages: object[], assistantMessages: object[], toolResults: object[]}}
 */
function materialForRange(session, described, plan) {
  const userMessages = [];
  const assistantMessages = [];
  const toolResults = [];
  let turn = 0;
  // Tool-call arguments arrive on the assistant message, the result on a later
  // `tool/result` — associated by the call id. Collect args in a first pass so a
  // result can carry "what it was called with" even when the call precedes the
  // window's start (the arguments still ride on the assistant message in range).
  const callArgs = new Map();
  for (let index = plan.startIndex; index <= plan.endIndex; index += 1) {
    const node = described[index];
    if (node.type !== "assistant/message") continue;
    const message = messageAt(session, node.seq);
    for (const block of message?.content ?? []) {
      if (block?.type === "tool-call" && block.id !== undefined) {
        callArgs.set(block.id, formatToolArguments(block.arguments));
      }
    }
  }
  for (let index = plan.startIndex; index <= plan.endIndex; index += 1) {
    const node = described[index];
    // A carried checkpoint is a SUMMARY, not source material. It sits at
    // `plan.startIndex` (the slot this fold's `replace` overwrites), so including it
    // would feed the previous block's digest back into the distiller — memory eating
    // its own tail — and its seq is not an original event anyway. Skip it here so the
    // distilled text and the `seqRange` both describe real content only.
    if (node.sourceKind === MEMORY_SOURCE_KIND) continue;
    if (turn === 0 && typeof node.turn === "number") turn = node.turn;
    const message = messageAt(session, node.seq);
    if (!message) continue;
    if (node.type === "user/message") userMessages.push(message);
    else if (node.type === "assistant/message") assistantMessages.push(message);
    else if (node.type === "tool/result") {
      toolResults.push({
        callId: message.toolCallId,
        name: message.toolName ?? "tool",
        ok: message.isError !== true,
        text: textOfMessage(message),
        args: callArgs.get(message.toolCallId) ?? "",
        // ⑤a: the event seq is what makes the full text retrievable. A distiller turns a
        // tool result into a short node; without the seq the model has no way back to the
        // 39,542-char original sitting in the append-only log. `memory_fetch(seq)` reads it
        // back via `sessionQuery.readEvent`. Missing/NaN seq renders no pointer (the node
        // just keeps its excerpt — same as before this field existed).
        seq: node.seq,
      });
    }
  }
  // The event range this segment distils. Carried into every distilled node so a
  // record promoted from it can point back at the span it came from — see
  // `distillTurn` and `toLtmRecord`'s `meta.seqRange`.
  //
  // Guarded: a plan missing either edge must yield NO field rather than
  // `[undefined, undefined]`, which would sail past the array-length checks in
  // `distillTurn`/`promote-runner` (length is still 2!) and land in LTM as a span
  // that points nowhere.
  // Anchor the span on the REAL content nodes, never on `plan.startSeq` directly.
  //
  // A fold always begins at its run's first surface node, and when a previous
  // checkpoint sits there — the common steady state — `plan.startIndex` points AT the
  // carried checkpoint (the slot the `replace` overwrites). Its seq is the fold-time
  // seq, i.e. the newest event of the batch, so `[plan.startSeq, plan.endSeq]` came out
  // either inverted (`[26822, 26812]`) or pointing `memory_fetch` at a summary instead
  // of the original events. Take the min/max seq among the shadowed nodes that are NOT
  // the carried checkpoint; that is exactly the span `memory_fetch(seq, sessionId)`
  // needs to page the original text back.
  const contentSeqs = described
    .slice(plan.startIndex, plan.endIndex + 1)
    .filter((node) => node.sourceKind !== MEMORY_SOURCE_KIND)
    .map((node) => node.seq);
  const range =
    contentSeqs.length > 0
      ? { seqRange: [Math.min(...contentSeqs), Math.max(...contentSeqs)] }
      : {};
  return { turn, userMessages, assistantMessages, toolResults, ...range };
}

/**
 * Flatten a tool call's `arguments` into a short one-line preview.
 *
 * Adapters hand `arguments` back as a JSON string; some may pass an object. Both are
 * accepted. The point is that a tool node reads `read(file_path=HANDOFF.md)` instead of
 * a bare `read` — for a `bash` call whose output is empty, the command IS the value.
 * Whitespace is collapsed so a multi-line argument list cannot break the one-line body.
 *
 * @param {unknown} args - the `tool-call.arguments` value.
 * @returns {string} one-line preview, or `""` when there is nothing useful.
 */
function formatToolArguments(args) {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return String(args).replace(/\s+/g, " ").trim().slice(0, 160);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const parts = [];
  for (const [key, raw] of Object.entries(value)) {
    let text;
    if (typeof raw === "string") text = raw;
    else text = JSON.stringify(raw);
    text = String(text ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 80) text = `${text.slice(0, 80)}…`;
    if (text !== "") parts.push(`${key}=${text}`);
  }
  return parts.join(" ").slice(0, 160);
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/**
 * Derive a surface node's message. `deriveEventMessage` is the only supported
 * path: the event payload is not the message for types other than
 * `user/message`.
 *
 * @param {object} session - owning session.
 * @param {number} seq - node seq.
 * @returns {object|null} message.
 */
function messageAt(session, seq) {
  if (typeof seq !== "number") return null;
  const event = session.eventAt?.(seq);
  if (!event) return null;
  try {
    return session.deriveEventMessage?.(event) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a message without importing the LLM package.
 *
 * The session layer validates only `id` (non-empty), `role` (matching the event
 * type), `source.kind` (non-empty) and `content` (array), so a hand-built object
 * is accepted and keeps this plugin free of a runtime dependency on the harness's
 * message factory. `source` is free-form beyond `kind`, which is where the tree
 * is carried.
 *
 * @param {{content: object[], source: object}} input - message fields.
 * @returns {object} a frozen user message.
 */
function makeMessage(input) {
  return Object.freeze({ id: randomUUID(), role: "user", content: input.content, source: input.source });
}

/**
 * Concatenate a message's text blocks.
 * @param {object} message - model message.
 * @returns {string} text.
 */
function textOfMessage(message) {
  const blocks = message?.content ?? [];
  let text = "";
  for (const block of blocks) if (block?.type === "text") text += block.text;
  return text;
}
