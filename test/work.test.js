/**
 * Tests for v8 work grouping: lib/work.js (extractWork), promote.js (work field +
 * applyWorkPivots), promote-runner (work pass-through + diff), recall (familyOf work
 * priority + pivot expansion + render).
 *
 * The load-bearing properties under test:
 *   - the work key carries NO date (same work ⇒ same key across days/sessions)
 *   - work is the strongest family edge, ahead of subject/session
 *   - a pivot is created lazily (only at ≥2 live records), links its members, and is
 *     idempotent
 *   - pre-v8 records (no work) behave exactly as before
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractWork, normaliseWorkName } from "../lib/work.js";
import { toLtmRecord, mergeLtm, applyWorkPivots, applyWorkNames, applyWorkSplit, pivotIdFor } from "../lib/promote.js";
import { runPromotePass, diffForWrite } from "../lib/promote-runner.js";
import { expandRecall } from "../lib/recall.js";
import { parseWorkNames, buildWorkNamingInstruction, renderWorkGroup, normalizeSplitPlan, isLikelySingleTopic } from "../lib/work-name.js";

/** A minimal promotable decision node. */
function decision(title, body, weight = 0.8, extra = {}) {
  return { id: `n-${title}`, kind: "decision", title, body, weight, ...extra };
}

// ---------------------------------------------------------------- work.js

test("work: normalises case/space and prefixes work:", () => {
  assert.equal(extractWork({ name: "  LTM 组织性  " }), "work:ltm 组织性");
  assert.equal(normaliseWorkName("  Foo _bar_ "), "foo _bar");
});

test("work: carries NO date — same project name always yields the same key", () => {
  // There is deliberately no `now` input; two calls are identical regardless of when.
  const a = extractWork({ name: "proj-x" });
  const b = extractWork({ name: "proj-x" });
  assert.equal(a, b);
  assert.equal(a, "work:proj-x");
});

test("work: generic/empty name falls back to the supplied fallback, else null", () => {
  assert.equal(extractWork({ name: "default-workspace", fallback: "sess42" }), "work:sess42");
  assert.equal(extractWork({ name: "", fallback: "sess42" }), "work:sess42");
  assert.equal(extractWork({ name: "", fallback: "" }), null);
});

test("work: namer hook overrides name (the v8-b seam) without changing key format", () => {
  const key = extractWork({ name: "ignored" }, { namer: () => "提炼出的名字" });
  assert.equal(key, "work:提炼出的名字");
});

// ------------------------------------------------- toLtmRecord + merge field

test("promote: toLtmRecord carries work and pivotId (defaults off)", () => {
  const node = decision("config.retainTokens 改为 15000", "从 12000 调整。");
  const withWork = toLtmRecord(node, { sessionId: "s", work: "work:proj-x" });
  assert.equal(withWork.work, "work:proj-x");
  assert.equal(withWork.pivotId, null);
  const noWork = toLtmRecord(node, { sessionId: "s" });
  assert.equal(noWork.work, null);
});

test("promote: merge keeps work across a re-promotion", () => {
  const node = decision("fact", "body", 0.8);
  const first = mergeLtm([], [toLtmRecord(node, { sessionId: "s", turn: 1, work: "work:p" })]);
  const second = mergeLtm(first.records, [
    toLtmRecord(node, { sessionId: "s", turn: 2, work: "work:p" }),
  ]);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].work, "work:p", "work survives the merge/update");
});

// ------------------------------------------------------------ pivot lazy-build

test("pivot: not created for a lone record under a work", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("only one", "b", 0.8), { sessionId: "s", work: "work:p" }),
  ]).records;
  const out = applyWorkPivots(records, { now: 1 });
  assert.equal(out.stats.pivotsCreated, 0, "a lone record gets no pivot");
  assert.ok(!out.records.some((r) => r.kind === "work-summary"));
});

