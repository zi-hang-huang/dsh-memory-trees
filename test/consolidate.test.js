/**
 * v3 consolidation contract tests.
 *
 * Consolidation is the first pass that *removes* things a user could notice, so each
 * test pins one promise the design makes: the human's words survive, pinned nodes
 * survive, a parent never outlives its children, the same input twice is the same
 * output, and "archived" is a flag rather than a deletion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { archiveStale, consolidate, decayWeights, dedupKey, mergeDuplicates } from "../lib/consolidate.js";
import { renderZoneTree } from "../lib/tree.js";

/**
 * Build a memory node.
 * @param {string} id - node id.
 * @param {object} [options] - overrides.
 * @returns {object} node.
 */
function node(id, options = {}) {
  return {
    id,
    zone: "volatile",
    kind: options.kind ?? "decision",
    parentId: options.parentId ?? null,
    order: options.order ?? 1,
    title: options.title ?? id,
    body: options.body ?? "",
    weight: options.weight ?? 1,
    pinned: options.pinned ?? false,
    rev: options.rev ?? 1,
    born: options.born ?? 0,
    archived: options.archived ?? false,
  };
}

test("dedupKey ignores whitespace, case and trailing punctuation only", () => {
  assert.equal(dedupKey(node("a", { title: "Picked  8080.", body: "Because 80 was taken" })), dedupKey(node("b", { title: "picked 8080", body: "because 80 was taken." })));
  assert.notEqual(
    dedupKey(node("a", { title: "--test-concurrency=1" })),
    dedupKey(node("b", { title: "test concurrency 1" })),
    "punctuation inside the text is meaning, not noise",
  );
});

test("mergeDuplicates keeps one of two identical nodes", () => {
  const nodes = [
    node("a", { title: "port 8080", body: "80 was taken" }),
    node("b", { title: "port 8080", body: "80 was taken" }),
    node("c", { title: "port 9090", body: "something else" }),
  ];

  const { nodes: kept, merged } = mergeDuplicates(nodes);

  assert.equal(merged, 1);
  assert.deepEqual(kept.map((entry) => entry.id).sort(), ["a", "c"]);
});

test("mergeDuplicates picks the survivor deterministically", () => {
  const base = { title: "same fact", body: "same words" };

  assert.equal(
    mergeDuplicates([node("a", { ...base, pinned: true }), node("b", { ...base, weight: 1 })]) .nodes[0].id,
    "a",
    "a pinned node beats an unprotected one",
  );
  assert.equal(
    mergeDuplicates([node("a", { ...base, weight: 0.3 }), node("b", { ...base, weight: 0.9 })]).nodes[0].id,
    "b",
    "higher weight wins",
  );
  assert.equal(
    mergeDuplicates([node("a", { ...base, rev: 1 }), node("b", { ...base, rev: 3 })]).nodes[0].id,
    "b",
    "the more recently corrected copy wins",
  );
  assert.equal(
    mergeDuplicates([node("b", { ...base }), node("a", { ...base })]).nodes[0].id,
    "a",
    "the smaller id breaks the tie, so order of arrival does not matter",
  );
});

test("mergeDuplicates ignores already-archived nodes", () => {
  const { nodes: kept, merged } = mergeDuplicates([
    node("a", { title: "gone", archived: true }),
    node("b", { title: "here" }),
  ]);
  assert.equal(merged, 0);
  assert.deepEqual(kept.map((entry) => entry.id), ["b"]);
});

test("decayWeights halves at the half-life and floors", () => {
  const result = decayWeights(
    [
      node("fresh", { weight: 1, born: 40 }),
      node("oneHalfLife", { weight: 1, born: 0 }),
      node("threeHalfLives", { weight: 1, born: -80 }),
    ],
    { now: 40, halfLifeTurns: 40, floorWeight: 0.05 },
  );

  assert.equal(result.nodes.find((entry) => entry.id === "fresh").weight, 1, "no age, no change");
  assert.equal(result.nodes.find((entry) => entry.id === "oneHalfLife").weight, 0.5);
  assert.equal(result.nodes.find((entry) => entry.id === "threeHalfLives").weight, 0.125);
  assert.equal(result.decayed, 2);

  const floored = decayWeights([node("ancient", { weight: 1, born: 0 })], { now: 10_000, halfLifeTurns: 10, floorWeight: 0.07 });
  assert.equal(floored.nodes[0].weight, 0.07, "decay never reaches zero");
});

