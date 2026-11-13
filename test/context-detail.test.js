import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  rowOf,
  summarizeRows,
  buildContextDetail,
} from "../lib/context-detail.js";

// --- estimateTokens ---------------------------------------------------------

test("estimateTokens: ascii ~ 1/4 per char, no throw on empty", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1); // 4/4
  assert.equal(estimateTokens("abcde"), 2); // ceil(5/4)
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(123), 0);
});

test("estimateTokens: CJK counts ~1 per char", () => {
  assert.equal(estimateTokens("你好世界"), 4);
  // mixed: 4 cjk + 4 ascii/4 => 5
  assert.equal(estimateTokens("你好世界abcd"), 5);
});

// --- rowOf ------------------------------------------------------------------

test("rowOf: classifies a plain user message into the user bucket", () => {
  const row = rowOf(7, {
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "帮我看下这个文件" }],
  });
  assert.equal(row.seq, 7);
  assert.equal(row.role, "user");
  assert.equal(row.bucket, "user");
  assert.equal(row.chars, 8);
  assert.ok(row.tokens > 0);
  assert.equal(row.preview, "帮我看下这个文件");
  assert.deepEqual(row.toolNames, []);
});

test("rowOf: assistant carrying tool calls stays assistant and lists names", () => {
  const row = rowOf(9, {
    role: "assistant",
    source: { kind: "agent-message" },
    content: [
      { type: "text", text: "我来读文件" },
      { type: "tool-call", name: "read" },
      { type: "tool-call", name: "grep" },
    ],
  });
  assert.equal(row.bucket, "assistant");
  assert.deepEqual(row.toolNames, ["read", "grep"]);
  // only text contributes to chars
  assert.equal(row.chars, 5);
});

test("rowOf: tool result goes to the tools bucket regardless of tool name", () => {
  const row = rowOf(11, {
    role: "tool",
    source: { kind: "tool" },
    content: [{ type: "text", text: "x".repeat(400) }],
  });
  assert.equal(row.bucket, "tools");
  assert.equal(row.tokens, 100);
});

test("rowOf: injected system material (skill-catalog) buckets to system", () => {
  const a = rowOf(1, { role: "system", source: { kind: "skill-catalog" }, content: [{ type: "text", text: "skills" }] });
  const b = rowOf(2, { role: "system", source: { kind: "memory" }, content: [{ type: "text", text: "mem" }] });
  assert.equal(a.bucket, "system");
  assert.equal(b.bucket, "system");
});

test("rowOf: honors a fixed token count when provided", () => {
  const row = rowOf(3, { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }, 999);
  assert.equal(row.tokens, 999);
});

test("rowOf: reasoning-only content yields zero chars but a valid row", () => {
  const row = rowOf(4, {
    role: "assistant",
    source: { kind: "agent-message" },
    content: [{ type: "reasoning", text: "thinking..." }],
  });
  assert.equal(row.chars, 0);
  assert.equal(row.tokens, 0);
  assert.equal(row.preview, "");
});

// --- summarizeRows ----------------------------------------------------------

test("summarizeRows: always returns the four buckets in fixed order", () => {
  const s = summarizeRows([]);
  assert.deepEqual(s.buckets.map((b) => b.key), ["system", "tools", "assistant", "user"]);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.totalRows, 0);
});

test("summarizeRows: accumulates counts and tokens per bucket, plus grand total", () => {
  const rows = [
    { bucket: "user", tokens: 10 },
    { bucket: "tools", tokens: 500 },
    { bucket: "tools", tokens: 200 },
    { bucket: "assistant", tokens: 30 },
  ];
  const s = summarizeRows(rows);
  const byKey = Object.fromEntries(s.buckets.map((b) => [b.key, b]));
  assert.equal(byKey.tools.count, 2);
  assert.equal(byKey.tools.tokens, 700);
  assert.equal(byKey.user.count, 1);
  assert.equal(s.totalTokens, 740);
  assert.equal(s.totalRows, 4);
});

// --- buildContextDetail -----------------------------------------------------

test("buildContextDetail: skips seqs whose derive returns null or throws", () => {
  const msgs = {
    1: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] },
    2: null,
    3: { role: "tool", source: { kind: "tool" }, content: [{ type: "text", text: "res" }] },
  };
  const derive = (seq) => {
    if (seq === 4) throw new Error("boom");
    return msgs[seq] ?? null;
  };
  const detail = buildContextDetail([1, 2, 3, 4], derive);
  assert.equal(detail.totalRows, 2);
  const byKey = Object.fromEntries(detail.buckets.map((b) => [b.key, b]));
  assert.equal(byKey.user.count, 1);
  assert.equal(byKey.tools.count, 1);
});

test("buildContextDetail: uses tokensOf when provided", () => {
  const derive = () => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] });
  const detail = buildContextDetail([1], derive, () => 42);
  assert.equal(detail.totalTokens, 42);
});
