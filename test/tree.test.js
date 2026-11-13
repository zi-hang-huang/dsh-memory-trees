/**
 * Tree contract tests.
 *
 * The renderer is deliberately intolerant: an unreachable node means memory the
 * model paid for and cannot read, so the failure has to be loud. v0 shipped a
 * version where an orphaned zone rendered as an empty string, which looked exactly
 * like "there is nothing to remember".
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BODY,
  frameZone,
  mergeNodes,
  nodePricer,
  renderZoneTree,
  trimToBudget,
  validateNode,
} from "../lib/tree.js";
import * as pricing from "../lib/pricing.js";

/**
 * Build a valid node.
 * @param {string} id - node id.
 * @param {object} [options] - overrides.
 * @returns {object} node.
 */
function node(id, options = {}) {
  return {
    id,
    zone: options.zone ?? "volatile",
    kind: options.kind ?? "decision",
    parentId: options.parentId ?? null,
    order: options.order ?? 1,
    title: options.title ?? id,
    body: options.body ?? "",
    weight: options.weight ?? 0.6,
    pinned: options.pinned ?? false,
    rev: options.rev ?? 1,
    born: options.born ?? 1,
    archived: options.archived ?? false,
  };
}

test("validateNode rejects an id storage could not key on", () => {
  assert.throws(() => validateNode(node("has space"), "t"), /node id must match/);
  assert.throws(() => validateNode(node("ok", { kind: "nonsense" }), "t"), /unknown kind/);
  assert.throws(
    () => validateNode(node("ok", { body: "x".repeat(MAX_BODY + 1) }), "t"),
    /body must be a string <= 600 chars/,
  );
  assert.doesNotThrow(() => validateNode(node("s12-task-0")));
});

test("renders deterministically, siblings by (order, id)", () => {
  const nodes = [
    node("b", { order: 2, title: "second" }),
    node("a", { order: 1, title: "first" }),
    node("c", { order: 2, title: "third", id: "c" }),
  ];
  const once = renderZoneTree(nodes);
  const twice = renderZoneTree([...nodes].reverse());
  assert.equal(once, twice);
  assert.equal(once, ["- first", "- second", "- third"].join("\n"));
});

test("throws on orphans instead of rendering an empty zone", () => {
  const nodes = [node("child", { parentId: "missing", title: "lost" })];
  assert.throws(() => renderZoneTree(nodes), /node\(s\) unreachable from root/);
});

test("renders nested children under their parent", () => {
  const nodes = [
    node("s1", { kind: "episode", title: "T1", order: 100 }),
    node("s1-task-0", { parentId: "s1", kind: "task", order: 10, title: "do the thing" }),
  ];
  assert.equal(renderZoneTree(nodes), ["- T1", "  - do the thing"].join("\n"));
});

test("archived nodes are neither rendered nor reported as orphans", () => {
  const nodes = [node("a", { title: "gone", archived: true })];
  assert.equal(renderZoneTree(nodes), "");
});

test("frameZone marks the zone so the model can tell budgets apart", () => {
  assert.equal(frameZone("volatile", "- x"), '<memory zone="volatile">\n- x\n</memory>');
});

test("mergeNodes keeps an unchanged node's rev stable", () => {
  const carried = [node("a", { title: "same", rev: 3 })];
  const fresh = [node("a", { title: "same", rev: 1 })];
  const merged = mergeNodes(carried, fresh, 5);
  const kept = merged.find((entry) => entry.id === "a");
  assert.equal(kept.rev, 3);
  assert.equal(kept, carried[0], "identity should be preserved, not rebuilt");
});

test("mergeNodes bumps rev when the text changed", () => {
  const carried = [node("a", { title: "before", rev: 3 })];
  const fresh = [node("a", { title: "after", rev: 1 })];
  const kept = mergeNodes(carried, fresh, 5).find((entry) => entry.id === "a");
  assert.equal(kept.rev, 4);
  assert.equal(kept.title, "after");
});

test("mergeNodes collapses the same fact re-distilled under a later segment", () => {
  // Node ids are `s<startSeq>-...`, so the same fact distilled by two different folds
  // gets two different ids and by-id merging never sees them as one node. Measured on a
  // live session: 33 minutes, 24 folds, 55 model nodes of which 38% were duplicate
  // titles — "运行环境与文件策略参数" was kept five times. Content is the identity here;
  // the id only records which fold happened to produce it.
  const carried = [
    node("s100-episode-m0", {
      title: "运行环境与文件策略参数",
      body: "retainTokens 12000",
      parentId: "s100",
      order: 100,
    }),
  ];
  const fresh = [
    node("s900-episode-m0", {
      title: "运行环境与文件策略参数",
      body: "retainTokens 12000",
      parentId: "s900",
      order: 200,
    }),
    node("s900-episode-m1", { title: "另一个事实", body: "x", parentId: "s900", order: 201 }),
  ];

  const merged = mergeNodes(carried, fresh, 5);
  const dupes = merged.filter((entry) => entry.title === "运行环境与文件策略参数");

  assert.equal(dupes.length, 1, "the same fact must appear once, not once per fold that saw it");
  assert.equal(dupes[0].id, "s100-episode-m0", "the earlier segment keeps the identity so order stays stable");
  assert.ok(merged.some((entry) => entry.title === "另一个事实"), "distinct facts are untouched");
});

