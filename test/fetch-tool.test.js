/**
 * `memory_fetch` (⑤c) and oversized-result body (⑤b) contract tests.
 *
 * These pin the two halves of "a folded big result stays reachable":
 *   - ⑤b: an oversized tool result becomes head+tail+pointer, not a 200-char prefix.
 *   - ⑤c: `memory_fetch(seq, offset)` pages the original back, without truncating storage.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FETCH_DEFAULT_CHARS,
  FETCH_MAX_CHARS,
  createFetchTool,
  eventText,
  sliceEventText,
} from "../lib/fetch-tool.js";
import { toolBody } from "../lib/distill.js";
import { MAX_BODY } from "../lib/tree.js";

// --- ⑤b: oversized tool result body ---

test("⑤b a small tool result is unchanged (plain excerpt, no pointer)", () => {
  const body = toolBody({ name: "read", ok: true, text: "short result", seq: 12 });
  assert.equal(body, "short result");
  assert.ok(!body.includes("memory_fetch"), "small results must not carry a pointer");
});

test("⑤b an oversized result becomes head + pointer + tail within MAX_BODY", () => {
  const text = `HEAD-MARKER ${"x".repeat(40000)} TAIL-MARKER`;
  const body = toolBody({ name: "web_fetch", ok: true, text, seq: 617 });
  assert.ok(body.length <= MAX_BODY, `body ${body.length} must be <= ${MAX_BODY}`);
  assert.ok(body.includes("HEAD-MARKER"), "head must be visible");
  assert.ok(body.includes("TAIL-MARKER"), "tail must be visible (the old excerpt lost it)");
  assert.ok(body.includes("memory_fetch(617)"), "pointer with seq must be present");
});

test("⑤b an oversized result without a seq still gets head+tail, no dead pointer", () => {
  const text = `A ${"y".repeat(40000)} Z`;
  const body = toolBody({ name: "tool", ok: true, text }); // no seq
  assert.ok(body.length <= MAX_BODY);
  assert.ok(body.includes("A ") && body.includes("Z") && body.includes("A"));
  assert.ok(!body.includes("memory_fetch"), "no seq -> no fetch pointer");
  assert.ok(body.includes("省略"), "still states text was omitted");
});

test("⑤b a large failure still fits within MAX_BODY", () => {
  const text = `ERR ${"z".repeat(40000)}`;
  const body = toolBody({ name: "bash", ok: false, text, seq: 9 });
  assert.ok(body.length <= MAX_BODY, `failed body ${body.length} must be <= ${MAX_BODY}`);
  assert.ok(body.includes("memory_fetch(9)"));
});

// --- ⑤c: sliceEventText paging ---

test("⑤c sliceEventText returns the whole text in one page when small", () => {
  const { page, total, nextOffset, notice } = sliceEventText("hello", 0, 100);
  assert.equal(page, "hello");
  assert.equal(total, 5);
  assert.equal(nextOffset, null);
  assert.ok(notice.includes("全部返回") || notice.includes("已全部"));
});

test("⑤c sliceEventText pages without truncating the stored text", () => {
  const full = "0123456789".repeat(5); // 50 chars
  const first = sliceEventText(full, 0, 20);
  assert.equal(first.page, full.slice(0, 20));
  assert.equal(first.nextOffset, 20);
  assert.equal(first.total, 50, "total is the full length, not the page length");

  const second = sliceEventText(full, first.nextOffset, 20);
  assert.equal(second.page, full.slice(20, 40));

  const third = sliceEventText(full, second.nextOffset, 20);
  assert.equal(third.page, full.slice(40, 50));
  assert.equal(third.nextOffset, null, "last page has nowhere to continue");
});

test("⑤c sliceEventText clamps offset and limit, and caps limit at FETCH_MAX_CHARS", () => {
  const full = "a".repeat(50000);
  const capped = sliceEventText(full, 0, 999999);
  assert.equal(capped.page.length, FETCH_MAX_CHARS, "limit is capped at FETCH_MAX_CHARS");
  const past = sliceEventText("abc", 999, 10);
  assert.equal(past.page.length, 0, "offset past end yields an empty page");
});

test("⑤c eventText reads tool/result and user/message shapes, drops reasonings", () => {
  const toolEvent = { data: { message: { content: [{ type: "text", text: "payload" }] } } };
  assert.equal(eventText(toolEvent), "payload");
  const userEvent = { data: { content: [{ type: "text", text: "question" }] } };
  assert.equal(eventText(userEvent), "question");
  const withReasoning = {
    data: { message: { content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "ok" }] } },
  };
  assert.equal(eventText(withReasoning), "ok", "reasoning must be dropped");
});

// --- ⑤c: the tool execute path ---

test("⑤c memory_fetch returns a page from the injected readEvent", async () => {
  const full = "FULLTEXT-".repeat(100); // 900 chars
  const tool = createFetchTool({
    readEvent: async (sessionId, seq) => (seq === 7 ? { data: { message: { content: [{ type: "text", text: full }] } } } : null),
    config: { maxChars: 100 },
  });
  const out = await tool.execute({ seq: 7 }, { agent: { session: { id: "s1" } } });
  assert.equal(out.seq, 7);
  assert.equal(out.total, 900);
  assert.equal(out.text.length, 100);
  assert.equal(out.nextOffset, 100);
});

test("⑤c memory_fetch reports missing seq and missing session instead of throwing", async () => {
  const tool = createFetchTool({ readEvent: async () => null });
  const missing = await tool.execute({ seq: 999 }, { agent: { session: { id: "s1" } } });
  assert.ok(missing.notice.includes("没有") || missing.notice.includes("no such"));
  const noSession = await tool.execute({ seq: 1 }, {});
  assert.ok(noSession.notice.includes("不可用") || noSession.notice.includes("不可访问"));
});

test("⑤c memory_fetch surfaces a readEvent throw as a notice, not a failed turn", async () => {
  const tool = createFetchTool({ readEvent: async () => { throw new Error("boom"); } });
  const out = await tool.execute({ seq: 1 }, { agent: { session: { id: "s1" } } });
  assert.ok(out.notice.includes("失败") || out.notice.includes("boom"));
  assert.equal(out.text, "");
});

// P0 regression (2026-11-06, live): the tool's OUTPUT must have an integer `nextOffset`,
// never null. The output validator rejected a real call with
// `tool "memory_fetch" returned invalid output: "value.nextOffset" must be an integer`
// when the last page returned null. Every execute() result now emits -1 for "no more".
test("⑤c memory_fetch always returns an integer nextOffset (-1 at the last page)", async () => {
  const full = "x".repeat(50);
  const tool = createFetchTool({
    readEvent: async () => ({ data: { message: { content: [{ type: "text", text: full }] } } }),
    config: { maxChars: 100 }, // one page covers all 50 chars -> no next page
  });
  const out = await tool.execute({ seq: 7 }, { agent: { session: { id: "s1" } } });
  assert.ok(Number.isInteger(out.nextOffset), `nextOffset must be an integer, got ${JSON.stringify(out.nextOffset)}`);
  assert.equal(out.nextOffset, -1, "the last page carries -1, not null");
});

test("⑤c memory_fetch error paths also emit integer nextOffset", async () => {
  const noEvent = createFetchTool({ readEvent: async () => null });
  const bad = await noEvent.execute({ seq: 999 }, { agent: { session: { id: "s1" } } });
  assert.ok(Number.isInteger(bad.nextOffset), "missing-seq path must carry an integer nextOffset");
  const throwing = createFetchTool({ readEvent: async () => { throw new Error("x"); } });
  const err = await throwing.execute({ seq: 1 }, { agent: { session: { id: "s1" } } });
  assert.ok(Number.isInteger(err.nextOffset), "error path must carry an integer nextOffset");
});

// v10: cross-session replay. A seq is scoped to ONE session, so a pointer remembered
// from an older conversation must carry that conversation's id — otherwise the same
// number resolves against the current session (wrong event, or nothing).
test("⑤c memory_fetch honours an explicit sessionId over the executing session", async () => {
  const seen = [];
  const tool = createFetchTool({
    readEvent: async (sessionId, seq) => {
      seen.push({ sessionId, seq });
      return { data: { message: { content: [{ type: "text", text: `${sessionId}:${seq}` }] } } };
    },
  });
  const exec = { agent: { session: { id: "current-session" } } };

  const override = await tool.execute({ seq: 5, sessionId: "old-session" }, exec);
  assert.equal(seen.at(-1).sessionId, "old-session", "explicit sessionId must win");
  assert.equal(override.text, "old-session:5");

  // Omitted / blank / non-string all fall back to the executing session, so every
  // existing same-session pointer keeps working unchanged.
  await tool.execute({ seq: 6 }, exec);
  await tool.execute({ seq: 7, sessionId: "   " }, exec);
  await tool.execute({ seq: 8, sessionId: null }, exec);
  assert.deepEqual(
    seen.slice(-3).map((call) => call.sessionId),
    ["current-session", "current-session", "current-session"],
  );
});

test("⑤c a blank sessionId with no executing session still reports unavailable", async () => {
  const tool = createFetchTool({ readEvent: async () => ({ data: {} }) });
  const out = await tool.execute({ seq: 1, sessionId: "" }, {});
  assert.ok(out.notice.includes("不可用") || out.notice.includes("不可访问"));
});
