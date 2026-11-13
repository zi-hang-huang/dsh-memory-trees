/**
 * Fold planner contract tests.
 *
 * Each test pins one constraint that would otherwise be discovered in production
 * by a corrupted session: a protected system prompt, an invisible barrier, a
 * split tool pair, or a range that is simply too small to be worth the checkpoint
 * it costs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FOLD_SKIP,
  applyNewestBarrierPolicy,
  balanceOf,
  describeNode,
  isBarrier,
  planFold,
  retainedTailStart,
  runIsClosed,
  sumTokens,
  tailTokens,
} from "../lib/fold.js";

const BARRIERS = new Set(["skill-catalog", "agent-instructions", "memory:self"]);

/**
 * Build a surface node.
 * @param {number} seq - event seq.
 * @param {object} [options] - overrides.
 * @returns {object} surface node.
 */
function node(seq, options = {}) {
  return {
    seq,
    type: options.type ?? "user/message",
    sourceKind: options.sourceKind ?? "user",
    turn: options.turn ?? 1,
    tokens: options.tokens ?? 100,
    toolCallDelta: options.toolCallDelta ?? 0,
    index: options.index ?? 0,
  };
}

/**
 * Header node plus `count` body nodes of `tokens` each.
 * @param {number} count - body nodes.
 * @param {number} tokens - per-node cost.
 * @returns {object[]} surface.
 */
function surface(count, tokens = 100) {
  const nodes = [node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 })];
  for (let index = 0; index < count; index += 1) nodes.push(node(index + 1, { tokens }));
  return nodes.map((entry, index) => ({ ...entry, index }));
}

test("never folds node 0", () => {
  const nodes = surface(40);
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  assert.ok(!("skip" in plan), "expected a plan");
  assert.equal(plan.startIndex, 1);
  assert.notEqual(plan.startSeq, 0);
});

test("a system message is a barrier wherever it sits, not just at index 0", () => {
  // The A-group regression. `memory:self` was published at index 0 on turn 1, so the
  // system prompt landed at index 1 and "index 0 is the system prompt, start at 1"
  // folded the system prompt itself. The harness then re-published it one step later,
  // seven times over, and the session format rejected the log
  // (`system/message requires a protected first surface head`).
  //
  // So the protection cannot be positional. A `system/message` must be a barrier by
  // type, at any index.
  const nodes = surface(40, 100);
  // Pretend the self message claimed the head and pushed the system prompt to index 1.
  nodes[0] = node(0, { type: "user/message", sourceKind: "memory:self", tokens: 250 });
  nodes[1] = node(1, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 });
  nodes.forEach((entry, index) => {
    entry.index = index;
  });

  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  assert.ok(!("skip" in plan), "expected a plan that folds something");
  assert.ok(plan.startIndex > 1, `fold must start after the system message, got ${plan.startIndex}`);
  assert.ok(
    plan.endSeq < 1 || plan.startSeq > 1,
    "no plan may cover the system message at index 1",
  );
});

test("isBarrier treats a system message as a barrier with an empty barrier set", () => {
  const systemNode = node(3, { type: "system/message", sourceKind: "system-prompt" });
  assert.equal(isBarrier(systemNode, new Set()), true, "system/message is unconditionally a barrier");
  assert.equal(isBarrier(node(4, { sourceKind: "skill-catalog" }), new Set()), false);
  assert.equal(isBarrier(node(4, { sourceKind: "skill-catalog" }), new Set(["skill-catalog"])), true);
});

test("under budget is a skip, not an error", () => {
  const nodes = surface(5, 100);
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 100_000 });
  assert.equal(plan.skip, FOLD_SKIP.underBudget);
});

test("retained tail is measured in tokens", () => {
  const nodes = surface(40, 100);
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  const kept = nodes.length - plan.endIndex - 1;
  assert.ok(kept * 100 >= 1000, `tail ${kept * 100} tok must cover the 1000 tok budget`);
  assert.ok(kept * 100 <= 1100, `tail ${kept * 100} tok must not overshoot by a whole node`);
});

