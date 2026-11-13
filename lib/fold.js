/**
 * Fold planner: decide which slice of the surface a checkpoint may replace.
 *
 * This is the only module that decides what disappears from the model's view, so
 * it is pure and independently testable: it takes a description of the surface
 * and returns either a range to replace or a reason not to. The plugin never
 * computes a range anywhere else.
 *
 * Four constraints, each with a concrete failure it prevents:
 *
 *   1. `system/message` nodes are never foldable, and neither is the surface head.
 *      The session layer protects the first surface node only when that node IS a
 *      `system/message` (`assertSystemHeadRewrite`; `dsh-session-format-v3-to-v4`
 *      throws `system/message requires a protected first surface head` otherwise).
 *      This plugin appends `memory:self` before the harness publishes its first
 *      system message, so index 0 is NOT reliably the system prompt — assuming it
 *      was made the fold eat the system prompt, and the harness re-sent it next
 *      step. A live A/B session showed exactly that: 7 folds produced 7 extra
 *      `system/message` events, and the log no longer opened at all.
 *      Both are therefore treated as protected: the foldable region starts after
 *      the head, and any `system/message` anywhere is a barrier.
 *
 *   2. Barrier nodes must stay visible. `skill-catalog` and `agent-instructions`
 *      decide whether to re-publish by reading `session.surface.nodes`; hiding
 *      their copy makes the injector believe nothing was published, so it re-sends
 *      the whole payload (`skill-catalog` is 9,507 tok at its largest here).
 *      Because a replace covers a contiguous range, a barrier splits the foldable
 *      region into runs and the planner picks one run — never a range spanning one.
 *
 *   3. The retained tail is measured in tokens, not messages. v0 measured a
 *      single turn adding P50 21 / P95 158 messages, so a message-count window
 *      is flushed almost every turn (4-message window: 80.9% of turns; 32: 38.6%).
 *      A token window at least tracks what the budget is actually about.
 *
 *   4. Tool pairing must be balanced. Replacing a range that ends between an
 *      assistant's tool call and its result leaves the model with a call that
 *      can never be answered; the session layer rejects the request. The
 *      planner moves the boundary instead of trusting the caller.
 *
 * Constraint 2 used to be implemented as "fold the prefix from index 1, cut at the
 * first barrier". That is subtly fatal: a barrier near the head caps memory at
 * whatever sits before it, forever. A live session showed exactly that — the skill
 * catalog at index 4 left 462 tokens foldable, so after one fold the checkpoint
 * became node 1, the barrier moved to index 2, and every later turn skipped with
 * `too-few-nodes` while the surface grew to 451k tokens. Folding the *largest run*
 * instead keeps the barrier in place and lets everything after it fold repeatedly.
 */

/** Reasons a fold may be declined. Stable strings — they are logged and counted. */
export const FOLD_SKIP = Object.freeze({
  tooFewNodes: "too-few-nodes",
  noFoldablePrefix: "no-foldable-prefix",
  underBudget: "under-budget",
  emptyRange: "empty-range",
  cooldown: "cooldown",
});

/**
 * @typedef {object} SurfaceNode
 * @property {number} seq - session seq of the event occupying this node
 * @property {string} type - surface event type
 * @property {string|null} sourceKind - `source.kind`, null for non-message nodes
 * @property {number} tokens - priced size of this node
 * @property {number} toolCallDelta - +N for N tool calls, -1 for a result, 0 otherwise
 * @property {number} index - 0-based position in the surface
 */

/**
 * @typedef {object} FoldPlan
 * @property {number} startSeq
 * @property {number} endSeq
 * @property {number} startIndex
 * @property {number} endIndex
 * @property {number} shadowedTokens
 * @property {number} retainedNodes
 */