test("decayWeights leaves task and pinned nodes alone", () => {
  const result = decayWeights(
    [
      node("task", { kind: "task", weight: 1, born: 0, pinned: true }),
      node("pinned-decision", { weight: 0.8, born: 0, pinned: true }),
      node("ordinary", { weight: 1, born: 0 }),
    ],
    { now: 400, halfLifeTurns: 10 },
  );

  assert.equal(result.nodes[0].weight, 1);
  assert.equal(result.nodes[1].weight, 0.8);
  assert.ok(result.nodes[2].weight < 0.8, "the ordinary node decayed");
});

test("archiveStale retires old light nodes by flag, not deletion", () => {
  const result = archiveStale(
    [
      node("old-light", { weight: 0.05, born: 0 }),
      node("old-heavy", { weight: 0.9, born: 0 }),
      node("young-light", { weight: 0.05, born: 119 }),
    ],
    { now: 120, archiveAfterTurns: 120, archiveBelowWeight: 0.1 },
  );

  assert.equal(result.archived, 1);
  assert.equal(result.nodes.length, 3, "nothing is deleted");
  assert.equal(result.nodes.find((entry) => entry.id === "old-light").archived, true);
  assert.equal(result.nodes.find((entry) => entry.id === "old-heavy").archived, false);
  assert.equal(result.nodes.find((entry) => entry.id === "young-light").archived, false);
});

test("archiveStale never retires a parent that still has a live child", () => {
  const result = archiveStale(
    [
      node("anchor", { weight: 0.05, born: 0 }),
      node("child", { kind: "task", weight: 1, born: 0, pinned: true, parentId: "anchor" }),
    ],
    { now: 400, archiveAfterTurns: 120, archiveBelowWeight: 0.1 },
  );

  assert.equal(result.archived, 0, "archiving the anchor would orphan the task node");
  assert.equal(result.nodes[0].archived, false);
});

test("archiveStale never retires task or pinned nodes", () => {
  const result = archiveStale(
    [
      node("task", { kind: "task", weight: 0.01, born: 0, pinned: true }),
      node("pinned", { weight: 0.01, born: 0, pinned: true }),
    ],
    { now: 1000, archiveAfterTurns: 10, archiveBelowWeight: 0.5 },
  );
  assert.equal(result.archived, 0);
});

test("consolidate is idempotent for the same now", () => {
  const input = [
    node("a", { title: "dup", body: "x", weight: 1, born: 0 }),
    node("b", { title: "dup", body: "x", weight: 1, born: 0 }),
    node("c", { title: "unique", body: "y", weight: 1, born: 0 }),
  ];

  const once = consolidate(input, { now: 100, halfLifeTurns: 40 });
  const twice = consolidate(once.nodes, { now: 100, halfLifeTurns: 40 });

  assert.deepEqual(
    twice.nodes.map((entry) => [entry.id, entry.weight, entry.archived]),
    once.nodes.map((entry) => [entry.id, entry.weight, entry.archived]),
    "a second pass at the same turn changes nothing",
  );
  assert.equal(once.stats.merged, 1);
  assert.equal(twice.stats.merged, 0);
});

test("consolidated nodes still render", () => {
  const { nodes } = consolidate(
    [
      node("anchor", { kind: "episode", parentId: null, order: 1, weight: 1, born: 0 }),
      node("anchor-task-0", { kind: "task", parentId: "anchor", order: 2, weight: 1, pinned: true, born: 0 }),
      node("anchor-decision-0", { kind: "decision", parentId: "anchor", order: 3, weight: 0.3, born: 0 }),
    ],
    { now: 500, halfLifeTurns: 40, archiveAfterTurns: 100, archiveBelowWeight: 0.2 },
  );

  const archived = nodes.filter((entry) => entry.archived).map((entry) => entry.id);
  assert.ok(archived.includes("anchor-decision-0"), "the light decision retires");
  assert.doesNotThrow(() => renderZoneTree(nodes.filter((entry) => !entry.archived), { origin: "consolidate" }));
});
