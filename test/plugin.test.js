/**
 * Pipeline integration test against a fake session.
 *
 * The unit tests pin each module's contract; this one pins the *append sequence*,
 * which is the part the session layer either accepts or rejects wholesale. The fake
 * session enforces the two rules that matter most — every shadowed surface node must
 * be cited, and node 0 must never be inside a replace — so a regression surfaces
 * here instead of as a refused step in a live session.
 *
 * This imports `pipeline.js` rather than `index.js` on purpose: the plugin entry
 * needs schemastery and `dsh-tools`, which only resolve inside a running profile,
 * and an append contract that can only be tested in production is not tested.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assignTurns,
  captureSelfNodes,
  createFilters,
  createStats,
  foldIfNeeded,
  publishSelf,
} from "../lib/pipeline.js";
import { FOLD_SKIP } from "../lib/fold.js";

const CONFIG = {
  retainTokens: 120,
  volatileBudget: 1500,
  minNodesToFold: 2,
  admitKinds: ["user", "agent-message", "goal"],
  barrierKinds: ["skill-catalog", "agent-instructions"],
  selfEnabled: true,
  verbose: false,
};

/**
 * A session double that enforces the surface contract on every append.
 * @returns {{session: object, events: object[], nodes: object[]}} session double.
 */
function fakeSession() {
  const events = [];
  const nodes = [];

  const session = {
    get surface() {
      return { nodes };
    },
    // v2 distillation reads the routed provider/model from here, like the LLM service
    // itself does. A fake session without it would make every v2 test fail for a
    // reason that has nothing to do with the code under test.
    requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }),
    eventAt: (seq) => events[seq] ?? null,
    deriveEventMessage(event) {
      if (event.type === "user/message") return event.data;
      if (event.type === "system/message") return event.data.message;
      if (event.type === "assistant/message") return event.data.message;
      if (event.type === "tool/result") return event.data.message;
      return null;
    },
    /**
     * Append an event and apply its surface op, rejecting illegal ones.
     * @param {string} type - event type.
     * @param {object} data - payload.
     * @param {object} [intent] - surface intent.
     * @returns {object} the event.
     */
    append(type, data, intent) {
      const seq = events.length;
      const event = { seq, type, data };
      events.push(event);
      const op = intent?.surfaceOp;
      // Nodes are bare sequence numbers, exactly as `dsh-session` stores them
      // (`applySurfacePlan` pushes `plan.seq`). An earlier version of this double
      // pushed `{seq, type}` and so was *more* generous than production: it hid a
      // bug where every surface read returned `undefined` and the plugin folded
      // nothing while publishing nine copies of the self tree.
      if (op === "append") {
        nodes.push(seq);
        return event;
      }
      if (op && op.op === "replace") {
        const startIndex = nodes.indexOf(op.startSeq);
        const endIndex = nodes.indexOf(op.endSeq);
        assert.notEqual(startIndex, -1, `startSeq ${op.startSeq} must be in the surface`);
        assert.notEqual(endIndex, -1, `endSeq ${op.endSeq} must be in the surface`);
        assert.ok(startIndex >= 1, "node 0 holds the system prompt and may not be replaced");
        assert.ok(startIndex <= endIndex, "start must not follow end");

        const shadowed = nodes.slice(startIndex, endIndex + 1);

        // A live A-group run corrupted its own log by folding the system prompt.
        // `startIndex >= 1` was not enough: the plugin had published `memory:self`
        // at index 0, so index 1 *was* the system prompt. The real invariant is
        // about the node's type, not its position.
        for (const seq of shadowed) {
          assert.notEqual(
            events[seq].type,
            "system/message",
            `a fold must never shadow the system message at seq ${seq}`,
          );
        }

        const cited = intent.sourceEventSeqs ?? [];
        for (const seq of shadowed) {
          assert.ok(cited.includes(seq), `sourceEventSeqs must include every shadowed node: missing ${seq}`);
        }
        assert.equal(new Set(cited).size, cited.length, "sourceEventSeqs must not repeat");
        for (const seq of cited) assert.ok(seq < event.seq, "cited seqs must be earlier events");

        nodes.splice(startIndex, endIndex - startIndex + 1, seq);
        return event;
      }
      return event;
    },
  };

  return { session, events, nodes };
}