/**
 * Plan a fold.
 *
 * Returns `{ skip }` when nothing should be folded this turn; the caller logs the
 * reason rather than treating it as an error, because "under budget" is the
 * steady state on short sessions.
 *
 * @param {object} input - planner input.
 * @param {SurfaceNode[]} input.nodes - the current surface, in order.
 * @param {Set<string>} input.barriers - `source.kind`s that must stay visible.
 * @param {number} input.retainTokens - token budget for the verbatim tail.
 * @param {number} [input.minNodesToFold] - refuse to fold fewer than this.
 * @param {string} [input.carryKind] - `source.kind` of the previous checkpoint.
 *   When a run contains it, only that run is considered, so the tree is carried
 *   forward instead of a second checkpoint being created beside the first.
 * @returns {FoldPlan | {skip: string, detail?: string}} plan or skip.
 */
export function planFold(input) {
  const { nodes, barriers, retainTokens } = input;
  const minNodesToFold = input.minNodesToFold ?? 2;
  const carryKind = input.carryKind ?? null;

  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { skip: FOLD_SKIP.emptyRange };
  }

  // --- 0. The current human turn is a hard boundary, independent of the token math.
  //
  // A single node can exceed `retainTokens` on its own (a 39,542-char tool result is
  // ~14,358 tok against a 12,000 budget — HANDOFF §5.15, session `bb7dc00b`). When that
  // happens `retainedTailStart` stops *before* the giant node, so any fold that ends
  // after it would also swallow the current question. The model then sees a
  // conversation ending in memory blocks with no user message and answers as if the
  // session just resumed.
  //
  // Token accounting cannot prevent this: the tail can legitimately be empty. Only a
  // positional invariant can. The last `source.kind === "user"` node is therefore never
  // foldable — the fold range may never extend up to or past it. Earlier human turns
  // remain foldable (folding history is the point); only the newest one is protected.
  //
  // `-1` when there is no human on the surface (nothing to protect): behaviour is
  // unchanged from before this rule existed.
  const lastHumanIndex = lastHumanNodeIndex(nodes);
  const humanBound = lastHumanIndex >= 0 ? lastHumanIndex - 1 : nodes.length - 1;

  // --- 1. Where may the verbatim tail start? Everything from here on is kept.
  const tailStart = retainedTailStart(nodes, retainTokens, 1);
  if (tailStart <= 1) {
    // The tail already covers every node a fold could touch.
    if (tailTokens(nodes, 1) <= retainTokens) return { skip: FOLD_SKIP.underBudget };
    return { skip: FOLD_SKIP.tooFewNodes };
  }

  // --- 2. Split [1, tailStart) into maximal runs that contain no barrier.
  const runs = foldableRuns(nodes, barriers, tailStart);
  if (runs.length === 0) return { skip: FOLD_SKIP.noFoldablePrefix };

  // --- 3. Prefer the run carrying the previous checkpoint, so memory accumulates
  //     in one place. A barrier can cap that run (a checkpoint that ended up before
  //     a barrier can never grow), so this is a preference, not a rule: stalling
  //     forever is worse than an extra checkpoint, and the pipeline carries the tree
  //     forward from whichever checkpoint is newest regardless of which run it folds.
  const carrying = carryKind === null ? [] : runs.filter((run) => containsKind(nodes, run, carryKind));
  const pool = carrying.length > 0 ? carrying : runs;

  // --- 4. Largest run first: a tiny run near the head is a trap, because once it
  //     is folded the checkpoint occupies its slot and the next run starts one
  //     node later, shrinking until nothing is left.
  const ranked = [...pool]
    .map((run) => ({ ...run, tokens: sumTokens(nodes, run.start, run.end) }))
    .sort((left, right) => right.tokens - left.tokens || left.start - right.start);

  for (const run of ranked) {
    // --- 5. Clamp the run to the human boundary FIRST, then repair tool pairing inside
    //     [start, clampedEnd]. Order matters: balancing first and clamping afterwards can
    //     cut between a call and its result (the clamp lands inside a pair), producing a
    //     range the session layer rejects. Clamping first means `balanceToolPairing` only
    //     ever retracts within the already-safe window, so its result is both balanced and
    //     before the protected human node.
    const runEnd = Math.min(run.end, humanBound);
    if (runEnd < run.start) continue;
    const endIndex = balanceToolPairing(nodes, run.start, runEnd, tailStart);
    if (endIndex < run.start) continue;
    if (endIndex - run.start + 1 < minNodesToFold) continue;

    return {
      startSeq: nodes[run.start].seq,
      endSeq: nodes[endIndex].seq,
      startIndex: run.start,
      endIndex,
      shadowedTokens: sumTokens(nodes, run.start, endIndex),
      retainedNodes: nodes.length - endIndex - 1,
    };
  }

  // --- 6. The carrying run was too small to be worth a checkpoint, but other runs
  //     may not be. Falling back keeps memory moving instead of freezing.
  if (pool !== runs) {
    const fallback = [...runs]
      .map((run) => ({ ...run, tokens: sumTokens(nodes, run.start, run.end) }))
      .sort((left, right) => right.tokens - left.tokens || left.start - right.start);
    for (const run of fallback) {
      // Clamp to the human boundary before balancing, same reason as step 5.
      const runEnd = Math.min(run.end, humanBound);
      if (runEnd < run.start) continue;
      const endIndex = balanceToolPairing(nodes, run.start, runEnd, tailStart);
      if (endIndex < run.start) continue;
      if (endIndex - run.start + 1 < minNodesToFold) continue;
      return {
        startSeq: nodes[run.start].seq,
        endSeq: nodes[endIndex].seq,
        startIndex: run.start,
        endIndex,
        shadowedTokens: sumTokens(nodes, run.start, endIndex),
        retainedNodes: nodes.length - endIndex - 1,
      };
    }
  }

  return { skip: FOLD_SKIP.tooFewNodes };
}