test("folds a run that contains no barrier", () => {
  const nodes = surface(40, 100);
  nodes[10] = { ...nodes[10], sourceKind: "skill-catalog" };
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  assert.ok(!("skip" in plan));
  for (let index = plan.startIndex; index <= plan.endIndex; index += 1) {
    assert.notEqual(nodes[index].sourceKind, "skill-catalog", "a barrier must never be folded");
  }
});

test("picks the largest run, not the prefix before the first barrier", () => {
  // A barrier near the head used to cap memory at whatever preceded it: the fold
  // took [1,9], the checkpoint then occupied slot 1, the barrier moved to slot 2,
  // and every later turn skipped with too-few-nodes while the surface kept growing.
  // This is the live failure from session-f98f54a9 (462 tokens foldable, 451k
  // tokens of surface).
  const nodes = surface(40, 100);
  nodes[4] = { ...nodes[4], sourceKind: "skill-catalog" };
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  assert.ok(!("skip" in plan), "expected a plan");
  assert.ok(plan.startIndex > 4, `start ${plan.startIndex} must be after the barrier at 4`);
  assert.ok(plan.shadowedTokens > 1000, `shadowed ${plan.shadowedTokens} tok must exceed the 462-token trap`);
});

test("keeps folding turn after turn when a barrier sits near the head", () => {
  // The regression in full: fold, splice the checkpoint in, let the next turn append
  // more messages, fold again. Memory must keep moving forward instead of freezing at
  // turn one. The surface must grow between rounds — a turn that adds nothing has no
  // memory to fold, and asserting otherwise would demand folding inside the tail budget.
  const BARRIER_AT = 4;
  let live = surface(60, 100);
  live[BARRIER_AT] = { ...live[BARRIER_AT], sourceKind: "skill-catalog" };
  let nextSeq = 1000;
  let folds = 0;
  let lastShadowed = 0;

  for (let round = 0; round < 4; round += 1) {
    const plan = planFold({ nodes: live, barriers: BARRIERS, retainTokens: 1000 });
    assert.ok(!("skip" in plan), `round ${round} must fold, got ${plan.skip}`);

    // A barrier is never folded, and node 0 (the system prompt) is never folded.
    assert.ok(plan.startIndex > 0, "node 0 is the system prompt");
    for (let index = plan.startIndex; index <= plan.endIndex; index += 1) {
      assert.notEqual(live[index].sourceKind, "skill-catalog", "a barrier must stay visible");
    }

    // The barrier must survive the fold in place, so later rounds can fold past it.
    assert.equal(live[BARRIER_AT].sourceKind, "skill-catalog");
    lastShadowed = plan.shadowedTokens;

    // Replace the range with one checkpoint node, exactly as the session layer does.
    const checkpoint = node(nextSeq++, { sourceKind: "memory", tokens: 100 });
    live = [
      ...live.slice(0, plan.startIndex),
      checkpoint,
      ...live.slice(plan.endIndex + 1),
    ].map((entry, index) => ({ ...entry, index }));

    // The next turn appends messages.
    const appended = Array.from({ length: 20 }, () => node(nextSeq++, { tokens: 100 }));
    live = [...live, ...appended].map((entry, index) => ({ ...entry, index }));
    folds += 1;
  }

  assert.equal(folds, 4);
  // Memory kept absorbing real content instead of settling on a fixed 462-token slice.
  assert.ok(lastShadowed > 1000, `last fold shadowed ${lastShadowed} tok`);
});

test("does not fold when the tail budget leaves fewer than two foldable nodes", () => {
  // A turn that adds little leaves nothing worth a checkpoint. This must be a skip,
  // not a fold that eats into the verbatim tail. 19 body nodes at 100 tok with a
  // 1800-token tail leaves exactly one foldable node (index 1).
  const nodes = surface(19, 100);
  nodes[4] = { ...nodes[4], sourceKind: "skill-catalog" };
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1800 });
  assert.equal(plan.skip, "too-few-nodes");
});

