/**
 * Tests for lib/self-store.js — the durable 自我认知 override.
 *
 * The property that matters most: an edit written here must survive into a NEW
 * session, which is exactly what the surface-only design could not do. So the
 * key test is the `publishSelf` precedence one at the bottom: store beats the
 * surface copy beats the defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  selfStorePath,
  normalizeSelfNodes,
  readSelfState,
  readSelfOverride,
  writeSelfOverride,
  resetSelfOverride,
  selfView,
} from "../lib/self-store.js";
import { defaultSelfNodes, renderSelf } from "../lib/self.js";
import { publishSelf } from "../lib/pipeline.js";

/** A path in a fresh temp dir (not yet created). */
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-self-store-"));
  return path.join(dir, "dsh_memory_self.json");
}

/** Minimal node payload for writes. */
function payload(title, body = "", extra = {}) {
  return { title, body, ...extra };
}

test("selfStorePath points at ~/.dsh/storages/dsh_memory_self.json", () => {
  assert.equal(selfStorePath(), path.join(os.homedir(), ".dsh", "storages", "dsh_memory_self.json"));
});

test("missing file → defaults, revision 0, exists=false", () => {
  const state = readSelfState(tmpFile());
  assert.equal(state.exists, false);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.nodes.map((n) => n.id), defaultSelfNodes().map((n) => n.id));
});

test("readSelfOverride returns null when no file exists", () => {
  assert.equal(readSelfOverride(tmpFile()), null);
});

test("write then read round-trips the user's title/body", () => {
  const file = tmpFile();
  writeSelfOverride([payload("身份", "我是测试助手"), payload("边界", "不乱来")], undefined, file);
  const state = readSelfState(file);
  assert.equal(state.exists, true);
  assert.equal(state.revision, 1);
  assert.equal(state.nodes.length, 2);
  assert.equal(state.nodes[0].title, "身份");
  assert.equal(state.nodes[0].body, "我是测试助手");
  assert.equal(state.nodes[0].kind, "identity");
  assert.equal(state.nodes[1].kind, "constraint");
});

test("structural fields are re-derived, never taken from input", () => {
  const file = tmpFile();
  writeSelfOverride(
    [{ title: "身份", body: "x", zone: "volatile", parentId: "bogus", weight: 0.1, archived: true }],
    undefined,
    file,
  );
  const node = readSelfState(file).nodes[0];
  assert.equal(node.zone, "frozen");
  assert.equal(node.parentId, null);
  assert.equal(node.weight, 1);
  assert.equal(node.archived, false);
  assert.equal(node.pinned, true);
});

test("rejects an empty node list", () => {
  assert.throws(() => normalizeSelfNodes([]), /至少要保留一条/);
});

test("rejects an empty title", () => {
  assert.throws(() => normalizeSelfNodes([payload("   ")]), /缺少标题/);
});

test("rejects an over-long body instead of truncating", () => {
  assert.throws(() => normalizeSelfNodes([payload("身份", "x".repeat(601))]), /正文过长/);
});

test("rejects an over-long title", () => {
  assert.throws(() => normalizeSelfNodes([payload("x".repeat(121))]), /标题过长/);
});

test("generates unique ids for id-less entries", () => {
  const nodes = normalizeSelfNodes([payload("A"), payload("B"), payload("C")]);
  const ids = nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]+$/);
});

test("a duplicate id is replaced, not allowed to collide", () => {
  const nodes = normalizeSelfNodes([
    { id: "self-same", title: "A" },
    { id: "self-same", title: "B" },
  ]);
  assert.equal(new Set(nodes.map((n) => n.id)).size, 2);
});

test("unknown kind falls back to the title-derived kind", () => {
  const nodes = normalizeSelfNodes([{ title: "取舍", kind: "nonsense" }]);
  assert.equal(nodes[0].kind, "preference");
});

test("expectedRevision mismatch throws self-conflict", () => {
  const file = tmpFile();
  writeSelfOverride([payload("身份", "v1")], undefined, file); // revision 1
  assert.throws(
    () => writeSelfOverride([payload("身份", "v2")], 99, file),
    (err) => err.code === "self-conflict",
  );
  // The rejected write must not have changed the stored value.
  assert.equal(readSelfState(file).nodes[0].body, "v1");
});