test("pivot: created at 2 live records, members linked, is idempotent", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("fact a", "body a", 0.8), { sessionId: "s", work: "work:p" }),
    toLtmRecord(decision("fact b", "body b", 0.9), { sessionId: "s", work: "work:p" }),
  ]).records;

  const out1 = applyWorkPivots(records, { now: 1 });
  assert.equal(out1.stats.pivotsCreated, 1, "one pivot for the work");
  const pid = pivotIdFor("work:p");
  const pivot = out1.records.find((r) => r.id === pid);
  assert.ok(pivot, "pivot exists with the stable id");
  assert.equal(pivot.kind, "work-summary");
  const members = out1.records.filter((r) => r.work === "work:p" && r.kind !== "work-summary");
  assert.equal(members.length, 2);
  for (const m of members) {
    assert.equal(m.parentId, pid, "member points at the pivot");
    assert.equal(m.pivotId, pid);
  }

  // Idempotent: re-running on the pivoted set creates nothing new and links nothing new.
  const out2 = applyWorkPivots(out1.records, { now: 2 });
  assert.equal(out2.stats.pivotsCreated, 0);
  assert.equal(out2.stats.pivotsLinked, 0);
});

// Regression (v10-fix): a budget-eviction pass can archive a pivot while its members stay
// live. Because the pivot id is content-independent, later re-linking used to silently
// attach members to the archived pivot forever, hiding the group. A work with ≥2 live
// members must always end up with a LIVE pivot.
test("pivot: an archived pivot is revived when its work still has ≥2 live members", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("fact a", "body a", 0.8), { sessionId: "s", work: "work:p" }),
    toLtmRecord(decision("fact b", "body b", 0.9), { sessionId: "s", work: "work:p" }),
  ]).records;
  const pivoted = applyWorkPivots(records, { now: 1 }).records;
  const pid = pivotIdFor("work:p");
  // Simulate a prior eviction archiving the pivot while both members stayed live.
  const evicted = pivoted.map((r) => (r.id === pid ? { ...r, archived: true } : r));
  assert.equal(evicted.find((r) => r.id === pid).archived, true);

  const out = applyWorkPivots(evicted, { now: 2 });
  const pivot = out.records.find((r) => r.id === pid);
  assert.equal(pivot.archived, false, "pivot must be revived for a work with ≥2 live members");
  assert.equal(out.stats.pivotsRevived, 1);
  const members = out.records.filter((r) => r.work === "work:p" && r.kind !== "work-summary");
  for (const m of members) assert.equal(m.pivotId, pid, "member re-linked to the live pivot");
});

test("pivot: an archived pivot whose group dissolved below 2 stays archived", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("fact a", "body a", 0.8), { sessionId: "s", work: "work:p" }),
    toLtmRecord(decision("fact b", "body b", 0.9), { sessionId: "s", work: "work:p" }),
  ]).records;
  const pivoted = applyWorkPivots(records, { now: 1 }).records;
  const pid = pivotIdFor("work:p");
  // Archive the pivot and leave only ONE live member (below the ≥2 pivot threshold).
  const shrunk = pivoted.map((r) => {
    if (r.id === pid) return { ...r, archived: true };
    if (r.work === "work:p" && r.kind !== "work-summary" && r.title === "fact b") {
      return { ...r, archived: true };
    }
    return r;
  });
  const out = applyWorkPivots(shrunk, { now: 2 });
  const pivot = out.records.find((r) => r.id === pid);
  assert.equal(pivot.archived, true, "no revival when fewer than 2 live members remain");
  assert.equal(out.stats.pivotsRevived, 0);
});

test("pivot: two different works get two independent pivots", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("a1", "x", 0.8), { sessionId: "s", work: "work:p1" }),
    toLtmRecord(decision("a2", "y", 0.8), { sessionId: "s", work: "work:p1" }),
    toLtmRecord(decision("b1", "z", 0.8), { sessionId: "s", work: "work:p2" }),
    toLtmRecord(decision("b2", "w", 0.8), { sessionId: "s", work: "work:p2" }),
  ]).records;
  const out = applyWorkPivots(records, { now: 1 });
  assert.equal(out.stats.pivotsCreated, 2);
  assert.notEqual(pivotIdFor("work:p1"), pivotIdFor("work:p2"));
});

