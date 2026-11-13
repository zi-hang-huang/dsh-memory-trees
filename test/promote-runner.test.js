/**
 * Tests for lib/promote-runner.js — the session-tree → LTM pipeline (pure logic).
 *
 * These exercise the real gate logic in promote.js (not mocks): kind gate, weight gate,
 * standing-instruction task filter, content-hash id stability, supersede-by-subject, and
 * eviction to budget — plus the write-diff that keeps store writes minimal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runPromotePass, diffForWrite } from "../lib/promote-runner.js";

/** A minimal promotable decision node. */
function decision(title, body, weight = 0.8, extra = {}) {
  return { id: `n-${title}`, kind: "decision", title, body, weight, ...extra };
}

// v10: a promoted record must carry the span it was distilled from, so a later session
// can replay the originals with `memory_fetch(seq, sessionId)` — not just the excerpt.
test("promote-runner: a node's seqRange becomes sources[].seqRange", () => {
  const nodes = [decision("用的存储是 sqlite", "LTM 落盘选型。", 0.8, { seqRange: [100, 137] })];
  const { records } = runPromotePass({ nodes, sessionId: "sess-9", now: 5 });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].sources[0].seqRange, [100, 137]);
  assert.equal(records[0].sources[0].sessionId, "sess-9", "the session id pairs with the span");
});

test("promote-runner: a node without seqRange produces no seqRange field", () => {
  const nodes = [decision("无锚点", "老节点。", 0.8)];
  const { records } = runPromotePass({ nodes, sessionId: "s", now: 5 });
  assert.equal("seqRange" in records[0].sources[0], false);
});

test("promote-runner: a malformed seqRange is dropped, not stored", () => {
  for (const seqRange of [[], [5], [1, 2, 3], "1-2", null]) {
    const nodes = [decision(`坏锚点-${JSON.stringify(seqRange)}`, "x", 0.8, { seqRange })];
    const { records } = runPromotePass({ nodes, sessionId: "s", now: 5 });
    assert.equal(
      "seqRange" in records[0].sources[0],
      false,
      `seqRange=${JSON.stringify(seqRange)} must not reach the record`,
    );
  }
});

test("promote-runner: selects decisions, drops episodes; body-only-empty node still passes (title carries it)", () => {
  const nodes = [
    decision("用 storage-domain 存 LTM", "配置类决策，权重高。", 0.8),
    { id: "e1", kind: "episode", title: "tool ok", body: "ran a command", weight: 0.9 },
    decision("低权重决定", "无关紧要", 0.1), // below minWeight 0.4 → dropped
    { id: "d2", kind: "decision", title: "空正文但有标题", body: "   ", weight: 0.9 },
  ];
  const { records, stats } = runPromotePass({ nodes, sessionId: "s1", now: 1000 });
  // a (0.8 decision) + d2 (title non-empty passes content gate) — episode and low-weight drop.
  assert.equal(stats.selected, 2, "two real decisions; episode and low-weight dropped");
  const ids = records.map((r) => r.title).sort();
  assert.ok(ids.includes("用 storage-domain 存 LTM"));
  assert.ok(ids.includes("空正文但有标题"));
  assert.equal(records[0].sources[0].sessionId, "s1");
  assert.equal(records[0].sources[0].promotedAt, 1000);
});

test("promote-runner: tasks only promote when they carry a standing-instruction marker", () => {
  const instruction = { id: "t1", kind: "task", title: "今后始终用中文回答", body: "偏好", weight: 1 };
  const chore = { id: "t2", kind: "task", title: "帮我读这个文件", body: "读一下", weight: 1 };
  const { records, stats } = runPromotePass({ nodes: [instruction, chore], sessionId: "s" });
  // "今后始终…" matches the standing-instruction patterns; "帮我读…" is a one-off chore.
  assert.equal(stats.selected, 1);
  assert.equal(records[0].title, "今后始终用中文回答");
});

test("promote-runner: content-hash id is stable across runs (same content → one record)", () => {
  const nodes = [decision("config.retainTokens 改为 15000", "从 12000 调整。")];
  const first = runPromotePass({ nodes, sessionId: "s1", turn: 1, now: 1 });
  // A genuine re-sighting from a *later* turn: still one record, but it updates (hits/rev).
  const second = runPromotePass({ nodes, existing: first.records, sessionId: "s1", turn: 2, now: 2 });
  assert.equal(second.records.length, 1, "no duplicate: same content hashes to one id");
  assert.equal(second.stats.added, 0, "re-promotion adds nothing new");
  assert.equal(second.stats.updated, 1, "a later turn updates the existing record");
});

test("promote-runner: same (session, turn) re-promotion is deduped, not re-counted", () => {
  // The real failure: `agent/pre-step` re-promotes the same node several times per turn,
  // and again each turn, appending a duplicate source every time (measured: 56 sources,
  // all turn 40). A re-sighting from the SAME turn must add nothing.
  const nodes = [decision("config.retainTokens 改为 15000", "从 12000 调整。")];
  const first = runPromotePass({ nodes, sessionId: "s1", turn: 40, now: 1 });
  const again = runPromotePass({ nodes, existing: first.records, sessionId: "s1", turn: 40, now: 2 });
  assert.equal(again.records.length, 1);
  assert.equal(again.stats.added, 0);
  assert.equal(again.stats.updated, 0, "same-turn re-sighting does not bump the record");
  assert.equal(again.records[0].sources.length, 1, "no duplicate source appended");
  assert.equal(again.records[0].rev, 1, "rev does not churn");
  assert.equal(again.records[0].hits, 1, "hits do not churn");
});