test("a barrier is never folded even when the tail budget is tiny", () => {
  const nodes = surface(40, 100);
  nodes[1] = { ...nodes[1], sourceKind: "memory:self" };
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 100 });
  // Node 1 is a barrier, so the foldable prefix starts after it.
  assert.ok(!("skip" in plan));
  assert.ok(plan.startIndex > 1);
});

test("moves the boundary rather than splitting a tool pair", () => {
  const nodes = surface(20, 100);
  // Assistant issues a call at index 15, its result lands at index 16.
  nodes[15] = { ...nodes[15], type: "assistant/message", sourceKind: "model", toolCallDelta: 1 };
  nodes[16] = { ...nodes[16], type: "tool/result", sourceKind: "tool", toolCallDelta: -1 };
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 1200 });
  assert.ok(!("skip" in plan));
  assert.equal(
    balanceOf(nodes, plan.startIndex, plan.endIndex),
    0,
    "range must leave no unanswered call",
  );
});

test("unanswered trailing call is excluded from the range", () => {
  const nodes = surface(30, 100);
  nodes[20] = { ...nodes[20], type: "assistant/message", sourceKind: "model", toolCallDelta: 1 };
  // No result for this call anywhere.
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 500 });
  assert.ok(!("skip" in plan));
  assert.ok(plan.endIndex < 20, `end ${plan.endIndex} must stay before the unanswered call`);
  assert.equal(balanceOf(nodes, plan.startIndex, plan.endIndex), 0);
});

test("respects minNodesToFold", () => {
  const nodes = surface(40, 100); // header 1000 + 40 x 100 = 5000 tok
  // A 3800 tok tail leaves exactly two foldable nodes.
  const twoLeft = planFold({ nodes, barriers: BARRIERS, retainTokens: 3800, minNodesToFold: 2 });
  assert.equal(twoLeft.endIndex - twoLeft.startIndex + 1, 2);

  const threeWanted = planFold({ nodes, barriers: BARRIERS, retainTokens: 3800, minNodesToFold: 3 });
  assert.equal(threeWanted.skip, FOLD_SKIP.tooFewNodes);

  // A 3900 tok tail leaves one foldable node, which is always too few.
  const oneLeft = planFold({ nodes, barriers: BARRIERS, retainTokens: 3900, minNodesToFold: 2 });
  assert.equal(oneLeft.skip, FOLD_SKIP.tooFewNodes);
});

test("empty surface is an empty-range skip", () => {
  assert.equal(planFold({ nodes: [], barriers: BARRIERS, retainTokens: 10 }).skip, FOLD_SKIP.emptyRange);
});

test("all-barriers surface has no foldable prefix", () => {
  const nodes = [
    node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 900 }),
    node(1, { sourceKind: "skill-catalog", tokens: 9000 }),
    node(2, { sourceKind: "agent-instructions", tokens: 2000 }),
    node(3, { sourceKind: "memory:self", tokens: 250 }),
  ].map((entry, index) => ({ ...entry, index }));
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 10 });
  assert.ok(plan.skip, "expected a skip");
});

test("describeNode infers call delta from content and result type", () => {
  const call = describeNode({
    seq: 7,
    type: "assistant/message",
    message: { content: [{ type: "tool-call" }, { type: "tool-call" }], source: { kind: "model" } },
    tokens: 10,
    index: 3,
  });
  assert.equal(call.toolCallDelta, 2);
  assert.equal(call.sourceKind, "model");

  const result = describeNode({
    seq: 8,
    type: "tool/result",
    message: { content: [], source: { kind: "tool", callId: "c1" } },
    tokens: 4,
    index: 4,
  });
  assert.equal(result.toolCallDelta, -1);

  const plain = describeNode({ seq: 9, type: "user/message", message: null, tokens: 3, index: 5 });
  assert.equal(plain.toolCallDelta, 0);
  assert.equal(plain.sourceKind, null);
});

test("plan is deterministic for the same input", () => {
  const nodes = surface(40, 100);
  const first = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  const second = planFold({ nodes, barriers: BARRIERS, retainTokens: 1000 });
  assert.deepEqual(first, second);
});

