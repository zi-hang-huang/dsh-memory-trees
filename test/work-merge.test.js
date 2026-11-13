/**
 * v8-c-2: merge-granularity contract tests (pure halves).
 *
 * The whole-store reorganisation reuses parseWorkNames (the {work,name} contract), so
 * the only new pure pieces are the merge prompt builders. The point of these tests is
 * the guardrail: the instruction must explicitly demand "don't merge unrelated work".
 * The actual merge decision is the model's; applyWorkNames already tested for merge.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkMergeInstruction,
  buildWorkNamingInstruction,
  renderWorkForMerge,
  parseWorkNames,
} from "../lib/work-name.js";

test("buildWorkMergeInstruction: lists every work key", () => {
  const s = buildWorkMergeInstruction({ works: ["work:a", "work:b", "work:c"] });
  assert.match(s, /work:a/);
  assert.match(s, /work:b/);
  assert.match(s, /work:c/);
});

test("buildWorkMergeInstruction: carries the anti-over-merge guardrail", () => {
  const s = buildWorkMergeInstruction({ works: ["work:a"] });
  assert.match(s, /宁可不合|别.*错合|不算同一件事/);
});

test("renderWorkForMerge: shows the work name and its key", () => {
  const text = renderWorkForMerge({ work: "work:acs", samples: [{ title: "标题", body: "正文" }] });
  assert.match(text, /acs/);
  assert.match(text, /work:acs/);
  assert.match(text, /标题/);
});

test("renderWorkForMerge: bounded by maxChars", () => {
  const text = renderWorkForMerge(
    { work: "work:x", samples: [{ title: "t", body: "y".repeat(2000) }] },
    200,
  );
  assert.ok(text.length <= 260); // budget + header lines
});

test("parseWorkNames: same-name rows = merge signal (two keys → one name)", () => {
  const ans = '```json\n[{"work":"work:a","name":"ACS检索"},{"work":"work:b","name":"ACS检索"}]\n```';
  const m = parseWorkNames(ans, ["work:a", "work:b"]);
  assert.equal(m.get("work:a"), "ACS检索");
  assert.equal(m.get("work:b"), "ACS检索");
});

test("parseWorkNames: distinct names stay distinct", () => {
  const ans = '[{"work":"work:a","name":"甲"},{"work":"work:b","name":"乙"}]';
  const m = parseWorkNames(ans, ["work:a", "work:b"]);
  assert.notEqual(m.get("work:a"), m.get("work:b"));
});

test("parseWorkNames: ignores keys we did not ask about", () => {
  const ans = '[{"work":"work:zzz","name":"x"},{"work":"work:a","name":"甲"}]';
  const m = parseWorkNames(ans, ["work:a"]);
  assert.equal(m.has("work:zzz"), false);
  assert.equal(m.get("work:a"), "甲");
});

// --- v8-c-2 档1: merge tightness mode ---------------------------------------

test("buildWorkMergeInstruction: conservative is default and stricter than balanced", () => {
  const def = buildWorkMergeInstruction({ works: ["work:a"] });
  const con = buildWorkMergeInstruction({ works: ["work:a"], mode: "conservative" });
  const bal = buildWorkMergeInstruction({ works: ["work:a"], mode: "balanced" });
  assert.equal(def, con); // default == conservative
  assert.match(con, /宁可多留|都不算/); // conservative carries extra guardrail
  assert.doesNotMatch(bal, /宁可多留/);
  assert.notEqual(con, bal);
});

test("buildWorkNamingInstruction: conservative carries the anti-over-merge guardrail", () => {
  const con = buildWorkNamingInstruction({ keys: ["work:a"], mode: "conservative" });
  const bal = buildWorkNamingInstruction({ keys: ["work:a"], mode: "balanced" });
  assert.match(con, /宁可不合|都不算/);
  assert.notEqual(con, bal);
});