// ----------------------------------------------------- runner pass-through

test("runner: work input stamps every promoted record; diff rewrites on work change", () => {
  const nodes = [decision("fact", "body", 0.8)];
  const { records } = runPromotePass({ nodes, sessionId: "s", now: 1, work: "work:p" });
  assert.equal(records[0].work, "work:p");

  // A stored record without work → a new pass (later turn = new sighting) with work must emit a put.
  const stored = mergeLtm([], [toLtmRecord(nodes[0], { sessionId: "s", turn: 1 })]).records;
  const next = runPromotePass({ nodes, existing: stored, sessionId: "s", turn: 2, now: 2, work: "work:p" });
  const diff = diffForWrite(stored, next.records);
  assert.ok(diff.put.length >= 1, "work change forces a rewrite even if rev is unchanged");
});

test("runner: no work input ⇒ pre-v8 behaviour (records carry work:null, no pivots)", () => {
  const nodes = [decision("a", "x", 0.8), decision("b", "y", 0.8)];
  const { records, stats } = runPromotePass({ nodes, sessionId: "s", now: 1 });
  assert.ok(records.every((r) => r.work == null));
  assert.equal(stats.pivotsCreated, 0);
  assert.ok(!records.some((r) => r.kind === "work-summary"));
});

// ---------------------------------------------------------- recall edges

test("recall: same work is one family and expands together (work beats subject)", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("fact a", "body a", 0.8), { sessionId: "s", work: "work:p" }),
    toLtmRecord(decision("fact b", "body b", 0.8), { sessionId: "s", work: "work:p" }),
  ]).records;
  const [a, b] = records;
  const extra = expandRecall(records, [a.id], { maxExtra: 5 });
  assert.ok(extra.includes(b.id), "the sibling from the same work is brought back");
});

test("recall: a hit on a member first brings its pivot", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("fact a", "body a", 0.8), { sessionId: "s", work: "work:p" }),
    toLtmRecord(decision("fact b", "body b", 0.8), { sessionId: "s", work: "work:p" }),
  ]).records;
  const pivoted = applyWorkPivots(records, { now: 1 }).records;
  const pid = pivotIdFor("work:p");
  const member = pivoted.find((r) => r.kind !== "work-summary");
  const extra = expandRecall(pivoted, [member.id], { maxExtra: 5 });
  assert.ok(extra.includes(pid), "pivot is expanded in first");
});

test("recall: records without work keep the subject/session family (regression)", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("config.a", "x", 0.8), { sessionId: "s" }),
    toLtmRecord(decision("config.b", "y", 0.8), { sessionId: "s" }),
  ]).records;
  const [a, b] = records;
  // Both share subject family 'config' → expansion still links them, as in v7.
  const extra = expandRecall(records, [a.id], { maxExtra: 5 });
  assert.ok(extra.includes(b.id), "subject-family expansion unchanged when no work");
});

// -------------------------------------------------------- determinism

test("determinism: same nodes + work ⇒ byte-identical records across runs", () => {
  const nodes = [
    decision("fact a", "body a", 0.8),
    decision("fact b", "body b", 0.9),
  ];
  const run = () =>
    JSON.stringify(
      runPromotePass({ nodes, sessionId: "s", turn: 3, now: 1000, work: "work:p" }).records,
    );
  assert.equal(run(), run(), "two identical calls must produce identical stores");
});

// ============================================================ v8-b: work naming