// -----------------------------------------------------------------------------
// Regressions found by a live A-group run that corrupted a real session log
// -----------------------------------------------------------------------------

test("a system message is a barrier even when its kind is not configured", () => {
  // A live session proved this the expensive way. `memory:self` was published at
  // index 0 before the harness appended its system prompt at index 1, so the old
  // rule "index 0 is the system prompt, start folding at index 1" folded the
  // *system prompt* on seven separate turns. Each fold was followed one step later
  // by a fresh `system/message` — the harness re-publishing what had been hidden —
  // so the session ended with 8 system messages where the plugin-free control had
  // 1, and `unstable` hit 100% because persona and tool constraints drifted every
  // turn.
  //
  // `system/message` therefore must be a barrier unconditionally, independent of
  // `barrierKinds`. Callers cannot opt out by forgetting to configure it.
  const nodes = [
    node(0, { type: "user/message", sourceKind: "memory:self", tokens: 250 }),
    node(1, { type: "system/message", sourceKind: "system-prompt", tokens: 9984 }),
    ...Array.from({ length: 40 }, (_, index) => node(index + 2, { tokens: 100 })),
  ].map((entry, index) => ({ ...entry, index }));

  const plan = planFold({ nodes, barriers: new Set(), retainTokens: 1000 });
  assert.ok(!("skip" in plan), "expected a plan");
  assert.ok(plan.startIndex !== 1, "the system message must never be the fold start");
  assert.ok(plan.endIndex !== 1, "the system message must never be inside the range");
  assert.ok(
    plan.startIndex > 1,
    `fold must begin after the system message, got index ${plan.startIndex}`,
  );
});

test("a system message splits the foldable region instead of being folded with it", () => {
  // Two system messages: the second one (a harness re-publish) must not be swept
  // up by a range that starts before it.
  const nodes = [
    node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 }),
    ...Array.from({ length: 30 }, (_, index) => node(index + 1, { tokens: 100 })),
    node(31, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 }),
    ...Array.from({ length: 30 }, (_, index) => node(index + 32, { tokens: 100 })),
  ].map((entry, index) => ({ ...entry, index }));

  const plan = planFold({ nodes, barriers: new Set(), retainTokens: 1000 });
  assert.ok(!("skip" in plan), "expected a plan");
  assert.ok(
    !(plan.startIndex <= 31 && plan.endIndex >= 31),
    `range ${plan.startIndex}..${plan.endIndex} must not contain the second system message at 31`,
  );
});

test("runIsClosed answers which runs can never grow again", () => {
  const nodes = [
    { sourceKind: "system-prompt" },
    { sourceKind: "user" },
    { sourceKind: "assistant" },
    { sourceKind: "skill-catalog" },
    { sourceKind: "user" },
  ];
  const barriers = new Set(["skill-catalog"]);
  assert.equal(runIsClosed(nodes, 2, barriers), true, "a barrier after the range closes it");
  assert.equal(runIsClosed(nodes, 3, barriers), false, "the barrier itself is not after the range");
  assert.equal(runIsClosed(nodes, 4, barriers), false, "the tail run is still open");
  assert.equal(runIsClosed(nodes, 0, new Set()), false, "no barrier anywhere means the run stays open");
});

test("applyNewestBarrierPolicy pins only the newest copy of a barrier kind", () => {
  const barriers = new Set(["skill-catalog", "agent-instructions"]);
  const nodes = [
    { seq: 19, sourceKind: "skill-catalog" },
    { seq: 30, sourceKind: "user" },
    { seq: 863, sourceKind: "skill-catalog" },
    { seq: 900, sourceKind: "agent-instructions" },
    { seq: 6667, sourceKind: "skill-catalog" },
  ];

  applyNewestBarrierPolicy(nodes, barriers);

  assert.equal(nodes[0].barrierOverride, false, "the 19 copy is stale, foldable");
  assert.equal(nodes[2].barrierOverride, false, "the 863 copy is stale, foldable");
  assert.equal(nodes[4].barrierOverride, true, "the 6667 copy is the newest, pinned");
  assert.equal(nodes[3].barrierOverride, true, "a kind with one copy pins that copy");
  assert.equal(nodes[1].barrierOverride, undefined, "non-barrier kinds are left alone");
});

