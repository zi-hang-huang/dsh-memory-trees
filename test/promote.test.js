/**
 * v3 promote contract tests.
 *
 * Promote is the only path by which one session can degrade every later session, so
 * the tests lean on the two promises that keep it safe: identity is derived from
 * content (so the store cannot grow by repetition), and nothing that points at a dead
 * session artifact ever gets promoted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LTM_MAX_NODES,
  isSearchable,
  isStandingInstruction,
  ltmId,
  mergeLtm,
  selectPromotable,
  toLtmRecord,
  tombstone,
} from "../lib/promote.js";
import { validateNode } from "../lib/tree.js";

/**
 * Build a session node.
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
    weight: options.weight ?? 0.6,
    pinned: options.pinned ?? false,
    rev: options.rev ?? 1,
    born: options.born ?? 5,
    archived: options.archived ?? false,
  };
}

test("episodes are never promoted, however heavy they are", () => {
  const picked = selectPromotable([
    node("tool-ok", { kind: "episode", weight: 1, title: "tool ok" }),
    node("anchor", { kind: "episode", weight: 1, title: "T4" }),
    node("decision", { kind: "decision", weight: 0.9, title: "picked 8080", body: "80 was taken" }),
  ]);

  assert.deepEqual(picked.map((entry) => entry.id), ["decision"]);
});

test("a decision needs enough weight, a task needs a standing instruction", () => {
  const picked = selectPromotable([
    node("weak", { kind: "decision", weight: 0.2 }),
    node("strong", { kind: "decision", weight: 0.5 }),
    node("one-off", { kind: "task", weight: 1, pinned: true, title: "read that file" }),
    node("rule", { kind: "task", weight: 1, pinned: true, title: "以后所有构建都用 --test-concurrency=1" }),
  ]);

  assert.deepEqual(picked.map((entry) => entry.id).sort(), ["rule", "strong"]);
});

test("isStandingInstruction matches the documented markers and nothing else", () => {
  for (const text of ["以后都用 15000", "记住这个端口", "always use pnpm", "from now on, run it serially"]) {
    assert.equal(isStandingInstruction(text), true, text);
  }
  for (const text of ["读一下那个文件", "帮我看下日志", "run the tests once"]) {
    assert.equal(isStandingInstruction(text), false, text);
  }
});

test("archived and empty nodes are not promoted", () => {
  const picked = selectPromotable([
    node("retired", { kind: "decision", weight: 0.9, archived: true }),
    node("blank", { kind: "decision", weight: 0.9, title: "", body: "" }),
  ]);
  assert.deepEqual(picked, []);
});

test("ltmId is content-derived, so the same fact from two sessions collides", () => {
  const a = node("s10-decision-m0", { title: "Port is 8080.", body: "because 80 was taken" });
  const b = node("s99-decision-m3", { title: "port is 8080", body: "Because  80 was taken." });

  assert.equal(ltmId(a), ltmId(b), "tree ids differ, content does not");
  assert.match(ltmId(a), /^ltm-[0-9a-f]{16}$/);

  const other = node("s10-decision-m1", { title: "Port is 9090", body: "because 80 was taken" });
  assert.notEqual(ltmId(a), ltmId(other));
});

test("toLtmRecord carries provenance and validates as a node", () => {
  const record = toLtmRecord(node("s3-decision-m2", { kind: "decision", weight: 0.7, born: 12 }), {
    sessionId: "session-abc",
    turn: 12,
    seqRange: [40, 91],
    promotedAt: 1_700_000_000_000,
  });

  assert.equal(record.zone, "recall", "LTM renders in the recall zone, never volatile");
  assert.equal(record.kind, "decision");
  assert.equal(record.parentId, null);
  assert.equal(record.hits, 1);
  assert.deepEqual(record.sources, [
    { sessionId: "session-abc", turn: 12, seqRange: [40, 91], promotedAt: 1_700_000_000_000 },
  ]);
  assert.doesNotThrow(() => validateNode(record, "promote"));
});

test("a promoted task is pinned, so eviction cannot drop a standing instruction", () => {
  const record = toLtmRecord(node("t", { kind: "task", weight: 1, pinned: true, title: "记住：始终用 8080" }), {
    sessionId: "s",
    turn: 1,
  });
  assert.equal(record.pinned, true);
});

test("mergeLtm collapses the same content from two sessions into one record", () => {
  const first = toLtmRecord(node("a", { title: "Port is 8080", body: "80 was taken", weight: 0.5, born: 10 }), {
    sessionId: "session-1",
    turn: 10,
  });
  const second = toLtmRecord(node("b", { title: "port is 8080", body: "80 was taken.", weight: 0.8, born: 4 }), {
    sessionId: "session-2",
    turn: 4,
  });

  const { records, stats } = mergeLtm([first], [second]);

  assert.equal(records.length, 1, "repetition must not grow the store");
  assert.equal(stats.added, 0);
  assert.equal(stats.updated, 1);
  assert.equal(records[0].hits, 2);
  assert.equal(records[0].weight, 0.8, "keeps the strongest mention");
  assert.equal(records[0].born, 4, "keeps the earliest birth");
  assert.equal(records[0].sources.length, 2, "both provenances are kept");
  assert.deepEqual(records[0].sources.map((entry) => entry.sessionId), ["session-1", "session-2"]);
});

test("mergeLtm evicts the lightest and oldest first, and pins survive", () => {
  const records = [
    toLtmRecord(node("light", { title: "light", weight: 0.1, born: 1 }), { sessionId: "s", turn: 1 }),
    toLtmRecord(node("heavy", { title: "heavy", weight: 0.9, born: 1 }), { sessionId: "s", turn: 1 }),
    toLtmRecord(node("pinned", { kind: "task", title: "记住：端口 8080", weight: 1, pinned: true }), {
      sessionId: "s",
      turn: 1,
    }),
  ];

  const { records: merged, stats } = mergeLtm([], records, { maxNodes: 2 });

  assert.equal(stats.evicted, 1);
  assert.equal(merged.find((entry) => entry.id === ltmId(node("light", { title: "light" }))).archived, true);
  assert.equal(merged.filter((entry) => entry.archived !== true).length, 2);
  assert.ok(
    merged.some((entry) => entry.kind === "task" && entry.archived !== true),
    "a standing instruction outranks the budget",
  );
});

test("mergeLtm is deterministic for the same input", () => {
  const seed = [
    toLtmRecord(node("a", { title: "a", weight: 0.3, born: 2 }), { sessionId: "s", turn: 2 }),
    toLtmRecord(node("b", { title: "b", weight: 0.3, born: 1 }), { sessionId: "s", turn: 1 }),
    toLtmRecord(node("c", { title: "c", weight: 0.3, born: 3 }), { sessionId: "s", turn: 3 }),
  ];

  const first = mergeLtm([], seed, { maxNodes: 2 }).records.map((entry) => [entry.title, entry.archived]);
  const second = mergeLtm([], [...seed].reverse(), { maxNodes: 2 }).records.map((entry) => [entry.title, entry.archived]);

  assert.deepEqual(
    first.slice().sort(),
    second.slice().sort(),
    "eviction must not depend on the order records arrive in",
  );
});

test("the default node ceiling is a real number the store can be held to", () => {
  assert.equal(DEFAULT_LTM_MAX_NODES, 500);
});

// -----------------------------------------------------------------------------
// Phase A: supersede / tombstone / frozen / searchable predicates
//
// The store used to have no way to say "this value is outdated". Identity is a
// content hash, so two different values of the same fact are two records that both
// match a keyword query — the model can be handed a stale value. These tests pin the
// replacement: a new record cites the old one, the old one is tombstoned (body
// cleared, provenance kept) rather than deleted, because the old value is the only
// evidence that the new one is right. See dsh-memory-promote-plan.md §3.1 / §6.1.
// -----------------------------------------------------------------------------

test("toLtmRecord defaults the supersede fields without changing existing output", () => {
  const record = toLtmRecord(
    { kind: "decision", title: "retainTokens 是 15000", body: "已从 12000 调整。", weight: 0.8, born: 12 },
    { sessionId: "s1", turn: 12 },
  );

  assert.equal(record.subject, null);
  assert.deepEqual(record.supersedes, []);
  assert.equal(record.supersededAt, null);
  assert.equal(record.frozen, false);
  // Nothing that existed before may disappear.
  assert.match(record.id, /^ltm-[0-9a-f]{16}$/);
  assert.equal(record.zone, "recall");
  assert.equal(record.hits, 1);
  assert.equal(record.sources.length, 1);
  assert.doesNotThrow(() => validateNode(record, "promote"));
});

test("toLtmRecord accepts an explicit subject", () => {
  const record = toLtmRecord(
    { kind: "decision", title: "T", body: "B", weight: 0.8, born: 1 },
    { sessionId: "s1", turn: 1, subject: "config.retain_tokens" },
  );
  assert.equal(record.subject, "config.retain_tokens");
});

test("a subject is normalized to lower case and trimmed", () => {
  const record = toLtmRecord(
    { kind: "decision", title: "T", body: "B", weight: 0.8, born: 1 },
    { sessionId: "s1", subject: "  Config.RetainTokens  " },
  );
  assert.equal(record.subject, "config.retaintokens");
});

test("a blank subject normalizes to null rather than an empty string", () => {
  const record = toLtmRecord(
    { kind: "decision", title: "T", body: "B", weight: 0.8, born: 1 },
    { sessionId: "s1", subject: "   " },
  );
  assert.equal(record.subject, null);
});

test("a new record with the same subject supersedes the old one", () => {
  const oldRec = toLtmRecord(
    { kind: "decision", title: "retainTokens 是 15000", body: "旧值", weight: 0.8, born: 1 },
    { sessionId: "s1", turn: 1, subject: "config.retain_tokens" },
  );
  const newRec = toLtmRecord(
    { kind: "decision", title: "retainTokens 是 20000", body: "新值", weight: 0.9, born: 9 },
    { sessionId: "s2", turn: 9, subject: "config.retain_tokens" },
  );

  const { records, stats } = mergeLtm([oldRec], [newRec], { now: 1000 });
  const byId = new Map(records.map((entry) => [entry.id, entry]));

  assert.equal(byId.get(oldRec.id).supersededAt, 1000, "old must be marked superseded");
  assert.deepEqual(byId.get(newRec.id).supersedes, [oldRec.id], "new must cite the old id");
  assert.equal(stats.superseded, 1);
  assert.ok(byId.has(oldRec.id), "a superseded record must not be removed");
});

test("different subjects never supersede each other", () => {
  const a = toLtmRecord({ kind: "decision", title: "A", body: "", weight: 0.8, born: 1 }, { sessionId: "s1", subject: "config.a" });
  const b = toLtmRecord({ kind: "decision", title: "B", body: "", weight: 0.8, born: 2 }, { sessionId: "s1", subject: "config.b" });

  const { records, stats } = mergeLtm([a], [b], { now: 1000 });
  assert.equal(stats.superseded, 0);
  assert.equal(records.find((entry) => entry.id === a.id).supersededAt, null);
});

test("records without a subject never supersede anything", () => {
  const a = toLtmRecord({ kind: "decision", title: "A", body: "", weight: 0.8, born: 1 }, { sessionId: "s1" });
  const b = toLtmRecord({ kind: "decision", title: "B", body: "", weight: 0.8, born: 2 }, { sessionId: "s1" });
  assert.equal(mergeLtm([a], [b], { now: 1000 }).stats.superseded, 0);
});

test("a frozen record is never superseded", () => {
  const oldRec = toLtmRecord(
    { kind: "decision", title: "固定值", body: "", weight: 0.8, born: 1 },
    { sessionId: "s1", subject: "cfg.x", frozen: true },
  );
  const newRec = toLtmRecord(
    { kind: "decision", title: "新值", body: "", weight: 0.9, born: 9 },
    { sessionId: "s2", subject: "cfg.x" },
  );
  assert.equal(mergeLtm([oldRec], [newRec], { now: 1000 }).stats.superseded, 0, "frozen outranks supersede");
});

test("superseding uses options.now so the same input stays reproducible", () => {
  const oldRec = toLtmRecord({ kind: "decision", title: "旧", body: "", weight: 0.8, born: 1 }, { sessionId: "s1", subject: "cfg.x" });
  const newRec = toLtmRecord({ kind: "decision", title: "新", body: "", weight: 0.9, born: 2 }, { sessionId: "s2", subject: "cfg.x" });

  const first = mergeLtm([oldRec], [newRec], { now: 777 }).records.find((entry) => entry.id === oldRec.id);
  const second = mergeLtm([oldRec], [newRec], { now: 777 }).records.find((entry) => entry.id === oldRec.id);
  assert.equal(first.supersededAt, 777);
  assert.deepEqual(first, second);
});

test("tombstone clears the body but keeps the audit trail", () => {
  const oldRec = toLtmRecord(
    { kind: "decision", title: "旧标题", body: "很长的一段旧正文内容", weight: 0.8, born: 1 },
    { sessionId: "s1", turn: 1, subject: "cfg.x" },
  );
  const newRec = toLtmRecord(
    { kind: "decision", title: "新标题", body: "新正文", weight: 0.9, born: 9 },
    { sessionId: "s2", turn: 9, subject: "cfg.x" },
  );

  const { records } = mergeLtm([oldRec], [newRec], { tombstone: true, now: 1000 });
  const old = records.find((entry) => entry.id === oldRec.id);

  assert.equal(old.body, "", "body must be cleared");
  assert.equal(old.title, "旧标题", "title survives — it is how a human finds it");
  assert.equal(old.subject, "cfg.x");
  assert.deepEqual(old.sources, oldRec.sources, "sources survive for audit");
  assert.equal(old.supersededAt, 1000);
});

test("tombstone is off by default so nothing is destroyed silently", () => {
  const oldRec = toLtmRecord({ kind: "decision", title: "T", body: "旧", weight: 0.8, born: 1 }, { sessionId: "s1", subject: "cfg.x" });
  const newRec = toLtmRecord({ kind: "decision", title: "N", body: "新", weight: 0.9, born: 9 }, { sessionId: "s2", subject: "cfg.x" });
  const { records } = mergeLtm([oldRec], [newRec], { now: 1 });
  assert.equal(records.find((entry) => entry.id === oldRec.id).body, "旧");
});

test("a record can be tombstoned directly (for /memory forget parity)", () => {
  const record = toLtmRecord({ kind: "decision", title: "T", body: "B", weight: 0.8, born: 1 }, { sessionId: "s1" });
  const out = tombstone(record, { now: 5 });
  assert.equal(out.body, "");
  assert.equal(out.supersededAt, 5);
});

test("tombstones do not consume the node budget", () => {
  // Otherwise a year of supersedes fills all 500 slots with emptied records and
  // crowds out the knowledge the budget exists to protect.
  const dead = [
    toLtmRecord({ kind: "decision", title: "旧 A", body: "x".repeat(40), weight: 0.5, born: 1 }, { sessionId: "s1", subject: "cfg.a" }),
    toLtmRecord({ kind: "decision", title: "旧 B", body: "y".repeat(40), weight: 0.5, born: 2 }, { sessionId: "s1", subject: "cfg.b" }),
  ];
  const winners = [
    toLtmRecord({ kind: "decision", title: "新 A", body: "z", weight: 0.9, born: 10 }, { sessionId: "s2", subject: "cfg.a" }),
    toLtmRecord({ kind: "decision", title: "新 B", body: "w", weight: 0.9, born: 11 }, { sessionId: "s2", subject: "cfg.b" }),
  ];

  const { records, stats } = mergeLtm(dead, winners, { maxNodes: 2, tombstone: true, now: 99 });

  assert.equal(stats.superseded, 2);
  assert.equal(stats.evicted, 0, "two tombstones plus two live records must fit a budget of two");
  assert.equal(stats.kept, 2, "only the live records count");
  assert.ok(records.every((entry) => entry.archived !== true), "nothing needs evicting");
});

test("a repeated merge is idempotent: the same supersede is not counted twice", () => {
  const oldRec = toLtmRecord({ kind: "decision", title: "旧", body: "", weight: 0.5, born: 1 }, { sessionId: "s1", subject: "cfg.x" });
  const newRec = toLtmRecord({ kind: "decision", title: "新", body: "", weight: 0.9, born: 2 }, { sessionId: "s2", subject: "cfg.x" });

  const once = mergeLtm([oldRec], [newRec], { now: 100 });
  const twice = mergeLtm(once.records, [newRec], { now: 100 });

  assert.equal(once.stats.superseded, 1);
  assert.equal(twice.stats.superseded, 0, "already-marked records are not re-superseded");
  assert.deepEqual(
    twice.records.find((entry) => entry.id === newRec.id).supersedes,
    [oldRec.id],
    "the supersedes list does not grow on replay",
  );
});

test("frozen records are never evicted, even over budget", () => {
  const frozen = {
    ...toLtmRecord({ kind: "decision", title: "关键", body: "x".repeat(50), weight: 0.01, born: 1 }, { sessionId: "s1" }),
    frozen: true,
  };
  const light = toLtmRecord({ kind: "decision", title: "轻", body: "y".repeat(50), weight: 0.9, born: 2 }, { sessionId: "s1" });

  const { records, stats } = mergeLtm([frozen, light], [], { maxNodes: 1 });

  assert.notEqual(records.find((entry) => entry.id === frozen.id)?.archived, true, "frozen must survive");
  assert.equal(stats.kept, 1, "the light one goes instead");
});

test("if everything left is frozen, the budget overruns on purpose", () => {
  const a = { ...toLtmRecord({ kind: "decision", title: "A", body: "", weight: 0.1, born: 1 }, { sessionId: "s1" }), frozen: true };
  const b = { ...toLtmRecord({ kind: "decision", title: "B", body: "", weight: 0.1, born: 2 }, { sessionId: "s1" }), frozen: true };

  const { stats } = mergeLtm([a, b], [], { maxNodes: 1 });
  assert.equal(stats.kept, 2, "an intentional overrun is a signal, not a bug");
});

test("isSearchable rejects archived, forgotten and superseded records", () => {
  const base = { id: "ltm-aaaaaaaaaaaaaaaa", title: "T", body: "B" };
  assert.equal(isSearchable(base), true);
  assert.equal(isSearchable({ ...base, archived: true }), false);
  assert.equal(isSearchable({ ...base, forgottenAt: 1 }), false);
  assert.equal(isSearchable({ ...base, supersededAt: 1 }), false);
  assert.equal(isSearchable(null), false);
  assert.equal(isSearchable(undefined), false);
});

test("isSearchable excludes tombstones via the superseded stamp", () => {
  // A tombstone has no body, but the rule that excludes it is `supersededAt` — so the
  // two mechanisms cannot drift apart.
  const dead = toLtmRecord({ kind: "decision", title: "旧", body: "旧正文", weight: 0.5, born: 1 }, { sessionId: "s1", subject: "cfg.x" });
  const live = toLtmRecord({ kind: "decision", title: "新", body: "新正文", weight: 0.9, born: 2 }, { sessionId: "s2", subject: "cfg.x" });
  const { records } = mergeLtm([dead], [live], { tombstone: true, now: 5 });

  const deadRecord = records.find((entry) => entry.id === dead.id);
  const liveRecord = records.find((entry) => entry.id === live.id);
  assert.equal(deadRecord.body, "", "precondition: it really is a tombstone");
  assert.equal(isSearchable(deadRecord), false);
  assert.equal(isSearchable(liveRecord), true);
});

test("a whole merged store yields exactly the live records when filtered", () => {
  const a = toLtmRecord({ kind: "decision", title: "活", body: "内容", weight: 0.8, born: 1 }, { sessionId: "s1", subject: "cfg.x" });
  const b = toLtmRecord({ kind: "decision", title: "旧", body: "旧内容", weight: 0.3, born: 1 }, { sessionId: "s1", subject: "cfg.x" });
  const { records } = mergeLtm([b], [a], { tombstone: true, now: 9 });

  const searchable = records.filter(isSearchable);
  assert.equal(searchable.length, 1);
  assert.equal(searchable[0].title, "活");
});