test("promote-runner: a newer value of the same subject supersedes the old", () => {
  // Two decisions name the same parameter (subject = config.retaintokens), different values.
  const oldVal = decision("config.retainTokens 是 12000", "初始值。");
  const newVal = decision("config.retainTokens 改为 15000", "调大了。");

  const pass1 = runPromotePass({ nodes: [oldVal], sessionId: "s1", now: 100 });
  const pass2 = runPromotePass({
    nodes: [newVal],
    existing: pass1.records,
    sessionId: "s2",
    now: 200,
  });

  assert.equal(pass2.records.length, 2, "both records kept (supersede marks, never deletes)");
  const live = pass2.records.filter((r) => r.supersededAt == null);
  const retired = pass2.records.filter((r) => r.supersededAt != null);
  assert.equal(live.length, 1, "exactly one live value");
  assert.equal(retired.length, 1, "the old value is superseded, not deleted");
  assert.ok(live[0].title.includes("15000"), "the newer value is the live one");
  assert.equal(pass2.stats.superseded, 1);
});

test("promote-runner: eviction archives down to maxNodes", () => {
  const nodes = [];
  for (let i = 0; i < 5; i += 1) nodes.push(decision(`决定 ${i}`, `内容 ${i}`, 0.5 + i * 0.05));
  const { records, stats } = runPromotePass({
    nodes,
    sessionId: "s",
    limits: { maxNodes: 2 },
  });
  const live = records.filter((r) => r.archived !== true && r.supersededAt == null);
  assert.equal(live.length, 2, "evicted down to budget");
  assert.ok(stats.evicted >= 3 || records.length === 2 || live.length === 2);
});

test("promote-runner: frozen records are never evicted", () => {
  // A standing-instruction task so it is promotable, then freeze it after the first pass.
  const task = { id: "t-must", kind: "task", title: "永远记住这个约束", body: "必须对", weight: 1 };
  const pass1 = runPromotePass({ nodes: [task], sessionId: "s" });
  assert.equal(pass1.records.length, 1, "the standing instruction is promoted");
  const frozen = pass1.records.map((r) => ({ ...r, frozen: true }));
  // Add noise to force eviction pressure (maxNodes=1).
  const noise = [];
  for (let i = 0; i < 5; i += 1) noise.push(decision(`噪声 ${i}`, `n${i}`, 0.9));
  const pass2 = runPromotePass({
    nodes: noise,
    existing: frozen,
    sessionId: "s2",
    limits: { maxNodes: 1 },
  });
  const stillLive = pass2.records.find((r) => r.frozen === true);
  assert.ok(stillLive && stillLive.archived !== true, "frozen record survives eviction");
});

test("promote-runner: reproducible — same input gives identical records", () => {
  const nodes = [decision("config.barrierPolicy 设为 newest", "最新的屏障。")];
  const a = runPromotePass({ nodes, sessionId: "s", now: 42 });
  const b = runPromotePass({ nodes, sessionId: "s", now: 42 });
  assert.deepEqual(a.records, b.records);
});

// --- diffForWrite ---------------------------------------------------------------

test("diffForWrite: new records are put, unchanged are skipped", () => {
  const next = [{ id: "a", rev: 1, archived: false, supersededAt: null, subject: null, supersedes: [] }];
  const { put, deletedIds } = diffForWrite([], next);
  assert.equal(put.length, 1);
  assert.equal(deletedIds.length, 0);

  const again = diffForWrite(next, next);
  assert.equal(again.put.length, 0, "identical store → no writes");
});

test("diffForWrite: rev bump / archival / supersede transitions are put", () => {
  const stored = [{ id: "a", rev: 1, archived: false, supersededAt: null, subject: "x", supersedes: [] }];
  const bumped = [{ id: "a", rev: 2, archived: false, supersededAt: null, subject: "x", supersedes: [] }];
  assert.equal(diffForWrite(stored, bumped).put.length, 1, "rev bump written");

  const archived = [{ id: "a", rev: 1, archived: true, supersededAt: null, subject: "x", supersedes: [] }];
  assert.equal(diffForWrite(stored, archived).put.length, 1, "archival written");

  const superseded = [{ id: "a", rev: 1, archived: false, supersededAt: 5, subject: "x", supersedes: [] }];
  assert.equal(diffForWrite(stored, superseded).put.length, 1, "supersede mark written");
});

test("diffForWrite: an id in the store missing from next is reported as deleted", () => {
  const stored = [{ id: "a" }, { id: "b" }];
  const next = [{ id: "a" }];
  const { deletedIds } = diffForWrite(stored, next);
  assert.deepEqual(deletedIds, ["b"]);
});