test("work-name: parse model answer into a key→name map (fenced + bare)", () => {
  const keys = ["work:abc123", "work:def456"];
  const fenced =
    '```json\n[{"work":"work:abc123","name":"LTM 改造"},{"work":"work:def456","name":"氢传感论文"}]\n```';
  const m1 = parseWorkNames(fenced, keys);
  assert.equal(m1.get("work:abc123"), "LTM 改造");
  assert.equal(m1.get("work:def456"), "氢传感论文");

  const bare = '[{"work":"work:abc123","name":"LTM 改造"}]';
  const m2 = parseWorkNames(bare, keys);
  assert.equal(m2.get("work:abc123"), "LTM 改造");
  assert.equal(m2.size, 1);
});

test("work-name: ignores unknown keys, empty names, and junk rows (safe partial)", () => {
  const keys = ["work:abc123"];
  const m = parseWorkNames(
    '[{"work":"work:unknown","name":"x"},{"work":"work:abc123","name":""},{"nope":1},"bad",{"work":"work:abc123","name":"好名字"}]',
    keys,
  );
  assert.equal(m.size, 1, "only the one valid row survives");
  assert.equal(m.get("work:abc123"), "好名字");
});

test("work-name: unparseable answer yields an empty map, never throws", () => {
  assert.equal(parseWorkNames("I cannot do that", ["work:a"]).size, 0);
  assert.equal(parseWorkNames("", ["work:a"]).size, 0);
  assert.equal(parseWorkNames("```json\n{not json\n```", ["work:a"]).size, 0);
});

test("work-name: instruction lists every key and asks for the JSON contract", () => {
  const instr = buildWorkNamingInstruction({ keys: ["work:a", "work:b"] });
  assert.ok(instr.includes("work:a") && instr.includes("work:b"));
  assert.ok(instr.includes("同一件事"), "must ask for the merge signal (same name)");
});

test("work-name: renderWorkGroup is bounded and lists samples", () => {
  const g = renderWorkGroup({
    key: "work:a",
    samples: [{ title: "t1", body: "b1" }, { title: "t2", body: "b2" }],
  });
  assert.ok(g.includes("work:a"));
  assert.ok(g.includes("t1"));
  assert.ok(g.length <= 600);
});

test("applyWorkNames: renames temp keys and MERGES two keys mapped to the same name", () => {
  // Two sessions, each with 2 records, each a temp per-session work key.
  const records = mergeLtm([], [
    toLtmRecord(decision("a1", "x", 0.8), { sessionId: "s", work: "work:aaa111" }),
    toLtmRecord(decision("a2", "y", 0.8), { sessionId: "s", work: "work:aaa111" }),
    toLtmRecord(decision("b1", "z", 0.8), { sessionId: "s", work: "work:bbb222" }),
    toLtmRecord(decision("b2", "w", 0.8), { sessionId: "s", work: "work:bbb222" }),
  ]).records;
  // Build pivots under the temp keys first (as the hot path would).
  const pivoted = applyWorkPivots(records, { now: 1 }).records;
  assert.equal(pivoted.filter((r) => r.kind === "work-summary").length, 2, "two temp pivots");

  // Model says both temp keys are the SAME work.
  const mapping = new Map([
    ["work:aaa111", "LTM 组织性改造"],
    ["work:bbb222", "LTM 组织性改造"],
  ]);
  const out = applyWorkNames(pivoted, mapping, { now: 2 });

  const members = out.records.filter((r) => r.kind !== "work-summary" && r.work === "work:ltm 组织性改造");
  assert.equal(members.length, 4, "all 4 records merged into one work");
  // Old temp pivots retired; one new merged pivot with 4 children.
  const livePivots = out.records.filter((r) => r.kind === "work-summary" && r.archived !== true);
  assert.equal(livePivots.length, 1, "one pivot for the merged work");
  const pid = livePivots[0].id;
  for (const m of members) assert.equal(m.parentId, pid, "members hang off the merged pivot");
});

