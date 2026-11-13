/**
 * Distillation contract tests.
 *
 * The distiller is the only place where session messages become memory, so its two
 * failure modes are the expensive ones: losing the human's own words, and letting a
 * tool payload back in through the side door after the pruner already cut it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { callsOf, distillTurn, excerpt, segmentAnchor } from "../lib/distill.js";
import { MAX_BODY, MAX_TITLE, MAX_NODES_PER_TURN, renderZoneTree, validateNode } from "../lib/tree.js";

/**
 * Build a message with text.
 * @param {string} text - body text.
 * @param {string} [kind] - `source.kind`.
 * @returns {object} message.
 */
function said(text, kind = "user") {
  return { role: "user", content: [{ type: "text", text }], source: { kind } };
}

/**
 * Distil a segment with the given material.
 * @param {object} [overrides] - material overrides.
 * @returns {object[]} nodes.
 */
function build(overrides = {}) {
  return distillTurn({
    segment: "s42",
    turn: 3,
    userMessages: overrides.userMessages ?? [],
    assistantMessages: overrides.assistantMessages ?? [],
    toolResults: overrides.toolResults ?? [],
  });
}

test("excerpt cuts at a sentence end rather than mid-clause", () => {
  const text = "端口是 8080。令牌不要写进日志。后面还有很多内容需要被截掉。";
  const out = excerpt(text, 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith("。"), `expected a sentence end, got ${JSON.stringify(out)}`);
});

test("excerpt collapses whitespace and tolerates short input", () => {
  assert.equal(excerpt("a\n\n  b", 40), "a b");
  assert.equal(excerpt("", 40), "");
  assert.equal(excerpt(undefined, 40), "");
});

test("the human's own words become pinned task nodes in original order", () => {
  const nodes = build({
    userMessages: [said("先读文件"), said("然后改配置")],
  });
  const tasks = nodes.filter((node) => node.kind === "task");
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((node) => node.title), ["先读文件", "然后改配置"]);
  for (const node of tasks) {
    assert.equal(node.pinned, true, "user words are never trimmed");
    assert.equal(node.parentId, "s42");
  }
  assert.deepEqual(tasks.map((node) => node.order), [10, 11]);
});

test("framework injections never become nodes", () => {
  const nodes = build({
    userMessages: [
      said("真的指令"),
      said("<system-reminder>A skill is a reusable set", "skill-catalog"),
      said("群规则", "qqbot:group-rules"),
    ],
  });
  assert.deepEqual(
    nodes.map((node) => node.title),
    ["真的指令"],
  );
});

test("an assistant's prose becomes an unpinned decision", () => {
  const nodes = build({ assistantMessages: [said("我先读一下 index.js", "model")] });
  const decision = nodes.find((node) => node.kind === "decision");
  assert.equal(decision.pinned, false);
  assert.equal(decision.weight, 0.6);
  assert.equal(decision.order, 30);
});

test("each tool call becomes its own node carrying args in the title and output in the body", () => {
  // Rejected design: one merged run node — a single body cannot say which output came
  // from which call and cannot carry arguments. Rejected too: per-call pointers with
  // only `callId=…` (measured: 66.6% of tree tokens, unresolvable). Per call: title has
  // the arguments, body has the real output.
  const nodes = build({
    toolResults: [
      { name: "read", ok: true, callId: "call-1", text: "PORT=8080 TOKEN=sk-abc123", args: "file_path=HANDOFF.md" },
      { name: "grep", ok: true, callId: "call-2", text: "3 matches in pipeline.js", args: "pattern=fold path=lib" },
    ],
  });
  const episodes = nodes.filter((node) => node.kind === "episode");
  assert.equal(episodes.length, 2, "one node per tool call");
  assert.equal(episodes[0].title, "read(file_path=HANDOFF.md)");
  assert.ok(episodes[0].body.includes("PORT=8080"), "the real output is the body");
  assert.equal(episodes[1].title, "grep(pattern=fold path=lib)");
  assert.ok(!JSON.stringify(episodes).includes("callId"), "no opaque pointer anywhere");
});

test("a failed tool call is labelled FAILED, weighted higher, and keeps a bigger body", () => {
  const nodes = build({
    toolResults: [
      { name: "read", ok: true, callId: "c1", text: "ordinary success output", args: "file_path=a.txt" },
      { name: "bash", ok: false, callId: "c9", text: "ENOENT: no such file or directory".repeat(20), args: "command=npm test" },
    ],
  });
  const [ok, bad] = nodes.filter((node) => node.kind === "episode");
  assert.equal(bad.title, "bash(command=npm test) FAILED");
  assert.ok(bad.weight > ok.weight, "a failure outranks a success so the trimmer keeps it");
  assert.ok(bad.body.includes("ENOENT"), "the error message survives");
  assert.ok(bad.body.length > ok.body.length, "a failure gets the larger body budget");
});

test("a tool node body never exceeds MAX_BODY even for a huge output", () => {
  const run = build({
    toolResults: [{ name: "read", ok: true, callId: "c", text: "x".repeat(80_000), args: "file_path=big.log" }],
  }).find((node) => node.kind === "episode");
  assert.ok(run.body.length <= MAX_BODY, `body ${run.body.length} must fit MAX_BODY`);
  assert.ok(run.title.length <= MAX_TITLE);
});

