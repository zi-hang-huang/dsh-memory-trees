/**
 * v10: split-an-over-merged-work contract tests (pure halves).
 *
 * Split is the inverse of the v8-c-2 merge. It reuses the "here is a work, here are its
 * members" shape but partitions ONE work's members into sub-groups. The two things that
 * must hold: the model is told to be conservative (don't split a coherent work), and the
 * parser only accepts member indices it actually asked about (never invents members).
 * applyWorkSplit is tested separately for the actual store mutation + idempotence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  renderWorkForSplit,
  buildWorkSplitInstruction,
  parseWorkSplit,
} from "../lib/work-name.js";

test("renderWorkForSplit: enumerates members as m0, m1, … with titles", () => {
  const text = renderWorkForSplit({
    work: "work:acs",
    members: [{ title: "第一篇", body: "" }, { title: "第二篇", body: "细节" }],
  });
  assert.match(text, /work:acs/);
  assert.match(text, /m0: 第一篇/);
  assert.match(text, /m1: 第二篇：细节/);
});

test("renderWorkForSplit: bounded by maxChars but always keeps the first member", () => {
  const members = Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, body: "x".repeat(200) }));
  const text = renderWorkForSplit({ work: "work:b", members }, 300);
  assert.ok(text.length <= 400, "should be bounded");
  assert.match(text, /m0:/, "first member is always present");
});

test("buildWorkSplitInstruction: carries the conservative anti-over-split guardrail", () => {
  const s = buildWorkSplitInstruction({ work: "work:acs", memberCount: 5 });
  assert.match(s, /宁可不拆|别错拆/);
  assert.match(s, /不拆/);
  assert.match(s, /work:acs|acs/);
});

test("buildWorkSplitInstruction: balanced mode relaxes the guardrail wording", () => {
  const c = buildWorkSplitInstruction({ work: "w", memberCount: 3, mode: "conservative" });
  const b = buildWorkSplitInstruction({ work: "w", memberCount: 3, mode: "balanced" });
  assert.notEqual(c, b);
});

test("parseWorkSplit: accepts a fenced JSON array of {name,members}", () => {
  const raw = '```json\n[{"name":"ACS 论文获取","members":["m0","m2"]},{"name":"Zotero 入库","members":["m1"]}]\n```';
  const groups = parseWorkSplit(raw, 3);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { name: "ACS 论文获取", memberIds: [0, 2] });
  assert.deepEqual(groups[1], { name: "Zotero 入库", memberIds: [1] });
});

test("parseWorkSplit: accepts bare array and numeric / '3' member refs", () => {
  const raw = '[{"name":"A","members":[0, "1", "m2"]}]';
  const groups = parseWorkSplit(raw, 3);
  assert.deepEqual(groups[0].memberIds, [0, 1, 2]);
});

test("parseWorkSplit: drops out-of-range and duplicate member indices; a member is in one group", () => {
  const raw = '[{"name":"A","members":[0,1]},{"name":"B","members":[1,2,99]}]';
  const groups = parseWorkSplit(raw, 3);
  // m1 was already taken by A; m99 is out of range.
  assert.deepEqual(groups[0].memberIds, [0, 1]);
  assert.deepEqual(groups[1].memberIds, [2]);
});

test("parseWorkSplit: ignores empty names and groups with no valid members", () => {
  const raw = '[{"name":"","members":[0]},{"name":"B","members":[]},{"name":"C","members":["m1"]}]';
  const groups = parseWorkSplit(raw, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "C");
});

test("parseWorkSplit: unparseable answer yields [] and never throws", () => {
  assert.deepEqual(parseWorkSplit("sorry, I cannot", 3), []);
  assert.deepEqual(parseWorkSplit("", 3), []);
  assert.deepEqual(parseWorkSplit(null, 3), []);
});

test("parseWorkSplit: rejects member indices when no memberCount is given out-of-band", () => {
  // Without a limit, any non-negative index is accepted (caller always passes a count).
  const groups = parseWorkSplit('[{"name":"A","members":["m0"]}]');
  assert.deepEqual(groups[0].memberIds, [0]);
});