test("applyWorkNames: partial mapping leaves unmapped temp keys untouched; idempotent", () => {
  const records = mergeLtm([], [
    toLtmRecord(decision("a1", "x", 0.8), { sessionId: "s", work: "work:aaa111" }),
    toLtmRecord(decision("b1", "z", 0.8), { sessionId: "s", work: "work:bbb222" }),
  ]).records;
  const mapping = new Map([["work:aaa111", "已命名的工作"]]);
  const out = applyWorkNames(records, mapping, { now: 1 });
  const a = out.records.find((r) => r.title === "a1");
  const b = out.records.find((r) => r.title === "b1");
  assert.equal(a.work, "work:已命名的工作", "mapped key renamed");
  assert.equal(b.work, "work:bbb222", "unmapped key untouched");

  // Second application of the same mapping is a no-op on work fields.
  const again = applyWorkNames(out.records, mapping, { now: 2 });
  const a2 = again.records.find((r) => r.title === "a1");
  assert.equal(a2.work, "work:已命名的工作");
  assert.equal(again.stats.renamed, 0, "idempotent: nothing renamed the second time");
});

// ---------------------------------------------------------------- applyWorkSplit (v10)

/** Build a store of 4 decisions all under one work `work:mixed`, with pivots. */
function mixedStore() {
  const records = mergeLtm([], [
    toLtmRecord(decision("a1", "acs 第一篇", 0.8), { sessionId: "s", work: "work:mixed" }),
    toLtmRecord(decision("b1", "zotero 入库", 0.8), { sessionId: "s", work: "work:mixed" }),
    toLtmRecord(decision("a2", "acs 第二篇", 0.8), { sessionId: "s", work: "work:mixed" }),
    toLtmRecord(decision("b2", "zotero 连接器", 0.8), { sessionId: "s", work: "work:mixed" }),
  ]).records;
  return applyWorkPivots(records, { now: 1 }).records;
}

test("applyWorkSplit: moves named members to new sub-works and rebuilds pivots", () => {
  const store = mixedStore();
  const groups = [
    { name: "ACS 论文", memberIds: [0, 2] },
    { name: "Zotero 入库", memberIds: [1, 3] },
  ];
  const out = applyWorkSplit(store, "work:mixed", groups, { now: 2 });

  assert.equal(out.stats.moved, 4, "all four members moved to their sub-work");
  const acs = out.records.filter((r) => r.kind !== "work-summary" && /acs/.test(r.title));
  const zot = out.records.filter((r) => r.kind !== "work-summary" && /zotero/.test(r.title));
  for (const r of acs) assert.equal(r.work, "work:acs 论文");
  for (const r of zot) assert.equal(r.work, "work:zotero 入库");

  const livePivots = out.records.filter((r) => r.kind === "work-summary" && r.archived !== true);
  assert.equal(livePivots.length, 2, "two pivots, one per sub-work");
  for (const r of acs) assert.equal(r.parentId, pivotIdFor("work:acs 论文"));
  for (const r of zot) assert.equal(r.parentId, pivotIdFor("work:zotero 入库"));
});

test("applyWorkSplit: a sub-group named as the source work keeps those members in place", () => {
  const store = mixedStore();
  const groups = [
    { name: "mixed", memberIds: [0, 2] },
    { name: "Zotero 入库", memberIds: [1, 3] },
  ];
  const out = applyWorkSplit(store, "work:mixed", groups, { now: 2 });
  assert.equal(out.stats.moved, 2, "only the two zotero members actually move");
  const kept = out.records.filter((r) => r.kind !== "work-summary" && r.work === "work:mixed");
  assert.equal(kept.length, 2, "the kept members stay on the source work");
});

test("applyWorkSplit: members not named in the partition are left untouched", () => {
  const store = mixedStore();
  const groups = [{ name: "Zotero 入库", memberIds: [1] }];
  const out = applyWorkSplit(store, "work:mixed", groups, { now: 2 });
  assert.equal(out.stats.moved, 1);
  const still = out.records.filter((r) => r.kind !== "work-summary" && r.work === "work:mixed");
  assert.equal(still.length, 3, "the three unmentioned members stay on the source work");
});

