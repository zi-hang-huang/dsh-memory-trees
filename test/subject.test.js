/**
 * Tests for the v3 subject extractor (lib/subject.js).
 *
 * The contract (promote-plan §3.1): a confident key when the title/body names one
 * (config identifier or explicitly quoted short key), null otherwise. Never guess —
 * a wrong subject merges two different facts, so a prose title must yield null.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractSubject } from "../lib/subject.js";

test("subject: dotted config path in title", () => {
  assert.equal(extractSubject({ title: "Config.RetainTokens 改成 15000" }), "config.retaintokens");
});

test("subject: camelCase identifier in title", () => {
  assert.equal(extractSubject({ title: "调整 retainTokens 到 15000" }), "retaintokens");
});

test("subject: snake_case identifier in title", () => {
  assert.equal(extractSubject({ title: "set retain_tokens=15000" }), "retain_tokens");
});

test("subject: same parameter spelled three ways → one key", () => {
  const a = extractSubject({ title: "Config.RetainTokens 是 15000" });
  const b = extractSubject({ title: "config.retaintokens 设为 15000" });
  assert.equal(a, b, "dotted forms fold together");
});

test("subject: explicitly quoted key at title head", () => {
  assert.equal(extractSubject({ title: "「保留窗口」: 从 12000 调到 15000" }), "保留窗口");
});

test("subject: quoted key just before a trailing colon", () => {
  assert.equal(extractSubject({ title: "注意 “barrierPolicy”: " }), "barrierpolicy");
});

test("subject: identifier from body when title is prose", () => {
  const node = {
    title: "把保留窗口调大了",
    body: "具体是把 config.retainTokens 从 12000 改到 15000，理由是长会话折叠太激进。",
  };
  assert.equal(extractSubject(node), "config.retaintokens");
});

test("subject: pure prose title and body → null (do not guess)", () => {
  assert.equal(extractSubject({ title: "今天讨论的方案不错", body: "我们聊了很久。" }), null);
});

test("subject: empty node → null", () => {
  assert.equal(extractSubject({}), null);
  assert.equal(extractSubject(null), null);
});

test("subject: long quoted span is prose, not a key → falls through to null", () => {
  // 25 chars inside quotes — over the 24-char key cap, so not treated as a key.
  assert.equal(extractSubject({ title: "「这是一句很长的引述超过二十四个字符了」" }), null);
});

test("subject: single capitalised word is NOT a config identifier", () => {
  assert.equal(extractSubject({ title: "Retry 的时机" }), null);
});

test("subject: deterministic — same input twice, same output", () => {
  const n = { title: "Config.BarrierPolicy 设为 newest" };
  assert.equal(extractSubject(n), extractSubject(n));
});