/**
 * Index of the newest human turn on the surface, or -1 when there is none.
 *
 * "Human" is `source.kind === "user"` — the real person typing — NOT `runtime-context`,
 * `time-context`, `memory:self`, `memory-recall`, or any Inject-authored user/message.
 * Those are machine-authored and safe to fold; only a message the human actually wrote
 * must survive, because losing it makes the model believe the session resumed.
 *
 * `planFold` uses this as a positional fold boundary (see step 0 there): the fold range
 * may never reach up to or past this index. It is the last line of defence against the
 * §5.15 bug, and it holds no matter how the token accounting behaves.
 *
 * @param {SurfaceNode[]} nodes - surface.
 * @returns {number} index of the newest `source.kind === "user"` node, or -1.
 */
export function lastHumanNodeIndex(nodes) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]?.sourceKind === "user") return index;
  }
  return -1;
}

/**
 * Maximal runs of non-barrier nodes inside `[1, end)`.
 *
 * Index 0 is never included: it carries the system prompt, and the session layer
 * refuses any replace that covers it.
 *
 * @param {SurfaceNode[]} nodes - surface.
 * @param {Set<string>} barriers - barrier kinds.
 * @param {number} end - exclusive upper bound (the retained tail start).
 * @returns {{start: number, end: number}[]} runs, ascending by start.
 */
export function foldableRuns(nodes, barriers, end) {
  const runs = [];
  let start = -1;
  for (let index = 1; index < end; index += 1) {
    const blocked = isBarrier(nodes[index], barriers);
    if (blocked) {
      if (start !== -1) {
        runs.push({ start, end: index - 1 });
        start = -1;
      }
      continue;
    }
    if (start === -1) start = index;
  }
  if (start !== -1) runs.push({ start, end: end - 1 });
  return runs;
}

/**
 * Is the run ending at `endIndex` closed for good?
 *
 * New messages are appended at the tail, always past the last barrier. So a run with
 * a barrier somewhere after it can never receive new material: whatever is folded
 * out of it becomes a snapshot that will never be revised. The planner still folds
 * it (leaving it verbatim would defeat the budget), but the render has to say so —
 * two `<memory>` blocks that disagree must not look equally current.
 *
 * @param {object[]} nodes - described surface nodes (`sourceKind` is read).
 * @param {number} endIndex - last index of the folded range.
 * @param {Set<string>} barriers - barrier source kinds.
 * @returns {boolean} true when nothing new can ever reach that run.
 */