test("isBarrier honours the per-node override", () => {
  const barriers = new Set(["skill-catalog"]);
  assert.equal(isBarrier({ sourceKind: "skill-catalog" }, barriers), true);
  assert.equal(isBarrier({ sourceKind: "skill-catalog", barrierOverride: false }, barriers), false);
  assert.equal(isBarrier({ sourceKind: "user", barrierOverride: true }, barriers), true);
  assert.equal(isBarrier({ type: "system/message", barrierOverride: false }, barriers), true);
});

// -----------------------------------------------------------------------------
// The token budget primitives behind "the tail is an upper bound"
//
// These three functions had no direct coverage: every existing test reached them
// only through `planFold`, so a change to the boundary rule could stay green while
// silently changing what the budget means. They are pinned directly here because
// the 2026-11-03 real-machine review misread exactly this rule — see HANDOFF §5.9.
// -----------------------------------------------------------------------------

test("sumTokens counts an inclusive range and clamps nothing", () => {
  const nodes = surface(5, 100); // header 1000, bodies 5 x 100 -> indices 0..5
  assert.equal(sumTokens(nodes, 0, 0), 1000, "a single node is its own cost");
  assert.equal(sumTokens(nodes, 1, 5), 500, "five body nodes");
  assert.equal(sumTokens(nodes, 0, 5), 1500, "whole surface");
  // An empty range is zero, not an error: callers pass end < start to mean "nothing".
  assert.equal(sumTokens(nodes, 3, 2), 0, "empty range is zero");
  // A missing `tokens` is treated as zero rather than NaN, so one undescribed node
  // cannot poison a budget comparison.
  const withHole = [...nodes];
  withHole[2] = { ...withHole[2], tokens: undefined };
  assert.equal(sumTokens(withHole, 1, 3), 200, "undefined tokens count as zero");
});

test("tailTokens is the whole range from an index to the end", () => {
  const nodes = surface(4, 100); // header 1000 + 4 bodies x 100 = 1400, indices 0..4
  assert.equal(tailTokens(nodes, 0), 1400, "from index 0 is everything");
  assert.equal(tailTokens(nodes, 3), 200, "two body nodes remain");
  assert.equal(tailTokens(nodes, 4), 100, "only the last node");
  // Asking past the end is an empty range, not a crash.
  assert.equal(tailTokens(nodes, 5), 0, "past the end is zero");
});

test("retainedTailStart keeps the tail within budget and honours the floor", () => {
  // 40 body nodes at 100 tok after a 1000-tok header.
  const nodes = surface(40, 100);

  // Budget 1000 buys exactly ten nodes; the header alone would exceed it, so the
  // start is index 31 (indices 31..40 are the ten retained nodes).
  assert.equal(retainedTailStart(nodes, 1000, 1), 31, "exactly-fills the budget");

  // The floor is a hard lower bound on the returned index: a budget larger than the
  // whole surface still cannot walk past it. It does not mean "retain at least the
  // floor" — zero budget returns the end even when the floor is 1.
  assert.equal(retainedTailStart(nodes, 1_000_000, 1), 1, "floor wins over a huge budget");
  assert.equal(retainedTailStart(nodes, 0, 1), 41, "zero budget retains nothing");

  // A floor past the end would be an out-of-range index, so it clamps to the end.
  // (The real caller passes 1; this pins the guard rather than the common path.)
  assert.equal(retainedTailStart(nodes, 0, 30), 41, "floor past zero budget clamps to the end");
  assert.equal(retainedTailStart(nodes, 1_000_000, 30), 30, "a huge budget stops at the floor");

  // Floor 0 is legal for diagnostics and includes the header.
  assert.equal(retainedTailStart(nodes, 1_000_000, 0), 0, "floor 0 includes index 0");
});

