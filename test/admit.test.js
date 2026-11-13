/**
 * Admission and barrier contract tests.
 *
 * These two rules look similar and are not: admission decides what may become
 * memory, barriers decide what a fold must not hide. Conflating them is what made
 * v0 store a 24,967-character skill catalog as if it were something the human said.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BARRIER_KINDS,
  MEMORY_SOURCE_KINDS,
  isBarrierSource,
  isMemorySource,
  makeKindFilter,
  textOf,
  toolCallsOf,
} from "../lib/admit.js";

/**
 * Build a message with a source kind.
 * @param {string} kind - `source.kind`.
 * @param {object[]} [content] - content blocks.
 * @returns {object} message.
 */
function message(kind, content = [{ type: "text", text: "hi" }]) {
  return { role: "user", content, source: { kind } };
}

test("the default allowlist is the human's own channels only", () => {
  assert.deepEqual([...MEMORY_SOURCE_KINDS], ["user", "agent-message", "goal"]);
  for (const kind of MEMORY_SOURCE_KINDS) {
    assert.equal(isMemorySource(message(kind)), true, `${kind} must be admissible`);
  }
});

test("framework injections are not memory material", () => {
  // Measured over 67 sessions: these five account for 98.6% of all user/message
  // tokens, and none of them is something the human said.
  for (const kind of [
    "skill-catalog",
    "qqbot:group-rules",
    "plugin:hindsight",
    "runtime-context",
    "time-context",
  ]) {
    assert.equal(isMemorySource(message(kind)), false, `${kind} must be rejected`);
  }
});

test("an unknown injection kind is rejected rather than admitted", () => {
  // A new plugin's injection stream must not silently become memory; the failure
  // has to be "nothing recorded" and not "a 10k-token payload pinned forever".
  assert.equal(isMemorySource(message("some-future-plugin")), false);
  assert.equal(isMemorySource(undefined), false);
  assert.equal(isMemorySource({ content: [] }), false);
});

test("the allowlist is overridable, and makeKindFilter builds the same predicate", () => {
  const custom = new Set(["user"]);
  assert.equal(isMemorySource(message("goal"), custom), false);
  const only = makeKindFilter(["skill-catalog"]);
  assert.equal(only(message("skill-catalog")), true);
  assert.equal(only(message("user")), false);
});

test("barriers are the surface-aware injections, and self is one of them", () => {
  assert.deepEqual(
    [...DEFAULT_BARRIER_KINDS],
    ["skill-catalog", "agent-instructions"],
  );
  for (const kind of DEFAULT_BARRIER_KINDS) {
    assert.equal(isBarrierSource(message(kind)), true);
  }
  assert.equal(isBarrierSource(message("user")), false);
});

test("memory:self is neither admissible nor a barrier, on purpose", () => {
  // `memory:self` is delivered as a user message and carries the persona, so both
  // obvious guesses are wrong. It is not admissible: its nodes are already memory,
  // and admitting the rendered message would store the rendering as a fact about the
  // user. It is not a barrier either: the barrier set exists for injections that
  // re-publish themselves by consulting the surface, while this one is re-published
  // by us from captured nodes. Marking it a barrier stalled the fold permanently
  // once its copy drifted behind the first checkpoint.
  assert.equal(isMemorySource(message("memory:self")), false);
  assert.equal(isBarrierSource(message("memory:self")), false);
});

test("textOf keeps text blocks only and drops reasoning", () => {
  const fact = message("user", [
    { type: "text", text: "first" },
    { type: "reasoning", text: "not replayable", signature: "abc" },
    { type: "text", text: "second" },
  ]);
  assert.equal(textOf(fact), "first\nsecond");
});

test("textOf tolerates a message with no content", () => {
  assert.equal(textOf({}), "");
  assert.equal(textOf({ content: [] }), "");
});

test("toolCallsOf lists calls without their arguments", () => {
  const calls = toolCallsOf(
    message("model", [
      { type: "tool-call", id: "c1", name: "read", arguments: { path: "a" } },
      { type: "text", text: "working" },
      { type: "tool-call", id: "c2", name: "write", arguments: { path: "b" } },
    ]),
  );
  assert.deepEqual(calls.map((call) => call.id), ["c1", "c2"]);
});