export function runIsClosed(nodes, endIndex, barriers) {
  for (let index = endIndex + 1; index < nodes.length; index += 1) {
    if (barriers.has(nodes[index]?.sourceKind)) return true;
  }
  return false;
}

/**
 * Does a run contain a node with this `source.kind`?
 * @param {SurfaceNode[]} nodes - surface.
 * @param {{start: number, end: number}} run - inclusive run.
 * @param {string} kind - `source.kind` to look for.
 * @returns {boolean} true when present.
 */
export function containsKind(nodes, run, kind) {
  for (let index = run.start; index <= run.end; index += 1) {
    if (nodes[index]?.sourceKind === kind) return true;
  }
  return false;
}

/**
 * First index a fold may start at.
 *
 * Kept for diagnostics: it answers "where does the foldable region begin", which
 * is not the same question as "which run should be folded" (`planFold` answers
 * that one).
 *
 * @param {SurfaceNode[]} nodes - surface.
 * @param {Set<string>} barriers - barrier kinds.
 * @returns {number} index, or -1 when there is no foldable node at all.
 */
export function firstFoldableIndex(nodes, barriers) {
  for (let index = 1; index < nodes.length; index += 1) {
    if (!isBarrier(nodes[index], barriers)) return index;
  }
  return -1;
}

/**
 * Where the retained tail begins, given a token budget.
 * @param {SurfaceNode[]} nodes - surface.
 * @param {number} retainTokens - budget.
 * @param {number} floor - never return less than this index.
 * @returns {number} index of the first retained node.
 */
export function retainedTailStart(nodes, retainTokens, floor) {
  let used = 0;
  let index = nodes.length;
  while (index > floor) {
    const next = nodes[index - 1];
    const cost = Math.max(0, next.tokens ?? 0);
    if (used + cost > retainTokens) break;
    used += cost;
    index -= 1;
  }
  return index;
}

/**
 * Move a fold end backwards until the range does not split a tool pair.
 *
 * A split happens when more calls than results are outstanding at the end of the
 * range: the retained tail then starts with results that answer calls which no
 * longer exist in the request. Retracting the end one node at a time is enough,
 * because an assistant message contributes +1 per call and a result -1, so the
 * running balance returns to zero at the last fully answered call.
 *
 * @param {SurfaceNode[]} nodes - surface.
 * @param {number} startIndex - inclusive start.
 * @param {number} endIndex - inclusive end, adjusted in place.
 * @param {number} limit - do not search past this index.
 * @returns {number} a balanced end index, possibly < startIndex.
 */
export function balanceToolPairing(nodes, startIndex, endIndex, limit) {
  let cursor = endIndex;
  while (cursor >= startIndex) {
    if (balanceOf(nodes, startIndex, cursor) === 0) return cursor;
    cursor -= 1;
  }
  return startIndex - 1;
}

/**
 * Outstanding tool-call balance over `[start, end]`.
 * @param {SurfaceNode[]} nodes - surface.
 * @param {number} start - inclusive.
 * @param {number} end - inclusive.
 * @returns {number} calls minus results.
 */
export function balanceOf(nodes, start, end) {
  let balance = 0;
  for (let index = start; index <= end; index += 1) {
    balance += nodes[index].toolCallDelta ?? 0;
  }
  return balance;
}

/**
 * Is this node a fold barrier?
 *
 * Two independent reasons a node must stay visible:
 *
 *   1. Its `source.kind` is in `barriers` (skill catalog, agent instructions).
 *   2. It is a `system/message`.
 *
 * The second is not configurable and not negotiable. A live session proved why:
 * the plugin published `memory:self` at index 0 before the harness appended its
 * system prompt at index 1, so "index 0 is the system prompt, start folding at
 * index 1" folded the *system prompt* on seven separate turns. Each fold was
 * followed one step later by a fresh `system/message` — the harness re-publishing
 * what had been hidden — so the session ended with 8 system messages where the
 * plugin-free control had 1, and `unstable` hit 100% because the model's
 * personality and tool constraints drifted every turn.
 *
 * The session format enforces this too: `dsh-session-format-v3-to-v4`'s
 * `foldSurface` throws `system/message requires a protected first surface head`
 * when a system message arrives after any non-system node has claimed the head.
 * That is what made the A-group log unreadable.
 *
 * @param {SurfaceNode} node - surface node.
 * @param {Set<string>} barriers - barrier kinds.
 * @returns {boolean} true when it must stay.
 */