test("applyWorkSplit: no valid groups = no-op", () => {
  const store = mixedStore();
  const out = applyWorkSplit(store, "work:mixed", [], { now: 2 });
  assert.equal(out.stats.moved, 0);
  assert.equal(out.stats.pivotsCreated, 0);
});

test("applyWorkSplit: unknown source work = no-op, never throws", () => {
  const store = mixedStore();
  const out = applyWorkSplit(store, "work:does-not-exist", [{ name: "X", memberIds: [0] }], { now: 2 });
  assert.equal(out.stats.moved, 0);
});

test("applyWorkSplit: idempotent - same partition twice moves nothing the second time", () => {
  const store = mixedStore();
  const groups = [
    { name: "ACS 论文", memberIds: [0, 2] },
    { name: "Zotero 入库", memberIds: [1, 3] },
  ];
  const once = applyWorkSplit(store, "work:mixed", groups, { now: 2 });
  const twice = applyWorkSplit(once.records, "work:mixed", groups, { now: 3 });
  assert.equal(twice.stats.moved, 0, "second application is a no-op");
});
// ---------------------------------------------------- normalizeSplitPlan (regression: the bug)

test("normalizeSplitPlan: accepts the memberIds shape dryRun/parseWorkSplit emit", () => {
  // This is the exact shape a plan round-tripped from the preview carries. The old
  // splitWork read only `members`, so this came out empty and every apply failed.
  const plan = normalizeSplitPlan(
    [
      { name: "甲", memberIds: [0, 2] },
      { name: "乙", memberIds: [1] },
    ],
    4,
  );
  assert.deepEqual(plan, [
    { name: "甲", memberIds: [0, 2] },
    { name: "乙", memberIds: [1] },
  ]);
});

test("normalizeSplitPlan: also accepts a hand-written `members` plan", () => {
  const plan = normalizeSplitPlan([{ name: "A", members: [1, 3] }], 4);
  assert.deepEqual(plan, [{ name: "A", memberIds: [1, 3] }]);
});

test("normalizeSplitPlan: drops out-of-range / duplicate / empty rows", () => {
  const plan = normalizeSplitPlan(
    [
      { name: "A", memberIds: [0, 9, -1, 1.5] }, // only 0 survives (9 out of range, -1, 1.5)
      { name: "", memberIds: [2] }, // no name → dropped
      { name: "B", memberIds: [0] }, // 0 already taken by A → deduped to empty → dropped
      { name: "C", memberIds: [] }, // empty → dropped
      null,
      "not a row",
    ],
    4,
  );
  assert.deepEqual(plan, [{ name: "A", memberIds: [0] }]);
});

test("normalizeSplitPlan: non-array input yields no plan", () => {
  assert.deepEqual(normalizeSplitPlan(null, 4), []);
  assert.deepEqual(normalizeSplitPlan(undefined, 4), []);
  assert.deepEqual(normalizeSplitPlan({}, 4), []);
});

// --- applyWorkSplit: never leave the source work with a retired pivot but no live one ---
// Regression: a no-op / "all members stay put" partition used to archive the source pivot
// (moved>0 fired only when a member's work key actually changed — but the rebuild could then
// fail to materialise a replacement), leaving orphaned members under an archived pivot.

function buildSplitFixture() {
  const now = 1000;
  const work = "work:闲聊";
  const recs = [0, 1, 2, 3].map((i) => ({
    id: `ltm-fixture${i}`,
    zone: "recall",
    kind: "memory",
    work,
    title: `闲聊记录 ${i}`,
    body: "你好",
    weight: 3,
    born: now + i,
    archived: false,
    supersededAt: null,
    parentId: null,
    pivotId: null,
  }));
  const pivoted = applyWorkPivots(recs, { now });
  return { work, records: pivoted.records };
}

