/**
 * v8-c-1: pivot real-summary contract tests.
 *
 * Two pure pieces: work-name's summary prompt builders + tolerant parser, and
 * promote's applyWorkSummaries (writes a model summary onto a work pivot's body).
 * The failure mode these guard: a bad/empty model answer must leave the pivot's
 * mechanical body untouched — a summary pass that misfires must never blank a pivot.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkSummaryInstruction,
  renderWorkMembers,
  parseWorkSummary,
} from "../lib/work-name.js";
import { applyWorkSummaries } from "../lib/promote.js";

test("buildWorkSummaryInstruction: mentions the work and asks for a summary", () => {
  const s = buildWorkSummaryInstruction({ work: "work:acs-wenxian" });
  assert.match(s, /acs-wenxian/); // work body echoed (prefix stripped)
  assert.match(s, /摘要/);
});

test("renderWorkMembers: joins title+body, bounded", () => {
  const text = renderWorkMembers([
    { title: "标题一", body: "正文一" },
    { title: "标题二", body: "正文二" },
  ]);
  assert.match(text, /标题一：正文一/);
  assert.match(text, /标题二：正文二/);
});

test("renderWorkMembers: respects maxChars budget", () => {
  const text = renderWorkMembers([{ title: "x", body: "y".repeat(5000) }], 200);
  assert.ok(text.length <= 200);
});

test("parseWorkSummary: trims fence and label, keeps body", () => {
  assert.equal(parseWorkSummary("```\n这是一段摘要。\n```"), "这是一段摘要。");
  assert.equal(parseWorkSummary("摘要：做了什么。"), "做了什么。");
  assert.equal(parseWorkSummary("  summary: did it  "), "did it");
});

test("parseWorkSummary: empty / whitespace → empty string", () => {
  assert.equal(parseWorkSummary(""), "");
  assert.equal(parseWorkSummary("   \n  "), "");
  assert.equal(parseWorkSummary(null), "");
});

test("parseWorkSummary: clips to max length", () => {
  const out = parseWorkSummary("字".repeat(500));
  assert.ok(out.length <= 240);
});

test("applyWorkSummaries: writes body onto the matching live pivot and bumps rev", () => {
  const records = [
    { id: "p1", kind: "work-summary", work: "work:a", body: "旧拼接", rev: 1, archived: false },
    { id: "m1", kind: "decision", work: "work:a" },
  ];
  const { records: out, stats } = applyWorkSummaries(records, new Map([["work:a", "新的真摘要"]]));
  assert.equal(stats.updated, 1);
  const pivot = out.find((r) => r.id === "p1");
  assert.equal(pivot.body, "新的真摘要");
  assert.equal(pivot.rev, 2);
  // input not mutated
  assert.equal(records[0].body, "旧拼接");
});

test("applyWorkSummaries: no-op when summary equals existing body", () => {
  const records = [{ id: "p1", kind: "work-summary", work: "work:a", body: "同", rev: 1, archived: false }];
  const { stats } = applyWorkSummaries(records, new Map([["work:a", "同"]]));
  assert.equal(stats.updated, 0);
});

test("applyWorkSummaries: skips archived pivots", () => {
  const records = [{ id: "p1", kind: "work-summary", work: "work:a", body: "旧", rev: 1, archived: true }];
  const { stats } = applyWorkSummaries(records, new Map([["work:a", "新"]]));
  assert.equal(stats.updated, 0);
});

test("applyWorkSummaries: empty summary map → unchanged, never blanks", () => {
  const records = [{ id: "p1", kind: "work-summary", work: "work:a", body: "旧", rev: 1, archived: false }];
  const { records: out, stats } = applyWorkSummaries(records, new Map());
  assert.equal(stats.updated, 0);
  assert.equal(out[0].body, "旧");
});

test("applyWorkSummaries: empty-string summary is ignored (does not blank)", () => {
  const records = [{ id: "p1", kind: "work-summary", work: "work:a", body: "旧", rev: 1, archived: false }];
  const { records: out, stats } = applyWorkSummaries(records, { "work:a": "   " });
  assert.equal(stats.updated, 0);
  assert.equal(out[0].body, "旧");
});
