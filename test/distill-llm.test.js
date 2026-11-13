/**
 * Contract tests for the v2 distillation boundary.
 *
 * The point of this module is that a model's output is untrusted. Each test pins one
 * thing a model actually does: wraps JSON in a fence, adds a sentence before it,
 * invents an id, parents a node to something that does not exist, returns 40 nodes,
 * writes a 3,000-character body. Only the last two are behavioural questions; the
 * rest must be normalised, not rejected, or the rejection rate v2 is judged on
 * becomes noise.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_BODY, MAX_TITLE, validateNode } from "../lib/tree.js";
import { MODEL_KINDS, buildDistillInstruction, parsePatch, validatePatch } from "../lib/distill-llm.js";

test("parsePatch reads a fenced json block", () => {
  const text = 'here you go\n```json\n[{"kind":"decision","title":"t","body":"b"}]\n```\n';
  assert.deepEqual(parsePatch(text), [{ kind: "decision", title: "t", body: "b" }]);
});

test("parsePatch tolerates a bare fence and a bare array", () => {
  assert.deepEqual(parsePatch('```\n[{"kind":"episode","title":"t"}]\n```'), [{ kind: "episode", title: "t" }]);
  assert.deepEqual(parsePatch('[{"kind":"episode","title":"t"}]'), [{ kind: "episode", title: "t" }]);
});

test("parsePatch recovers an array buried in commentary", () => {
  const text = 'Sure. Here is the patch: [{"kind":"decision","title":"t"}] — done.';
  assert.deepEqual(parsePatch(text), [{ kind: "decision", title: "t" }]);
});

test("parsePatch rejects output that is not an array", () => {
  assert.throws(() => parsePatch('{"kind":"decision"}'), /must be a JSON array/);
  assert.throws(() => parsePatch(""), /empty/);
  assert.throws(() => parsePatch("no json at all"), /not JSON/);
});

test("validatePatch assigns ids and parents instead of trusting the model", () => {
  const { nodes } = validatePatch(
    [
      { id: "evil", parentId: "somewhere-else", kind: "decision", title: "picked a port", body: "8080" },
    ],
    { segment: "s42", turn: 7 },
  );

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, "s42-decision-m0", "the model's id is ignored");
  assert.equal(nodes[0].parentId, "s42", "the model's parent is ignored");
  assert.equal(nodes[0].born, 7);
  assert.doesNotThrow(() => validateNode(nodes[0], "test"));
});

test("validatePatch rejects tasks: the human's words are the rule distiller's job", () => {
  const { nodes, rejected } = validatePatch(
    [
      { kind: "task", title: "user said something", body: "..." },
      { kind: "decision", title: "kept", body: "ok" },
    ],
    { segment: "s1" },
  );

  assert.equal(nodes.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /bad-kind:task/);
  assert.ok(!MODEL_KINDS.includes("task"));
});

test("validatePatch clips long text instead of rejecting it", () => {
  const { nodes, rejected, clipped } = validatePatch(
    [{ kind: "decision", title: "t".repeat(MAX_TITLE + 50), body: "b".repeat(MAX_BODY + 500) }],
    { segment: "s1" },
  );

  assert.equal(rejected.length, 0, "a long body is still useful");
  assert.equal(clipped, 1);
  assert.equal(nodes[0].title.length, MAX_TITLE);
  assert.equal(nodes[0].body.length, MAX_BODY);
  assert.doesNotThrow(() => validateNode(nodes[0], "test"));
});

test("validatePatch caps the node count and reports the overflow", () => {
  const patch = Array.from({ length: 12 }, (_, index) => ({
    kind: "episode",
    title: `t${index}`,
    body: `b${index}`,
  }));
  const { nodes, rejected } = validatePatch(patch, { segment: "s1", maxNodes: 5 });

  assert.equal(nodes.length, 5);
  assert.equal(rejected.length, 7);
  assert.ok(rejected.every((entry) => entry.reason === "over-max-nodes"));
  assert.deepEqual(
    nodes.map((node) => node.id),
    ["s1-episode-m0", "s1-episode-m1", "s1-episode-m2", "s1-episode-m3", "s1-episode-m4"],
    "ids stay unique even when the model repeats itself",
  );
});

test("validatePatch rejects nodes with nothing in them", () => {
  const { nodes, rejected } = validatePatch(
    [
      { kind: "decision", title: "", body: "" },
      { kind: "decision", title: "only a title" },
      null,
      "not an object",
    ],
    { segment: "s1" },
  );

  assert.equal(nodes.length, 1, "the one node with a title survives");
  assert.deepEqual(
    rejected.map((entry) => entry.reason),
    ["empty", "not-an-object", "not-an-object"],
  );
});

test("validatePatch clamps the weight and keeps it finite", () => {
  const { nodes } = validatePatch(
    [
      { kind: "decision", title: "a", body: "a", weight: 99 },
      { kind: "episode", title: "b", body: "b", weight: -3 },
      { kind: "episode", title: "c", body: "c", weight: "heavy" },
    ],
    { segment: "s1" },
  );

  assert.deepEqual(
    nodes.map((node) => node.weight),
    [1, 0.1, 0.4],
    "out-of-range weights clamp; a non-number falls back to the kind default",
  );
});

test("validatePatch rejects a segment name the renderer would not accept", () => {
  assert.throws(() => validatePatch([], { segment: "s 1" }), /bad segment name/);
});

test("the instruction asks for JSON only and carries the turn", () => {
  const text = buildDistillInstruction({ turn: 12, maxNodes: 6 });
  assert.match(text, /JSON 数组/);
  assert.match(text, /最多 6 条/);
  assert.match(text, /第 12 轮/);
  assert.ok(!/tools?/i.test(text), "must not offer the model a tool call");
});

test("renderMaterial caps the transcript and keeps head and tail", async () => {
  const { priceText } = await import("../lib/pricing.js");
  const { renderMaterial } = await import("../lib/distill-llm.js");
  const big = "x".repeat(400_000);
  const material = {
    userMessages: [{ content: [{ type: "text", text: `HEAD-MARKER ${big} MIDDLE` }] }],
    assistantMessages: [{ content: [{ type: "text", text: `TAIL-MARKER` }] }],
    toolResults: [],
  };

  const capped = renderMaterial(material, 8000);
  assert.ok(capped.length < big.length, "the transcript must shrink");
  assert.ok(priceText(capped) <= 9000, `capped transcript priced ${Math.round(priceText(capped))} tokens`);
  assert.ok(capped.startsWith("### user"), "the head of the span states the task");
  assert.ok(capped.includes("HEAD-MARKER"), "the opening survives");
  assert.ok(capped.includes("TAIL-MARKER"), "the outcome survives");
  assert.ok(capped.includes("中间省略"), "the cut is visible to the model, not silent");

  const small = renderMaterial({ userMessages: [{ content: [{ type: "text", text: "short" }] }] });
  assert.equal(small, "### user\nshort", "a small span is passed through verbatim");
});

test("renderMaterial feeds a tool result's real output to the model", async () => {
  // `materialForRange` produces `{name, ok, text, callId}` records with no `.content`.
  // The renderer used to read only `.content`, so `### tool` was silently empty and the
  // model never saw a tool result. Both shapes must render.
  const { renderMaterial } = await import("../lib/distill-llm.js");
  const material = {
    userMessages: [],
    assistantMessages: [],
    toolResults: [
      { name: "read", ok: true, callId: "c1", text: "PORT=8080" },
      { name: "bash", ok: false, callId: "c2", text: "ENOENT: missing" },
    ],
  };
  const text = renderMaterial(material, 12000);
  assert.ok(text.includes("### tool"), "a tool section must be emitted");
  assert.ok(text.includes("PORT=8080"), "the success output reaches the model");
  assert.ok(text.includes("ENOENT: missing"), "the failure output reaches the model");
  assert.ok(/tool/.test(text) && text.includes("(failed)"), "a failure is labelled");
});

test("renderMaterial never re-feeds a memory checkpoint to the model", async () => {
  // The v1 rule distiller filters with `isMemorySource`; v2's renderer did not, so every
  // fold re-distilled the previous fold's `<memory>` block as if it were fresh user text.
  // That is the feedback loop behind the measured duplicate nodes: each fold restated the
  // last summary. A checkpoint is already-distilled material, not raw conversation.
  const { renderMaterial } = await import("../lib/distill-llm.js");
  const material = {
    userMessages: [
      { content: [{ type: "text", text: "REAL-TASK" }], source: { kind: "user" } },
      { content: [{ type: "text", text: "OLD-CHECKPOINT" }], source: { kind: "memory" } },
    ],
    assistantMessages: [
      { content: [{ type: "text", text: "SELF-TREE" }], source: { kind: "memory:self" } },
      { content: [{ type: "text", text: "REAL-ASSISTANT" }], source: { kind: "agent-message" } },
    ],
    toolResults: [],
  };

  const text = renderMaterial(material, 12000);

  assert.ok(text.includes("REAL-TASK"), "genuine user text is distilled");
  assert.ok(text.includes("REAL-ASSISTANT"), "genuine assistant text is distilled");
  assert.ok(!text.includes("OLD-CHECKPOINT"), "a prior checkpoint must not be distilled again — that is the loop");
  assert.ok(!text.includes("SELF-TREE"), "the self tree is not fold material either");
});