test("applyWorkSplit: no-op single-group keeps the source pivot live", () => {
  const { work, records } = buildSplitFixture();
  const pid = pivotIdFor(work);
  assert.equal(records.find((r) => r.id === pid).archived, false);
  const out = applyWorkSplit(records, work, [{ name: "闲聊", memberIds: [0, 1, 2, 3] }], { now: 2000 });
  const src = out.records.find((r) => r.id === pid);
  assert.ok(src, "source pivot must still exist");
  assert.equal(src.archived, false, "no-op must not archive the source pivot");
  assert.equal(out.stats.moved, 0);
});

test("applyWorkSplit: members leaving to a built sub-pivot keep data intact", () => {
  const { work, records } = buildSplitFixture();
  const pid = pivotIdFor(work);
  const out = applyWorkSplit(
    records,
    work,
    [
      { name: "问候", memberIds: [0, 1] },
      { name: "表情", memberIds: [2, 3] },
    ],
    { now: 2000 },
  );
  assert.equal(out.stats.moved, 4);
  // No member lost.
  const ids0 = new Set(records.filter((r) => r.kind !== "work-summary").map((r) => r.id));
  const ids1 = new Set(out.records.filter((r) => r.kind !== "work-summary").map((r) => r.id));
  for (const id of ids0) assert.ok(ids1.has(id), `member ${id} lost`);
  // New sub-work pivots exist and are live (each has ≥2 members).
  const greeting = out.records.find((r) => r.work === "work:问候" && r.kind === "work-summary");
  const emoji = out.records.find((r) => r.work === "work:表情" && r.kind === "work-summary");
  assert.ok(greeting && greeting.archived === false);
  assert.ok(emoji && emoji.archived === false);
  void pid;
});

test("applyWorkSplit: emptying the source work retires its pivot (no orphan live pivot)", () => {
  const { work, records } = buildSplitFixture();
  const pid = pivotIdFor(work);
  // All members move to one new work → source work has 0 members left.
  const out = applyWorkSplit(records, work, [{ name: "寒暄问候", memberIds: [0, 1, 2, 3] }], { now: 2000 });
  const src = out.records.find((r) => r.id === pid);
  assert.ok(src && src.archived === true, "emptied source pivot must be retired");
  const livePivots = out.records.filter((r) => r.kind === "work-summary" && r.archived !== true);
  assert.equal(livePivots.length, 1, "exactly one live pivot (the new sub-work)");
});

// ── isLikelySingleTopic: guards the ✂️ split button ──────────────────────────
// A group whose member titles are all near-identical (chit-chat greetings) is a
// single topic; splitting it only makes fragments and historically produced the
// orphan-pivot bug. The heuristic must flag that, but must NOT block a genuinely
// mixed group.

test("singleTopic: near-identical greeting titles ⇒ single topic (flag)", () => {
  const r = isLikelySingleTopic(["你好", "你好！", "你好呀"]);
  assert.equal(r.singleTopic, true);
  assert.ok(r.score > 0.5, "high similarity score");
});

test("singleTopic: clearly different topics ⇒ not single topic (allow split)", () => {
  const r = isLikelySingleTopic([
    "修复记忆折叠的枢轴孤儿问题",
    "把 lab-purchase-ledger 记账流程做成技能",
    "排查 STM32 flash 下载后不运行的原因",
  ]);
  assert.equal(r.singleTopic, false);
  assert.ok(r.score < 0.5, "low similarity score");
});

test("singleTopic: fewer than 2 members ⇒ never flagged", () => {
  assert.equal(isLikelySingleTopic(["只有一个"]).singleTopic, false);
  assert.equal(isLikelySingleTopic([]).singleTopic, false);
});

test("singleTopic: threshold is honored and always returns a bounded score", () => {
  const titles = ["氢气传感器标定实验", "氢气传感器复测"];
  const strict = isLikelySingleTopic(titles, { threshold: 0.95 });
  const loose = isLikelySingleTopic(titles, { threshold: 0.01 });
  assert.equal(strict.singleTopic, false);
  assert.equal(loose.singleTopic, true);
  assert.ok(loose.score >= 0 && loose.score <= 1, "score within 0..1");
});