test("the retained tail is an upper bound: it never exceeds the budget", () => {
  // This is the rule that was misread in review. It is a bound, not a target: the
  // tail is the largest suffix that does not overflow, so it may sit well *below*
  // the budget when the next node is large, and it may land exactly on it.
  const nodes = [
    node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 }),
    node(1, { tokens: 30 }),
    node(2, { tokens: 5000 }),
    node(3, { tokens: 30 }),
  ].map((entry, index) => ({ ...entry, index }));

  for (const budget of [0, 1, 29, 30, 31, 59, 60, 61, 1029, 1030, 1031, 5000, 6060]) {
    const start = retainedTailStart(nodes, budget, 1);
    const kept = tailTokens(nodes, start);
    assert.ok(kept <= budget, `budget ${budget} must not be exceeded, kept ${kept}`);
    // And it is the *largest* such suffix: adding the next node back would overflow.
    if (start > 1) {
      const withNext = tailTokens(nodes, start - 1);
      assert.ok(
        withNext > budget,
        `budget ${budget}: start ${start} is not maximal, ${withNext} would still fit`,
      );
    }
  }
});

test("the retained tail stops at the first node that would overflow, not at the first hole", () => {
  // A fold walks backwards from the tail; it does not skip a large node to reach a
  // small one behind it. Skipping would reorder history, which the replace channel
  // cannot express (a replace is contiguous).
  const nodes = [
    node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 }),
    node(1, { tokens: 10 }),
    node(2, { tokens: 900 }),
    node(3, { tokens: 10 }),
  ].map((entry, index) => ({ ...entry, index }));

  // Budget 20: the trailing 10 fits, the 900 behind it does not, so the start is 3
  // even though node 1 (10 tok) would also have fit.
  assert.equal(retainedTailStart(nodes, 20, 1), 3, "stops at the overflow, does not skip it");
});

// --- P0 regression: a fold must never swallow the current human turn (2026-11-05) ---
//
// Live incident `bb7dc00b` (HANDOFF §5.15): a 39,542-char / 14,358-tok tool result
// landed in one step, its single node exceeded `retainTokens` (12,000), so
// `retainedTailStart` stopped *before* it and the fold range `[.., 617]` engulfed the
// current question (seq 614). The model then saw no user message at all and answered
// as if the session had just resumed. These tests pin the fix: a fold range may never
// include the last `source.kind === "user"` node at plan time.

/**
 * Build the bb7d shape: a long history, then within the current turn a short question,
 * a tool call, and a giant tool result whose single node overflows the retain budget.
 * @returns {{nodes: object[], questionIndex: number}} surface plus the question index.
 */
function giantResultSurface() {
  const nodes = [node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 })];
  // 35 history nodes, 1500 tok each = 52,500 tok, all foldable.
  for (let i = 0; i < 35; i += 1) nodes.push(node(i + 1, { tokens: 1500 }));
  // Current turn: question (8 chars -> 14 tok), tool call, giant result (14,358 tok).
  const questionIndex = nodes.length;
  nodes.push(node(100, { sourceKind: "user", tokens: 14 }));
  nodes.push(node(101, { type: "assistant/message", sourceKind: "model", toolCallDelta: 1, tokens: 12 }));
  nodes.push(node(102, { type: "tool/result", sourceKind: "tool", toolCallDelta: -1, tokens: 14358 }));
  return { nodes: nodes.map((entry, index) => ({ ...entry, index })), questionIndex };
}

test("P0 regression: a fold never swallows the current human question (giant tool result)", () => {
  const { nodes, questionIndex } = giantResultSurface();
  const plan = planFold({ nodes, barriers: BARRIERS, retainTokens: 12000 });
  assert.ok(!("skip" in plan), `expected a fold, got skip ${plan.skip}`);
  // The bug: endIndex was 37-ish and covered the question. The fix: never past the question.
  assert.ok(
    plan.endIndex < questionIndex,
    `fold end ${plan.endIndex} must stay before the question at ${questionIndex}`,
  );
  // And the question is therefore in the retained tail, not shadowed.
  assert.ok(plan.startIndex <= questionIndex, "range must start at or before the question");
});