test("a tool call with no output falls back to its title, not an empty body", () => {
  const run = build({ toolResults: [{ name: "noop", ok: true, callId: "c", args: "x=1" }] }).find(
    (node) => node.kind === "episode",
  );
  assert.equal(run.title, "noop(x=1)");
  assert.equal(run.body, "noop(x=1)", "a blank output renders as the title, not an empty line");
});

test("a tool call with no arguments is just its name", () => {
  const run = build({ toolResults: [{ name: "ls", ok: true, callId: "c", text: "a.txt b.txt" }] }).find(
    (node) => node.kind === "episode",
  );
  assert.equal(run.title, "ls");
  assert.equal(run.body, "a.txt b.txt");
});

test("reasoning blocks are dropped, not stored", () => {
  const nodes = build({
    assistantMessages: [
      { role: "assistant", source: { kind: "model" }, content: [{ type: "reasoning", text: "secret chain", signature: "sig" }] },
    ],
  });
  assert.deepEqual(nodes, [], "a reasoning-only message contributes nothing");
});

test("ids are deterministic and storage-safe", () => {
  const material = { userMessages: [said("a")], toolResults: [{ name: "t", ok: true, callId: "c" }] };
  const first = build(material);
  const second = build(material);
  assert.deepEqual(first, second);
  for (const node of first) {
    assert.doesNotThrow(() => validateNode(node), `node ${node.id} must validate`);
  }
});

test("id prefixes derive from the segment, not the turn", () => {
  // v0 used `t<turn>` prefixes and then parsed them for decay; segment ids broke
  // that silently. `born` is the explicit field now, and ids carry the segment.
  const nodes = build({ userMessages: [said("hi")] });
  assert.equal(nodes[0].id, "s42-task-0");
  assert.equal(nodes[0].born, 3);
});

test("title and body respect the caps", () => {
  const long = "很长的句子。".repeat(400);
  const nodes = build({ userMessages: [said(long)] });
  assert.ok(nodes[0].title.length <= MAX_TITLE);
  assert.ok(nodes[0].body.length <= MAX_BODY);
});

test("the node count is a safety valve, not a budget", () => {
  const many = Array.from({ length: 200 }, (_, index) => said(`第 ${index} 条`));
  const nodes = build({ userMessages: many });
  assert.equal(nodes.length, MAX_NODES_PER_TURN);
  assert.ok(MAX_NODES_PER_TURN >= 64, "the valve must sit well above measured volume");
});

test("an anchor plus its children renders without orphans", () => {
  const anchor = segmentAnchor("s42", 3, 100, 9);
  const children = build({ userMessages: [said("记住这个")] });
  const rendered = renderZoneTree([anchor, ...children]);
  assert.ok(rendered.includes("T3"));
  assert.ok(rendered.includes("记住这个"));
  assert.equal(rendered.split("\n")[0], "- T3: 9 msg");
});

test("the anchor sorts by order and carries no parent", () => {
  const anchor = segmentAnchor("s7", 1, 700, 3);
  assert.equal(anchor.parentId, null);
  assert.equal(anchor.order, 700);
  assert.equal(anchor.born, 1);
});

test("an empty segment produces no nodes", () => {
  assert.deepEqual(build({}), []);
});

test("callsOf flattens tool calls across assistant messages", () => {
  const calls = callsOf([
    { content: [{ type: "tool-call", id: "a", name: "read" }] },
    { content: [{ type: "text", text: "x" }, { type: "tool-call", id: "b", name: "bash" }] },
  ]);
  assert.deepEqual(calls.map((call) => call.id), ["a", "b"]);
});

// v10: provenance on every node. The event span the segment distilled rides on each
// node so a promoted record can carry `sources[].seqRange` and a later session can
// replay the originals with `memory_fetch(seq, sessionId)`.
test("every distilled node carries the segment's seqRange", () => {
  const nodes = distillTurn({
    segment: "s42",
    turn: 3,
    seqRange: [100, 137],
    userMessages: [said("先读文件")],
    assistantMessages: [said("好的", "assistant")],
    toolResults: [{ name: "read", ok: true, text: "内容", args: "file_path=a.md", seq: 120 }],
  });
  assert.equal(nodes.length, 3);
  for (const node of nodes) {
    assert.deepEqual(node.seqRange, [100, 137], `${node.kind} node must carry the span`);
  }
});

test("a missing or malformed seqRange adds no field (older callers keep working)", () => {
  for (const seqRange of [undefined, null, [], [5], [1, 2, 3], "1-2"]) {
    const nodes = distillTurn({
      segment: "s1",
      turn: 1,
      ...(seqRange === undefined ? {} : { seqRange }),
      userMessages: [said("hi")],
    });
    assert.equal(nodes.length, 1);
    assert.equal("seqRange" in nodes[0], false, `seqRange=${JSON.stringify(seqRange)} must be dropped`);
  }
});