test("matching expectedRevision succeeds and bumps revision", () => {
  const file = tmpFile();
  writeSelfOverride([payload("身份", "v1")], undefined, file); // revision 1
  const next = writeSelfOverride([payload("身份", "v2")], 1, file);
  assert.equal(next.revision, 2);
  assert.equal(readSelfState(file).nodes[0].body, "v2");
});

test("reset writes defaults deterministically (does not delete)", () => {
  const file = tmpFile();
  writeSelfOverride([payload("身份", "custom")], undefined, file);
  const after = resetSelfOverride(file);
  assert.equal(after.exists, true);
  assert.equal(after.revision, 2);
  assert.deepEqual(after.nodes.map((n) => n.title), ["身份", "取舍", "边界", "长期约定"]);
});

test("a corrupt file falls back to defaults rather than throwing", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ this is not json", "utf8");
  const state = readSelfState(file);
  assert.equal(state.exists, false);
  assert.equal(state.nodes.length, 4);
});

test("selfView exposes only editable fields plus revision/exists/kinds", () => {
  const file = tmpFile();
  writeSelfOverride([payload("身份", "x")], undefined, file);
  const view = selfView(readSelfState(file));
  assert.equal(view.revision, 1);
  assert.equal(view.exists, true);
  assert.ok(Array.isArray(view.kinds) && view.kinds.includes("identity"));
  const node = view.nodes[0];
  assert.deepEqual(Object.keys(node).sort(), ["body", "id", "kind", "order", "title"]);
});

// ---------------------------------------------------------------------------
// The load-bearing integration property: publishSelf prefers the store.
// ---------------------------------------------------------------------------

/** A fake agent whose surface carries ONE self message with `surfaceNodes`. */
function fakeAgent(surfaceNodes) {
  const message = {
    source: { kind: "memory:self", zone: "self", rev: 1, nodes: surfaceNodes },
    content: [{ type: "text", text: renderSelf(surfaceNodes) }],
  };
  // publishSelf reads session.surface.nodes (seqs), session.eventAt, session.append.
  const events = { 1: message };
  return {
    session: {
      surface: { nodes: [1] },
      eventAt: (seq) => events[seq],
      deriveEventMessage: (ev) => ev,
      append() {},
    },
  };
}

test("publishSelf: store override wins over the surface copy", () => {
  const file = tmpFile();
  writeSelfOverride([payload("身份", "STORE")], undefined, file);
  const agent = fakeAgent(defaultSelfNodes());
  const seen = [];
  // Capture what would be published by stubbing session.append.
  agent.session.append = (type, message) => seen.push(message);
  // No system head → publishSelf early-returns; give it one.
  agent.session.surface.nodes = [1, 2];
  agent.session.eventAt = (seq) =>
    seq === 2 ? { type: "system/message" } : { source: { kind: "memory:self", nodes: defaultSelfNodes() } };
  publishSelf(agent, { selfPublished: 0, selfReplaced: 0 }, null, {
    loadOverride: () => readSelfOverride(file),
  });
  assert.equal(seen.length, 1, "a publish/replace must have happened");
  assert.match(seen[0].content[0].text, /STORE/);
  assert.doesNotMatch(seen[0].content[0].text, /先取证再下结论/);
});

test("publishSelf: no store → falls back to the surface copy (unchanged behaviour)", () => {
  const agent = fakeAgent([{ ...defaultSelfNodes()[0], body: "SURFACE" }]);
  agent.session.surface.nodes = [1, 2];
  agent.session.eventAt = (seq) =>
    seq === 2 ? { type: "system/message" } : { source: { kind: "memory:self", nodes: [{ ...defaultSelfNodes()[0], body: "SURFACE" }] } };
  const seen = [];
  agent.session.append = (type, message) => seen.push(message);
  publishSelf(agent, { selfPublished: 0, selfReplaced: 0 }, null, { loadOverride: () => null });
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /SURFACE/);
});