test("P0 regression: multi-turn history with a late short question still keeps the question", () => {
  // Same failure mode but with several prior human turns; only the *last* one is
  // protected, earlier ones remain foldable (the whole point is to fold history).
  const nodes = [node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 })];
  for (let i = 0; i < 30; i += 1) nodes.push(node(i + 1, { tokens: 1500 }));
  nodes.push(node(200, { sourceKind: "user", tokens: 20 })); // an older human turn
  for (let i = 0; i < 5; i += 1) nodes.push(node(201 + i, { tokens: 1500 }));
  const lastQuestionIndex = nodes.length;
  nodes.push(node(300, { sourceKind: "user", tokens: 14 }));
  nodes.push(node(301, { type: "assistant/message", sourceKind: "model", toolCallDelta: 1, tokens: 12 }));
  nodes.push(node(302, { type: "tool/result", sourceKind: "tool", toolCallDelta: -1, tokens: 14000 }));
  const described = nodes.map((entry, index) => ({ ...entry, index }));

  const plan = planFold({ nodes: described, barriers: BARRIERS, retainTokens: 12000 });
  assert.ok(!("skip" in plan), `expected a fold, got skip ${plan.skip}`);
  assert.ok(plan.endIndex < lastQuestionIndex, `end ${plan.endIndex} must precede last question ${lastQuestionIndex}`);
  // The older human turn (index 31) is allowed to be folded — history folding still works.
  assert.ok(plan.startIndex <= 31, "older history must remain foldable");
});

test("P0 regression: a giant result with no later human still folds normally", () => {
  // Guard against over-correcting: if the last human is far behind, the giant result
  // and the material after it must still be foldable (we only protect the *last* human).
  const { nodes } = giantResultSurface();
  // Append a second giant tool result *after* the question's turn with no human after it.
  nodes.push(node(400, { type: "tool/result", sourceKind: "tool", toolCallDelta: -1, tokens: 14000 }));
  const described = nodes.map((entry, index) => ({ ...entry, index }));
  const plan = planFold({ nodes: described, barriers: BARRIERS, retainTokens: 12000 });
  assert.ok(!("skip" in plan), `expected a fold, got skip ${plan.skip}`);
  // The fold still happens and still covers a substantial range.
  assert.ok(plan.endIndex - plan.startIndex + 1 >= 2, "a real fold must still occur");
});

// --- ② upgraded: evict an oversized node that is blocking the retained tail ---
//
// ① protects the question, but leaves the giant node *in* the retained tail: the
// question survives, yet a single 14,358-tok node sits in the verbatim window on every
// later request, crowding out real recent context. The right fix is to fold the giant
// node itself (into a small summary) so the tail budget is spent on useful material and
// the question is not even near the boundary.
//
// This is NOT the same as "protect the human" — it is "spend the tail on many small
// recent nodes rather than one giant one". A node whose price alone is >= the retain
// budget is `oversized`; it is excluded from the retained tail so the tail can reach
// back to real recent context, and folding it never crosses the human bound (① still
// applies as the hard backstop).

