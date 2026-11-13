/**
 * Tests for lib/ltm-store.js — read/write seam over a table adapter, plus an end-to-end
 * "promote writes → recall reads" flow using a Map-backed fake table. No host imports.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readAllRecords,
  readSearchableRecords,
  applyWriteDiff,
} from "../lib/ltm-store.js";
import { runPromotePass, diffForWrite } from "../lib/promote-runner.js";
import { recall } from "../lib/recall.js";

/** Minimal in-memory fake of a dsh-storage-domain KvTableImpl. */
function fakeTable(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (k) => map.get(k),
    entries: () => [...map.entries()][Symbol.iterator](),
    put: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => map.delete(k),
    size: () => map.size,
  };
}

function record(id, over = {}) {
  return {
    id,
    zone: "recall",
    kind: "decision",
    title: "t",
    body: "b",
    weight: 0.8,
    pinned: false,
    rev: 1,
    born: 1,
    archived: false,
    firstSeenTurn: 1,
    hits: 1,
    sources: [{ sessionId: "s", turn: 1, promotedAt: 1 }],
    subject: null,
    supersedes: [],
    supersededAt: null,
    frozen: false,
    ...over,
  };
}

test("ltm-store: readAllRecords returns everything, readSearchable filters retired", () => {
  const table = fakeTable({
    a: record("a"),
    b: record("b", { archived: true }),
    c: record("c", { supersededAt: 5 }),
    d: record("d", { forgottenAt: 9 }), // not a schema field but isSearchable checks it
  });
  assert.equal(readAllRecords(table).length, 4);
  const searchable = readSearchableRecords(table);
  assert.deepEqual(searchable.map((r) => r.id), ["a"], "only the live, unretired record is searchable");
});

test("ltm-store: applyWriteDiff puts and deletes, counting outcomes", async () => {
  const table = fakeTable({ old: record("old") });
  const diff = {
    put: [record("new"), record("old", { rev: 2 })],
    deletedIds: ["ghost"],
  };
  const res = await applyWriteDiff(table, diff);
  assert.equal(res.written, 2);
  assert.equal(res.deleted, 0, "ghost did not exist → delete counted 0");
  assert.equal(table.get("new").id, "new");
  assert.equal(table.get("old").rev, 2);
});

test("ltm-store: applyWriteDiff collects per-record errors without aborting", async () => {
  const bad = {
    get: () => undefined,
    entries: () => [][Symbol.iterator](),
    put: async (k) => {
      if (k === "boom") throw new Error("disk full");
    },
    delete: async () => true,
  };
  const res = await applyWriteDiff(bad, { put: [record("ok"), record("boom")], deletedIds: [] });
  assert.equal(res.written, 1, "the good record still wrote");
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /boom/);
});

test("ltm-store: end-to-end — promote a decision, write it, recall finds it", async () => {
  const table = fakeTable();

  // 1. A session tree with one promotable decision.
  const nodes = [
    { id: "n1", kind: "decision", title: "config.retainTokens 改为 15000", body: "从 12000 调大。", weight: 0.9 },
  ];

  // 2. Promote pass over the current store contents.
  const existing = readAllRecords(table);
  const { records } = runPromotePass({ nodes, existing, sessionId: "sess-1", now: 500 });

  // 3. Write only what changed.
  const diff = diffForWrite(existing, records);
  const res = await applyWriteDiff(table, diff);
  assert.equal(res.written, 1, "the decision is now in the store");

  // 4. Read back via the recall-facing accessor.
  const searchable = readSearchableRecords(table);
  assert.equal(searchable.length, 1);
  const rec = searchable[0];
  assert.ok(rec.title.includes("15000"));
  assert.equal(rec.subject, "config.retaintokens", "subject extracted for future supersede");
  assert.equal(rec.sources[0].sessionId, "sess-1");
});

test("ltm-store: end-to-end — a second promote of the same content is idempotent (no dupes)", async () => {
  const table = fakeTable();
  const nodes = [
    { id: "n1", kind: "decision", title: "config.barrierPolicy 设为 newest", body: "最新的屏障。", weight: 0.9 },
  ];

  for (const now of [100, 200]) {
    const existing = readAllRecords(table);
    const { records } = runPromotePass({ nodes, existing, sessionId: "sess-1", now });
    await applyWriteDiff(table, diffForWrite(existing, records));
  }

  const searchable = readSearchableRecords(table);
  assert.equal(searchable.length, 1, "re-promoting the same fact does not duplicate it");
});

test("ltm-store: cross-session recall — a record promoted in session A is recallable with no session log", async () => {
  // This is the fix for "a new session cannot read LTM": the pre-step block now recalls
  // from the LTM store directly (readSearchableRecords → recall), not from a session log.
  // Neither the promoting session nor this one supplies any event log to `recall` — only
  // the store — which is exactly how a fresh session would query it.
  const table = fakeTable();
  const nodes = [
    { id: "n1", kind: "decision", title: "论文是闭源 subscription", body: "Zotero 条目确认 non-open-access。", weight: 0.9 },
  ];
  const existing = readAllRecords(table);
  const { records } = runPromotePass({ nodes, existing, sessionId: "session-A", now: 1 });
  await applyWriteDiff(table, diffForWrite(existing, records));

  // A brand-new session issues a query against the shared store only.
  const searchable = readSearchableRecords(table);
  const { block, hits } = recall(searchable, "这篇论文是不是闭源", {
    enabled: true,
    budget: 1200,
    topK: 5,
    maxExtra: 2,
  });
  assert.ok(hits.length >= 1, "the cross-session record is recalled");
  assert.ok(block.length > 0, "a non-empty block is produced for the pre-step to inject");
  assert.ok(block.includes("闭源") || block.includes("subscription"), "the recalled text is the stored fact");
});

test("ltm-store: a same-turn re-promote does not inflate sources (the 56→1 fix, end to end)", async () => {
  const table = fakeTable();
  const nodes = [
    { id: "n1", kind: "decision", title: "config.retainTokens 12000", body: "评估模式配置。", weight: 0.8, born: 40 },
  ];
  // Simulate many pre-step promotes within the SAME turn 40 (the live failure mode).
  for (let i = 0; i < 20; i += 1) {
    const existing = readAllRecords(table);
    const { records } = runPromotePass({ nodes, existing, sessionId: "s", now: 1000 + i });
    await applyWriteDiff(table, diffForWrite(existing, records));
  }
  const rec = readSearchableRecords(table)[0];
  assert.equal(rec.sources.length, 1, "20 same-turn promotes leave exactly one source");
  assert.equal(rec.rev, 1, "rev stays 1 (no churn)");
});