/**
 * Build a message payload.
 * @param {string} text - body text.
 * @param {string} [kind] - `source.kind`.
 * @returns {object} user message.
 */
function said(text, kind = "user") {
  return { id: `m-${text}`, role: "user", content: [{ type: "text", text }], source: { kind } };
}

/**
 * Append one full turn.
 * @param {object} session - fake session.
 * @param {number} turn - turn number.
 * @returns {void}
 */
function appendTurn(session, turn) {
  session.append("turn/start", { turn });
  session.append("user/message", said(`request ${turn} with enough words to cost tokens`), {
    surfaceOp: "append",
  });
  session.append(
    "assistant/message",
    {
      message: {
        id: `a${turn}`,
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn} which is also long enough to matter` }],
        source: { kind: "model", provider: "p", model: "m" },
      },
    },
    { surfaceOp: "append" },
  );
}

/**
 * Seed a session with a system prompt and `count` turns.
 * @param {object} session - fake session.
 * @param {number} count - turns.
 * @param {number} [from] - first turn number.
 * @returns {void}
 */
function seed(session, count, from = 1) {
  if (from === 1) {
    session.append(
      "system/message",
      {
        message: {
          id: "sys",
          role: "system",
          content: [{ type: "text", text: "system prompt" }],
          source: { kind: "system-prompt" },
        },
      },
      { surfaceOp: "append" },
    );
  }
  for (let turn = from; turn < from + count; turn += 1) appendTurn(session, turn);
}

/**
 * Run one step against a session.
 * @param {object} session - fake session.
 * @param {object} stats - counters.
 * @returns {void}
 */
async function step(session, stats, overrides = {}, deps = {}) {
  const config = { ...CONFIG, ...overrides };
  const filters = createFilters(config);
  const agent = { session };
  const selfNodes = config.selfEnabled ? captureSelfNodes(agent) : null;
  // Isolation default: unless a test injects its own reader, `publishSelf` must NOT
  // read the real `~/.dsh/storages/dsh_memory_self.json`. Previously `deps` reached
  // `foldIfNeeded` but never `publishSelf`, so the default store reader ran and the
  // suite silently depended on whatever the developer last saved in Settings — a
  // "the edit must change the visible text" assertion compared against the live
  // store and collapsed to a no-op. An explicit `deps.loadOverride` still wins.
  const selfDeps = { loadOverride: () => null, ...deps };
  await foldIfNeeded(agent, undefined, { ...filters, config, stats, ...deps });
  if (config.selfEnabled) publishSelf(agent, stats, selfNodes, selfDeps);
}

/**
 * A stand-in for `ctx.llm` that records calls and replays a fixed answer.
 * @param {string|(() => string)} answer - text to stream, or a thunk that may throw.
 * @returns {object} fake llm service.
 */
function fakeLlm(answer) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* generate() {
        const text = typeof answer === "function" ? answer() : answer;
        yield { type: "text-delta", index: 0, text };
        yield { type: "finish", reason: "stop" };
      })();
    },
  };
}

/**
 * Read every visible message of a surface.
 * @param {object} session - fake session.
 * @returns {object[]} messages.
 */
function visible(session) {
  return session.surface.nodes
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter(Boolean);
}

test("publishes exactly one self message on the first step", async () => {
  const { session, events } = fakeSession();
  seed(session, 4);
  await step(session, createStats());

  const selfs = visible(session).filter((message) => message.source?.kind === "memory:self");
  assert.equal(selfs.length, 1, "a session must never hold two self copies");
  assert.equal(events[session.surface.nodes.at(-1)].type, "user/message", "self belongs at the tail");
});

test("does not republish an unchanged self tree", async () => {
  const { session, events } = fakeSession();
  seed(session, 4);
  const stats = createStats();
  // A realistic window, so nothing folds and the only thing that could churn the
  // surface is the self tree itself.
  await step(session, stats, { retainTokens: 10_000 });
  const afterFirst = events.length;

  await step(session, stats, { retainTokens: 10_000 });
  const republished = events
    .slice(afterFirst)
    .filter((event) => event.data?.source?.kind === "memory:self");
  assert.deepEqual(republished, [], "an unchanged tree must not churn the surface");
  assert.equal(stats.selfPublished, 1);
  assert.equal(stats.selfReplaced, 0);
});

test("a changed self tree replaces its own copy instead of appending", async () => {
  const { session } = fakeSession();
  seed(session, 4);
  const stats = createStats();
  await step(session, stats);

  const before = visible(session).find((message) => message?.source?.kind === "memory:self");
  const target = session.surface.nodes.find((seq) => {
    const message = session.deriveEventMessage(session.eventAt(seq));
    return message?.source?.kind === "memory:self";
  });
  const original = session.deriveEventMessage(session.eventAt(target));
  const edited = {
    ...original,
    content: [{ type: "text", text: '<memory zone="self">\n- 改过的身份\n</memory>' }],
    source: { ...original.source, nodes: [{ ...original.source.nodes[0], title: "改过的身份" }] },
  };
  session.append("user/message", edited, {
    surfaceOp: { op: "replace", startSeq: target, endSeq: target },
    sourceEventSeqs: [target],
  });

  await step(session, stats);
  const selfs = visible(session).filter((message) => message.source?.kind === "memory:self");
  assert.equal(selfs.length, 1, "replacing must not duplicate the tree");
  assert.notDeepEqual(
    selfs[0].content[0].text,
    before.content[0].text,
    "the committed edit must be what ends up visible",
  );
  assert.equal(selfs[0].source.nodes[0].title, "改过的身份", "the edit must survive the step");
});

test("a fold cites every shadowed node and never touches node 0", async () => {
  const { session, events } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  await step(session, stats);

  assert.ok(stats.folds >= 1, "expected a fold on eight turns with a 120-token window");
  assert.equal(events[session.surface.nodes[0]].type, "system/message", "the system prompt survives");
});

// Regression (v10 seqRange): a SECOND fold begins at the checkpoint the first fold left
// in the surface. Its seq is the newest event of the first batch, so `plan.startSeq`
// points AT the carried checkpoint (a summary), not at any original event. Recording
// `[plan.startSeq, plan.endSeq]` therefore produced `sources[].seqRange` that was either
// inverted (`[26822, 26812]`) or aimed `memory_fetch` at a `<memory>` block instead of
// the primary record. The span must be the min/max seq of the shadowed *content* nodes.
test("a second fold anchors seqRange on real content, never on the carried checkpoint", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const checkpointSeq = () =>
    session.surface.nodes.find(
      (seq) => session.deriveEventMessage(session.eventAt(seq))?.source?.kind === "memory",
    );

  await step(session, stats); // fold 1 — no prior checkpoint, so its seqRange is honest
  const first = checkpointSeq();
  assert.ok(typeof first === "number", "the first fold must leave a checkpoint");

  // Append more material so a second fold happens. The first checkpoint now sits at the
  // head of the foldable run — exactly the condition that produced the bad span.
  seed(session, 8, 9);
  await step(session, stats);
  assert.ok(stats.folds >= 2, "expected a second fold to run");

  const second = checkpointSeq();
  assert.notEqual(second, first, "the second fold must publish a new checkpoint");
  const checkpoint = session.deriveEventMessage(session.eventAt(second));
  const ranges = checkpoint.source.nodes
    .filter((node) => Array.isArray(node.seqRange))
    .map((node) => node.seqRange);
  assert.ok(ranges.length > 0, "distilled nodes must carry the event span");

  for (const [start, end] of ranges) {
    assert.ok(start <= end, `seqRange must not be inverted: [${start}, ${end}]`);
    assert.notEqual(start, first, `seqRange start must not be the carried checkpoint ${first}`);
    const message = session.deriveEventMessage(session.eventAt(start));
    assert.notEqual(
      message?.source?.kind,
      "memory",
      `seqRange start ${start} must be a real event, not a checkpoint summary`,
    );
  }
});

test("the checkpoint carries the tree so a resume can rebuild it", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  await step(session, createStats());

  const checkpoint = visible(session).find((message) => message?.source?.kind === "memory");
  assert.ok(Array.isArray(checkpoint.source.nodes), "nodes must ride on source");
  assert.ok(checkpoint.source.nodes.length > 0);
  for (const node of checkpoint.source.nodes) {
    assert.equal(typeof node.title, "string");
    assert.ok(node.id.length > 0);
  }
  assert.ok(checkpoint.content[0].text.includes('<memory zone="volatile">'));
});

test("the checkpoint keeps the human's words verbatim", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  await step(session, createStats());

  const checkpoint = visible(session).find((message) => message?.source?.kind === "memory");
  const tasks = checkpoint.source.nodes.filter((node) => node.kind === "task");
  assert.ok(tasks.length > 0, "user messages must survive folding as task nodes");
  assert.ok(
    tasks.some((node) => node.title.includes("request 1")),
    "the earliest request must still be readable after folding",
  );
});

test("a second fold builds on the previous checkpoint instead of restating it", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  await step(session, stats);
  const firstFold = stats.folds;

  seed(session, 8, 9);
  await step(session, stats);
  assert.ok(stats.folds > firstFold, "the second step folds again once the tail grows");

  const checkpoint = visible(session)
    .filter((message) => message?.source?.kind === "memory")
    .pop();
  const ids = checkpoint.source.nodes.map((node) => node.id);
  assert.ok(ids.length > 0);
  assert.ok(
    checkpoint.source.nodes.some((node) => node.kind === "task"),
    "carried task nodes must survive into the new checkpoint",
  );
});

test("the checkpoint records the turns it covers", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  await step(session, createStats());

  const checkpoint = visible(session).find((message) => message?.source?.kind === "memory");
  assert.ok(Array.isArray(checkpoint.source.coveredTurns), "coverage must ride on source");
  assert.equal(checkpoint.source.coveredTurns.length, 2);
  assert.ok(checkpoint.source.coveredTurns[0] >= 1, "coverage starts at a real turn");
  assert.ok(
    checkpoint.source.coveredTurns[1] >= checkpoint.source.coveredTurns[0],
    "coverage is an inclusive range",
  );
});

test("a carried checkpoint keeps the turns it already covered", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  await step(session, stats);
  const first = visible(session).find((message) => message?.source?.kind === "memory").source.coveredTurns;

  seed(session, 8, 9);
  await step(session, stats);
  const second = visible(session)
    .filter((message) => message?.source?.kind === "memory")
    .pop().source.coveredTurns;

  assert.equal(second[0], first[0], "coverage must not shrink when the tree is carried forward");
  assert.ok(second[1] >= first[1], "coverage must extend to the newly folded turns");
});

test("foldMinTurnGap stops a long turn folding on every step", async () => {
  // One turn that appends tool results re-crosses retainTokens on each step. Without a
  // gap the pipeline folds — and under v2 re-distils — on every one of those steps; the
  // live run folded a single turn 19 times. With gap=1 the turn folds once and later
  // steps are declined under the cooldown reason instead of re-folding the same range.
  const { session } = fakeSession();
  seed(session, 4);
  const stats = createStats();
  await step(session, stats, { retainTokens: 60, foldMinTurnGap: 1 });
  assert.equal(stats.folds, 1, "the first fold of the turn is allowed");
  const foldsAfterFirst = stats.folds;

  // Same turn, more material appended: budget is crossed again, but the cooldown holds.
  session.append("assistant/message", {
    message: {
      id: "same-turn-more",
      role: "assistant",
      content: [{ type: "text", text: "answer padding that is long enough to cost real tokens here" }],
      source: { kind: "model", provider: "p", model: "m" },
    },
  }, { surfaceOp: "append" });
  await step(session, stats, { retainTokens: 60, foldMinTurnGap: 1 });

  assert.equal(stats.folds, foldsAfterFirst, "the same turn must not fold a second time");
  assert.ok((stats.skipped[FOLD_SKIP.cooldown] ?? 0) >= 1, "the decline is counted as cooldown, not silently dropped");
});

test("foldMinTurnGap 0 keeps the per-step behaviour", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  await step(session, stats, { foldMinTurnGap: 0 });
  assert.ok(stats.folds >= 1);
  assert.equal(stats.skipped[FOLD_SKIP.cooldown] ?? 0, 0, "gap 0 must never record a cooldown skip");
});

test("a memory block states its span and that the later block wins", async () => {
  // Two blocks can be visible at once (one sealed behind a barrier, one rolling).
  // They used to render identically, so a stale value in the sealed block was
  // indistinguishable from current memory. The block must say which turns it covers
  // and which one the reader should trust when they disagree.
  const { session } = fakeSession();
  seed(session, 8);
  await step(session, createStats());

  const text = visible(session).find((message) => message?.source?.kind === "memory").content[0].text;
  assert.ok(/第 \d+–\d+ 轮/.test(text), `the block must name its turns, got: ${text.slice(0, 160)}`);
  assert.ok(text.includes("以更晚的块为准"), "the block must state the precedence rule");
});

test("assignTurns survives a surface that is not ascending by seq", async () => {
  // The regression this guards: a fold splices a high-seq checkpoint into an early
  // slot, so the surface runs 20, 1, 2, 11. Walking seq upwards and matching
  // `described[cursor]` in order stopped at the checkpoint and left every later node
  // unlabelled — every distilled episode came out titled `T0`, and `latestTurn` was
  // pinned to 0, which silently disabled the aging rule in `mergeNodes`.
  const events = new Map([
    [0, { type: "system/message" }],
    [1, { type: "turn/start", data: { turn: 1 } }],
    [2, { type: "user/message" }],
    [10, { type: "turn/start", data: { turn: 2 } }],
    [11, { type: "user/message" }],
    [20, { type: "turn/start", data: { turn: 3 } }],
  ]);
  const session = { eventAt: (seq) => events.get(seq) ?? null };
  const described = [{ seq: 20 }, { seq: 1 }, { seq: 2 }, { seq: 11 }];

  assignTurns(session, described);

  assert.equal(described[0].turn, 3, "the spliced checkpoint keeps its own turn");
  assert.equal(described[1].turn, 1);
  assert.equal(described[2].turn, 1, "nodes after the checkpoint must still be labelled");
  assert.equal(described[3].turn, 2);
});

test("a fold that seals a run behind a barrier says so", async () => {
  // Reproduces the real shape: many messages, then a skill catalog, then one turn.
  // A 60-token window puts the post-barrier turn inside the retained tail, so the
  // only foldable run is the one before the catalog — and that run is closed.
  const { session } = fakeSession();
  seed(session, 10);
  session.append("user/message", said("A skill is a reusable set", "skill-catalog"), {
    surfaceOp: "append",
  });
  appendTurn(session, 11);

  await step(session, createStats(), { retainTokens: 60 });

  const blocks = visible(session).filter((message) => message?.source?.kind === "memory");
  assert.ok(blocks.length >= 1, "expected a fold");
  const sealed = blocks.filter((block) => block.source.sealed === true);
  assert.equal(sealed.length, 1, "the pre-barrier fold must be marked sealed");
  assert.ok(/第 \d+–\d+ 轮/.test(sealed[0].content[0].text), "a sealed block still names its turns");
  assert.ok(sealed[0].content[0].text.includes("封存"), "the model must be told this one is frozen");
  assert.ok(
    sealed[0].content[0].text.includes("以更晚的为准"),
    "and which block wins when they disagree",
  );
});

test("a stale duplicate catalog is folded away while the newest stays", async () => {
  // Two catalog copies in one session. The surface-aware plugins dedup by scanning
  // backwards for the newest *visible* copy, so the older one is dead weight: pinning
  // it costs its full size and buys nothing. `barrierPolicy: "newest"` lets the fold
  // take it; `"all"` (the pre-2026-11-02 behaviour) keeps both.
  const build = () => {
    const { session } = fakeSession();
    seed(session, 6);
    session.append("user/message", said("OLD catalog v1", "skill-catalog"), { surfaceOp: "append" });
    seed(session, 6, 7);
    session.append("user/message", said("NEW catalog v2", "skill-catalog"), { surfaceOp: "append" });
    seed(session, 6, 13);
    return { session };
  };

  const newest = build();
  const newestStats = createStats();
  await step(newest.session, newestStats);
  const newestCatalogs = visible(newest.session).filter((m) => m?.source?.kind === "skill-catalog");

  assert.ok(newestStats.folds >= 1, "expected a fold with a 120-token window");
  assert.equal(newestCatalogs.length, 1, "only the newest catalog may survive");
  assert.equal(
    newestCatalogs[0].content[0].text,
    "NEW catalog v2",
    "and the survivor must be the newest copy, not the stale one",
  );

  const all = build();
  await step(all.session, createStats(), { barrierPolicy: "all" });
  const allCatalogs = visible(all.session).filter((m) => m?.source?.kind === "skill-catalog");
  assert.equal(allCatalogs.length, 2, 'barrierPolicy: "all" must pin every copy (rollback path)');
});

test("a skill catalog barrier is never folded away", async () => {
  const { session } = fakeSession();
  seed(session, 3);
  session.append("user/message", said("A skill is a reusable set", "skill-catalog"), {
    surfaceOp: "append",
  });
  seed(session, 7, 4);

  const stats = createStats();
  await step(session, stats);

  const catalogVisible = visible(session).some((message) => message.source?.kind === "skill-catalog");
  assert.ok(catalogVisible, "the catalog must remain visible after a fold");
  assert.ok(stats.folds >= 1);
});

test("a stalled fold leaves the history untouched", async () => {
  const { session, events } = fakeSession();
  seed(session, 2);
  const stats = createStats();
  // A window far larger than this history: nothing is over budget yet.
  await step(session, stats, { retainTokens: 10_000 });

  const replaces = events.filter((event) => event.surfaceOp && event.surfaceOp !== "append");
  assert.deepEqual(replaces, [], "nothing to fold means no replace at all");
  assert.equal(stats.folds, 0);
});

test("a long session keeps folding instead of stalling on a barrier", async () => {
  // The regression this guards: with `memory:self` marked as a barrier, its copy
  // sat behind the first checkpoint and inside every later fold range, so the
  // planner could only ever cover the checkpoint itself and skipped forever.
  const { session } = fakeSession();
  const stats = createStats();
  seed(session, 4);
  await step(session, stats);

  for (let round = 0; round < 6; round += 1) {
    seed(session, 4, 5 + round * 4);
    await step(session, stats);
  }

  assert.ok(stats.folds >= 5, `expected repeated folds, got ${stats.folds}`);
  assert.equal(
    visible(session).filter((message) => message.source?.kind === "memory:self").length,
    1,
    "exactly one self copy must survive repeated folds",
  );
});

test("the surface stays bounded as the same session keeps growing", async () => {
  // The whole point of the design: the surface must not grow with the transcript.
  const { session } = fakeSession();
  const stats = createStats();
  seed(session, 6);
  await step(session, stats);
  const early = session.surface.nodes.length;

  seed(session, 30, 7);
  await step(session, stats);
  const late = session.surface.nodes.length;

  assert.ok(late < early + 30 * 3, `surface grew to ${late} nodes, expected a bounded size`);
  assert.ok(stats.folds >= 2);
});

// --- v2: threshold-gated model distillation -------------------------------------------------

test("v2 never asks the model when distillation is off", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm('[{"kind":"decision","title":"t","body":"b"}]');

  await step(session, stats, {}, { llm });

  assert.equal(llm.calls.length, 0, "distillPolicy defaults to rules");
  assert.equal(stats.llmRequested, 0);
  assert.ok(stats.folds >= 1);
});

test("v2 skips the model for a fold smaller than llmMinSpan", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm('[{"kind":"decision","title":"t","body":"b"}]');

  await step(session, stats, { distillPolicy: "llm", llmMinSpan: 10_000_000 }, { llm });

  assert.equal(llm.calls.length, 0, "a small fold must not cost a request");
  assert.equal(stats.llmRequested, 0);
  assert.ok(stats.folds >= 1, "the fold still happens, by rules");
});

test("v2 uses the model's nodes when it answers with valid JSON", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm('```json\n[{"kind":"decision","title":"picked 8080","body":"because 80 was taken"}]\n```');

  await step(session, stats, { distillPolicy: "llm", llmMinSpan: 1 }, { llm });

  assert.equal(llm.calls.length, 1);
  assert.equal(stats.llmUsed, 1);
  assert.equal(stats.llmFailed, 0);
  assert.equal(llm.calls[0].purpose, undefined, "purpose must be omitted: the service only types compaction/session-title");
  assert.equal(llm.calls[0].provider, "test-provider");
  assert.deepEqual(llm.calls[0].toolHistory, [], "distillation must not be able to act");

  const checkpoint = visible(session).find((message) => message?.source?.kind === "memory");
  const bodies = checkpoint.source.nodes.map((node) => node.body);
  assert.ok(bodies.some((body) => body.includes("because 80 was taken")), "the model's body survives");
});

test("v2 falls back to rules when the model throws", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm(() => {
    throw new Error("provider exploded");
  });

  await step(session, stats, { distillPolicy: "llm", llmMinSpan: 1 }, { llm });

  assert.equal(stats.llmRequested, 1);
  assert.equal(stats.llmUsed, 0);
  assert.equal(stats.llmFailed, 1, "the fallback must be counted, not silent");
  assert.ok(stats.folds >= 1, "a failed model call must never cost the fold");
});

test("v2 falls back to rules when the model answers garbage", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm("I could not do that, sorry.");

  await step(session, stats, { distillPolicy: "llm", llmMinSpan: 1 }, { llm });

  assert.equal(stats.llmFailed, 1);
  assert.equal(stats.llmUsed, 0);
  assert.ok(stats.folds >= 1);
});

test("v2 falls back to rules when the model returns an empty patch", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm("[]");

  await step(session, stats, { distillPolicy: "llm", llmMinSpan: 1 }, { llm });

  assert.equal(stats.llmRequested, 1);
  assert.equal(stats.llmUsed, 0, "an empty patch would render an empty block and abort the fold");
  assert.equal(stats.llmFailed, 0, "not a failure — just nothing worth keeping");
  assert.ok(stats.folds >= 1);
});

test("v2 counts rejected patch entries", async () => {
  const { session } = fakeSession();
  seed(session, 8);
  const stats = createStats();
  const llm = fakeLlm(
    '[{"kind":"task","title":"invented user words"},{"kind":"decision","title":"kept","body":"ok"}]',
  );

  await step(session, stats, { distillPolicy: "llm", llmMinSpan: 1 }, { llm });

  assert.equal(stats.llmUsed, 1);
  assert.equal(stats.llmRejected, 1, "a rejected entry is a number, not a silent drop");
  const checkpoint = visible(session).find((message) => message?.source?.kind === "memory");
  assert.ok(!checkpoint.source.nodes.some((node) => node.kind === "task" && node.title.includes("invented")));
});

test("tool-call arguments reach the tool node through a real fold", async () => {
  // End-to-end: arguments ride on the assistant message, output on a later `tool/result`;
  // materialForRange must join them by call id. Put the tool turn EARLY, then pad with
  // more turns so it falls inside the folded range (a tool turn at the tail would be
  // retained verbatim and never distilled).
  const { session } = fakeSession();
  seed(session, 1);
  session.append("turn/start", { turn: 2 });
  session.append("user/message", said("请读文件并跑测试，说明要够长以计入预算"), { surfaceOp: "append" });
  session.append(
    "assistant/message",
    {
      message: {
        id: "a2",
        role: "assistant",
        content: [
          { type: "text", text: "先读再跑，这一步说明也要足够长一些才行" },
          { type: "tool-call", id: "call_A", name: "read", arguments: '{"file_path":"HANDOFF.md"}' },
          { type: "tool-call", id: "call_B", name: "bash", arguments: '{"command":"npm test"}' },
        ],
        source: { kind: "model", provider: "p", model: "m" },
      },
    },
    { surfaceOp: "append" },
  );
  session.append(
    "tool/result",
    { message: { role: "tool", id: "r1", toolCallId: "call_A", toolName: "read", isError: false, content: [{ type: "text", text: "HANDOFF 第一行内容" }] } },
    { surfaceOp: "append" },
  );
  session.append(
    "tool/result",
    { message: { role: "tool", id: "r2", toolCallId: "call_B", toolName: "bash", isError: true, content: [{ type: "text", text: "npm ERR! test failed" }] } },
    { surfaceOp: "append" },
  );
  // Pad with more turns so the tool turn is folded, not retained.
  seed(session, 4, 3);

  const stats = createStats();
  await step(session, stats, { retainTokens: 80 });
  assert.ok(stats.folds >= 1, "the fold must actually run");

  const checkpoints = visible(session).filter((message) => message?.source?.kind === "memory");
  const toolNodes = checkpoints.flatMap((m) => m.source.nodes).filter((node) => /-tool-\d+$/.test(node.id));
  assert.ok(toolNodes.length >= 2, "each tool call is its own node");

  const read = toolNodes.find((node) => node.title.startsWith("read("));
  assert.ok(read, "the read node carries its arguments");
  assert.ok(read.title.includes("HANDOFF.md"), "the path is joined from the tool-call onto the result");
  assert.ok(read.body.includes("HANDOFF 第一行内容"), "the real output is the body");

  const bash = toolNodes.find((node) => node.title.startsWith("bash("));
  assert.ok(bash.title.endsWith("FAILED"), "a failed call is labelled");
  assert.ok(bash.weight > read.weight, "a failure outranks a success");
});

test("currentUserText finds the latest human message and ignores framework injections", async () => {
  const { currentUserText } = await import("../lib/pipeline.js");
  const events = new Map();
  const surface = [];
  const put = (type, data, seq) => { events.set(seq, { seq, type, data }); surface.push(seq); };
  // A skill catalog (framework injection) and a memory checkpoint must never become the query.
  put("user/message", { id: "cat", role: "user", content: [{ type: "text", text: "SKILL CATALOG" }], source: { kind: "skill-catalog" } }, 0);
  put("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "first real request" }], source: { kind: "user" } }, 1);
  put("user/message", { id: "mem", role: "user", content: [{ type: "text", text: "<memory>" }], source: { kind: "memory" } }, 2);
  put("user/message", { id: "u2", role: "user", content: [{ type: "text", text: "second real request" }], source: { kind: "user" } }, 3);
  const session = {
    get surface() { return { nodes: surface }; },
    eventAt: (seq) => events.get(seq) ?? null,
    deriveEventMessage: (event) => event.data,
  };
  assert.equal(currentUserText({ session }), "second real request", "latest human text, not the injection after it");
});

test("currentUserText returns empty when there is no human text yet", async () => {
  const { currentUserText } = await import("../lib/pipeline.js");
  const session = { get surface() { return { nodes: [] }; }, eventAt: () => null, deriveEventMessage: () => null };
  assert.equal(currentUserText({ session }), "");
});

test("makeRecallMessage is a frozen user message tagged memory-recall", async () => {
  const { makeRecallMessage } = await import("../lib/pipeline.js");
  const message = makeRecallMessage('<memory zone="recall">\n- [seq 1] t: x\n</memory>');
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "memory-recall");
  assert.ok(Object.isFrozen(message), "a transient message must not be mutable by later handlers");
  assert.ok(message.content[0].text.includes("zone=\"recall\""));
  // v8 fix: the block MUST carry a frame telling the model it is background memory, not
  // the user's request — otherwise (injected as the last `user` message) the model replies
  // "I don't see an actual request". Guard against a future edit dropping the frame.
  assert.ok(
    message.content[0].text.includes("不是用户的提问"),
    "recall block must state it is NOT the user's request",
  );
});