test("② a giant result behind the newest human is folded on the NEXT turn (self-healing)", () => {
  // ② as originally scoped ("evict the giant while keeping the question") is physically
  // impossible when the giant arrives *after* the question: a replace is contiguous, so
  // any fold reaching the giant also reaches the question. The real property that makes
  // ① sufficient is self-healing: the giant is resident only for the rest of the turn in
  // which it arrives; once a newer human message exists, the giant is behind it and the
  // fold can cover it without touching the current question.
  const build = (withNextTurn) => {
    const nodes = [node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 })];
    for (let i = 0; i < 40; i += 1) nodes.push(node(i + 1, { tokens: 1000 }));
    nodes.push(node(200, { sourceKind: "user", tokens: 20 })); // turn N question
    nodes.push(node(201, { type: "assistant/message", sourceKind: "model", toolCallDelta: 1, tokens: 15 }));
    nodes.push(node(202, { type: "tool/result", sourceKind: "tool", toolCallDelta: -1, tokens: 20000 })); // giant
    if (withNextTurn) {
      nodes.push(node(300, { sourceKind: "user", tokens: 20 })); // turn N+1 question
    }
    return nodes.map((entry, index) => ({ ...entry, index }));
  };

  // Turn N: the giant arrived after the only human. ① must NOT fold the question, so the
  // fold stops before it and the giant stays resident this turn — unavoidable, and correct.
  const sameTurn = planFold({ nodes: build(false), barriers: BARRIERS, retainTokens: 12000 });
  assert.ok(!("skip" in sameTurn), `same turn: expected a fold, got skip ${sameTurn.skip}`);
  const sameTurnGiantIdx = 43;
  assert.ok(
    sameTurn.endIndex < sameTurnGiantIdx,
    `same turn: fold must stop before the giant (end ${sameTurn.endIndex}), question protected`,
  );

  // Turn N+1: a newer human exists at index 44, so the giant (43) is now behind it and
  // the fold reaches it — self-healed, no special eviction code required.
  const nextTurn = planFold({ nodes: build(true), barriers: BARRIERS, retainTokens: 12000 });
  assert.ok(!("skip" in nextTurn), `next turn: expected a fold, got skip ${nextTurn.skip}`);
  assert.ok(
    nextTurn.endIndex >= sameTurnGiantIdx,
    `next turn: fold must now cover the giant at ${sameTurnGiantIdx} (end ${nextTurn.endIndex})`,
  );
  // And the new question (index 44) is still protected by ①.
  assert.ok(nextTurn.endIndex < 44, `next turn: newest question at 44 must remain visible (end ${nextTurn.endIndex})`);
});

test("② a giant result BEFORE the newest human is folded in the same pass", () => {
  // The useful half of the original ②: a giant in an *earlier* part of the current turn,
  // ahead of the newest human, folds normally without any special handling — this pins
  // that ① did not accidentally lock such giants in place.
  const nodes = [node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 })];
  for (let i = 0; i < 40; i += 1) nodes.push(node(i + 1, { tokens: 1000 }));
  nodes.push(node(200, { sourceKind: "user", tokens: 20 })); // turn N-1 question
  nodes.push(node(201, { type: "assistant/message", sourceKind: "model", toolCallDelta: 1, tokens: 15 }));
  nodes.push(node(202, { type: "tool/result", sourceKind: "tool", toolCallDelta: -1, tokens: 20000 })); // giant, idx 43
  nodes.push(node(300, { sourceKind: "user", tokens: 20 })); // turn N question, idx 44
  const described = nodes.map((entry, index) => ({ ...entry, index }));
  const plan = planFold({ nodes: described, barriers: BARRIERS, retainTokens: 12000 });
  assert.ok(!("skip" in plan), `expected a fold, got skip ${plan.skip}`);
  assert.ok(plan.endIndex >= 43, `giant at 43 must be folded (end ${plan.endIndex})`);
  assert.ok(plan.endIndex < 44, `newest human at 44 must remain visible (end ${plan.endIndex})`);
});

test("② does not evict a node smaller than the retain budget", () => {
  // Guard the normal path: a 3,000-tok node (< 12,000 budget) must still bound the tail
  // exactly as before, so small sessions keep their current folding behaviour.
  const nodes = [node(0, { type: "system/message", sourceKind: "system-prompt", tokens: 1000 })];
  for (let i = 0; i < 20; i += 1) nodes.push(node(i + 1, { tokens: 1000 }));
  nodes.push(node(300, { type: "tool/result", sourceKind: "tool", toolCallDelta: -1, tokens: 3000 }));
  nodes.push(node(301, { sourceKind: "user", tokens: 20 }));
  const described = nodes.map((entry, index) => ({ ...entry, index }));
  const plan = planFold({ nodes: described, barriers: BARRIERS, retainTokens: 12000 });
  if (!("skip" in plan)) {
    assert.ok(plan.endIndex < 20, `end ${plan.endIndex} must not include the 3,000-tok node at 20`);
  }
});