test("mergeNodes never lets content dedup orphan a child or drop an anchor", () => {
  // Dedup must be leaf-only. The anchor is the parent of its children; collapsing an
  // anchor by content would leave its children pointing at a missing parent, which the
  // renderer refuses to render at all.
  const carried = [node("s1", { kind: "episode", title: "T4", body: "12 msg", parentId: null, order: 1 })];
  const fresh = [
    node("s9", { kind: "episode", title: "T4", body: "12 msg", parentId: null, order: 900 }),
    node("s9-task-0", { kind: "task", title: "keep me", parentId: "s9", pinned: true, order: 910 }),
  ];

  const merged = mergeNodes(carried, fresh, 5);

  assert.ok(merged.some((entry) => entry.id === "s9"), "a fresh anchor is never collapsed away");
  assert.ok(merged.some((entry) => entry.id === "s9-task-0"), "pinned material survives");
  assert.doesNotThrow(() => renderZoneTree(merged));
});

test("mergeNodes ages out stale unpinned nodes using the born field", () => {
  const carried = [
    node("old", { kind: "decision", born: 1 }),
    node("young", { kind: "decision", born: 20 }),
    node("pinned", { kind: "task", born: 1, pinned: true }),
  ];
  const merged = mergeNodes(carried, [], 25);
  assert.deepEqual(
    merged.map((entry) => entry.id).sort(),
    ["pinned", "young"],
    "a node born 24 turns ago drops; pinned survives",
  );
});

test("mergeNodes never ages out the material this fold just distilled", () => {
  // Backlog folding: at turn 40 the planner reaches back to turn 2 material. Those
  // nodes are 38 turns old, so the age rule would drop every one of them and leave
  // the tree empty — at which point `foldIfNeeded` renders "" and silently abandons
  // the fold, so the surface grows with no error anywhere (measured: 134k instead of
  // 81k on `2d026c40`). A node this fold produced has just been refreshed; only nodes
  // it did not touch may age.
  const carried = [node("stale", { kind: "decision", born: 1 })];
  const fresh = [node("just-learned", { kind: "task", born: 1 })];

  const merged = mergeNodes(carried, fresh, 40);

  assert.deepEqual(
    merged.map((entry) => entry.id),
    ["just-learned"],
    "the freshly distilled node survives; the one nothing refreshed still ages out",
  );
});

test("mergeNodes never ages out a parent while a child survives", () => {
  const carried = [
    node("s1", { kind: "episode", born: 1 }),
    node("s1-task-0", { kind: "task", parentId: "s1", born: 1, pinned: true }),
  ];
  const merged = mergeNodes(carried, [], 40);
  assert.deepEqual(merged.map((entry) => entry.id).sort(), ["s1", "s1-task-0"]);
  assert.doesNotThrow(() => renderZoneTree(merged));
});

test("trimToBudget drops tool pointers before assistant prose", () => {
  const nodes = [
    node("a", { kind: "episode", weight: 0.3, title: "tool ok" }),
    node("b", { kind: "decision", weight: 0.6, title: "assistant said" }),
  ];
  const { kept, dropped } = trimToBudget(nodes, 20, () => 15);
  assert.deepEqual(dropped.map((entry) => entry.id), ["a"], "episode goes first");
  assert.deepEqual(kept.map((entry) => entry.id), ["b"]);
});

test("trimToBudget never drops a pinned task node", () => {
  const nodes = [node("a", { kind: "task", pinned: true, title: "the human's words" })];
  const { kept, dropped, oversized } = trimToBudget(nodes, 1, () => 100);
  assert.deepEqual(dropped, []);
  assert.deepEqual(kept.map((entry) => entry.id), ["a"]);
  assert.equal(oversized, true, "an over-budget task is a signal, not a truncation");
});

test("trimToBudget leaves no orphan behind", () => {
  const nodes = [
    node("s1", { kind: "episode", order: 100, weight: 0.1 }),
    node("s1-episode-0", { kind: "episode", parentId: "s1", order: 50, weight: 0.1 }),
    node("s1-task-0", { kind: "task", parentId: "s1", order: 10, pinned: true }),
  ];
  const { kept } = trimToBudget(nodes, 5, () => 100);
  assert.doesNotThrow(() => renderZoneTree(kept), "trimmer must not create orphans");
  assert.ok(kept.some((entry) => entry.id === "s1"), "anchor survives its pinned child");
});

test("nodePricer prices the rendered text, not the raw fields", () => {
  const entry = node("a", { title: "t", body: "b" });
  assert.equal(nodePricer(pricing, entry), pricing.priceString("t: b"));
  assert.ok(nodePricer(pricing, entry) > 0);
});