export function isBarrier(node, barriers) {
  if (node?.type === "system/message") return true;
  // `barrierOverride` is set by `applyNewestBarrierPolicy`: only the newest visible
  // copy of a barrier kind is protected, older stale copies are foldable. The
  // surface-aware plugins dedup by scanning backwards for the newest *visible* copy
  // (v0-findings §2.7 measured 28% of catalog bytes as stale duplicates), so older
  // copies are dead weight — folding them costs nothing and never triggers a
  // re-publish.
  if (node?.barrierOverride === false) return false;
  if (node?.barrierOverride === true) return true;
  return node?.sourceKind != null && barriers.has(node.sourceKind);
}

/**
 * Mark every described node with whether it is the newest visible copy of its barrier
 * kind.
 *
 * Older copies are marked `false` so a fold may shadow them; the newest keeps `true`
 * and still cuts fold ranges. Folding away a stale catalog is safe by construction:
 * the surface-aware plugin's dedup looks for the newest visible copy, and that copy
 * is exactly the one left alone.
 *
 * @param {SurfaceNode[]} nodes - described surface nodes, mutated in place.
 * @param {Set<string>} barriers - barrier kinds.
 * @returns {void}
 */
export function applyNewestBarrierPolicy(nodes, barriers) {
  /** @type {Map<string, number>} */
  const newestSeq = new Map();
  for (const node of nodes) {
    const kind = node?.sourceKind;
    if (kind == null || !barriers.has(kind)) continue;
    const seen = newestSeq.get(kind);
    if (seen === undefined || node.seq > seen) newestSeq.set(kind, node.seq);
  }
  for (const node of nodes) {
    const kind = node?.sourceKind;
    if (kind == null || !barriers.has(kind)) continue;
    node.barrierOverride = node.seq === newestSeq.get(kind);
  }
}

/**
 * Sum tokens over an inclusive range.
 * @param {SurfaceNode[]} nodes - surface.
 * @param {number} start - inclusive.
 * @param {number} end - inclusive.
 * @returns {number} tokens.
 */
export function sumTokens(nodes, start, end) {
  let total = 0;
  for (let index = start; index <= end; index += 1) total += nodes[index].tokens ?? 0;
  return total;
}

/**
 * Sum tokens from an index to the end.
 * @param {SurfaceNode[]} nodes - surface.
 * @param {number} start - inclusive.
 * @returns {number} tokens.
 */
export function tailTokens(nodes, start) {
  return sumTokens(nodes, start, nodes.length - 1);
}

/**
 * Describe a surface node for the planner.
 *
 * Centralised so the plugin and the offline harness cannot drift: both build the
 * same descriptor from the same event shape, so a plan verified against a
 * recorded session means the same thing at runtime.
 *
 * @param {object} input - descriptor input.
 * @param {number} input.seq - event seq.
 * @param {string} input.type - event type.
 * @param {object|null} input.message - derived message, if any.
 * @param {number} [input.turn] - owning turn, when the caller resolved it.
 * @param {number} input.tokens - priced size.
 * @param {number} input.index - position.
 * @returns {SurfaceNode} descriptor.
 */
export function describeNode(input) {
  const message = input.message ?? null;
  const blocks = message?.content ?? [];
  let calls = 0;
  for (const block of blocks) if (block?.type === "tool-call") calls += 1;
  const toolCallDelta = calls > 0 ? calls : input.type === "tool/result" ? -1 : 0;
  return {
    seq: input.seq,
    type: input.type,
    sourceKind: message?.source?.kind ?? null,
    turn: typeof input.turn === "number" ? input.turn : null,
    tokens: input.tokens,
    toolCallDelta,
    index: input.index,
  };
}
