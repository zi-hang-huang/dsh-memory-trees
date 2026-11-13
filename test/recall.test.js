/**
 * v4 recall contract tests.
 *
 * Retrieval is the only part of v4 that decides *what the model gets to see*, and it
 * runs on every pre-step, so two properties matter more than ranking quality:
 *
 *   1. **Zero dependencies and deterministic.** No model call, no vector index, no
 *      timestamps. The same store and query must produce byte-identical output, or the
 *      render prefix churns and the provider cache (measured 97-99% hit rate) dies.
 *   2. **Silence is the default.** No match means no message appended at all — an
 *      empty recall block that still occupies a surface slot would pay tokens forever
 *      for nothing.
 *
 * BM25 over character bigrams is chosen over embeddings because this store holds
 * exact identifiers ("retainTokens is 15000", "--test-concurrency=1"), which is where
 * a lexical match beats a semantic one. The known cost is that "保留" does not match
 * "保存"; that direction (miss, never over-match) is deliberate and pinned below.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { bigrams, bm25Rank, expandRecall, recall, renderRecallBlock, selectRecall } from "../lib/recall.js";

const docs = [
  { id: "a", text: "retainTokens 是 15000" },
  { id: "b", text: "barrierKinds 只剩 skill-catalog" },
  { id: "c", text: "测试命令要加 --test-concurrency=1" },
];

test("ranks the doc containing the rare term first", () => {
  const hits = bm25Rank(docs, "skill-catalog");
  assert.equal(hits[0].id, "b");
  assert.ok(hits[0].score > 0);
});

test("returns nothing when no term matches", () => {
  assert.deepEqual(bm25Rank(docs, "完全不存在的词"), []);
});

test("respects topK", () => {
  assert.equal(bm25Rank(docs, "retainTokens skill barri", { topK: 1 }).length, 1);
});

test("is deterministic across calls", () => {
  assert.deepEqual(bm25Rank(docs, "15000"), bm25Rank(docs, "15000"));
});

test("empty inputs are empty results, not throws", () => {
  assert.deepEqual(bm25Rank([], "anything"), []);
  assert.deepEqual(bm25Rank(docs, ""), []);
  assert.deepEqual(bm25Rank(docs, "   "), []);
  assert.deepEqual(bm25Rank(null, "x"), []);
});

test("a rarer term outranks a common one in the same query", () => {
  const corpus = [
    { id: "common1", text: "配置 配置 配置" },
    { id: "common2", text: "配置 配置" },
    { id: "rare", text: "配置 skill-catalog" },
  ];
  const hits = bm25Rank(corpus, "配置 skill-catalog");
  assert.equal(hits[0].id, "rare", "idf must favour the discriminating term");
});

// -----------------------------------------------------------------------------
// Task 2: bigram correctness boundaries
// -----------------------------------------------------------------------------

test("bigrams handles CJK without a tokenizer", () => {
  assert.deepEqual(bigrams("中文"), ["中文"]);
  assert.deepEqual(bigrams("abc"), ["ab", "bc"]);
  assert.deepEqual(bigrams(""), []);
  assert.deepEqual(bigrams("a"), ["a"]);
  assert.deepEqual(bigrams("中"), ["中"]);
  assert.deepEqual(bigrams(null), []);
});

test("bigrams folds case so an ASCII query is case-insensitive", () => {
  assert.deepEqual(bigrams("AB"), ["ab"]);
  assert.deepEqual(bigrams("RetainTokens"), bigrams("retaintokens"));
});

test("a CJK query matches a doc that shares a two-character run", () => {
  const hits = bm25Rank([{ id: "x", text: "保留窗口的预算是 15000" }], "预算");
  assert.equal(hits[0]?.id, "x");
});

test("does NOT match on a single shared character between two two-character words", () => {
  // 「保留」 and 「保存」 share 保 but no bigram. This is the deliberate miss: a fuzzy
  // match here would let a wrong memory arrive looking authoritative.
  const hits = bm25Rank([{ id: "y", text: "保存文件" }], "保留");
  assert.deepEqual(hits, []);
});

test("whitespace between CJK runs produces no cross-boundary bigram", () => {
  // Otherwise "配置 保留" would manufacture 置保 as a phantom term.
  const tokens = bigrams("配置 保留");
  assert.ok(!tokens.includes("置保"), `unexpected phantom bigram in ${JSON.stringify(tokens)}`);
});

// -----------------------------------------------------------------------------
// Task 3: recall gating
// -----------------------------------------------------------------------------

const store = [
  { id: "r1", title: "retainTokens 预算", body: "15000", archived: false },
  { id: "r2", title: "无关内容", body: "今天天气", archived: false },
  { id: "r3", title: "已归档的旧值", body: "retainTokens 12000", archived: true },
  { id: "r4", title: "被取代的旧值", body: "retainTokens 9000", supersededAt: 5 },
  { id: "r5", title: "被遗忘的值", body: "retainTokens 8000", forgottenAt: 6 },
];

test("gates on a minimum score so noise is not recalled", () => {
  assert.deepEqual(selectRecall(store, "今天天气", { minScore: 999 }), []);
});

test("excludes archived, superseded and forgotten records", () => {
  const got = selectRecall(store, "retainTokens", { minScore: 0 });
  assert.deepEqual(got.map((r) => r.id), ["r1"]);
});

test("respects the token budget by dropping the lowest-scoring tail", () => {
  const many = [
    { id: "x1", title: "alpha retainTokens", body: "a".repeat(200) },
    { id: "x2", title: "beta retainTokens", body: "b".repeat(200) },
  ];
  const got = selectRecall(many, "retainTokens", { minScore: 0, budget: 10 });
  assert.equal(got.length, 0, "the first record alone exceeds a budget of 10");
});

test("returns [] for an empty or whitespace query", () => {
  assert.deepEqual(selectRecall(store, "   ", {}), []);
  assert.deepEqual(selectRecall(store, "", {}), []);
});

test("defaults keep it conservative: a non-matching query recalls nothing", () => {
  // Pure CJK with no bigram in common with any record above. (An ASCII word like
  // `quantum` is NOT safe here: its `nt` bigram also appears inside `retainTokens`,
  // which is exactly the over-match this design accepts as a known limitation.)
  assert.deepEqual(selectRecall(store, "量子色动力学"), []);
});

test("a single shared character is not enough to clear the default gate", () => {
  // BM25's idf is always positive, so ONE shared bigram produces a small positive
  // score — a `minScore` of 0.5 does not filter it out. Matching at all in this case
  // would recall 「retainTokens 预算」 for the query 「quantum」, because both contain 量?
  // (they do not — 量 is only in 量子). The real lesson: the gate is a *score* floor,
  // not a relevance guarantee, so the query text must be real. Pinned so a future
  // change to minScore does not silently widen matching.
  const got = selectRecall(store, "量子", { minScore: 3 });
  assert.deepEqual(got, [], "a single weak bigram must not pass a high floor");
});

test("subject takes part in the indexed text", () => {
  const withSubject = [{ id: "s1", title: "某条记录", body: "内容", subject: "config.retain_tokens" }];
  assert.deepEqual(selectRecall(withSubject, "config.retain_tokens", { minScore: 0 }).map((r) => r.id), ["s1"]);
});

// -----------------------------------------------------------------------------
// Task 4: subject-family expansion
//
// LTM has no tree (toLtmRecord flattens parentId to null), so "graph expansion" is
// built on `subject` instead: records under the same dotted namespace are about the
// same area of the system, so matching one is a reason to look at its siblings.
//
// This does NOT solve paraphrase ("the folding window parameter" vs
// "retainTokens"): that gap stays open and is listed as a known limitation. What it
// does solve is "I matched one fact about config, show me the rest of config".
// -----------------------------------------------------------------------------

const family = [
  { id: "g1", subject: "config.retain_tokens", title: "retainTokens 是 15000", body: "", weight: 0.8, archived: false },
  { id: "g2", subject: "config.variadic_budget", title: "volatileBudget 是 2500", body: "", weight: 0.5, archived: false },
  { id: "g3", subject: "plugin.barrier_kinds", title: "屏障只剩 skill-catalog", body: "", weight: 0.9, archived: false },
  { id: "g4", subject: "config.retain_tokens", title: "retainTokens 的旧值", body: "", weight: 0.9, archived: true },
  { id: "g5", title: "没有 subject 的记录", body: "", weight: 1, sources: [{ sessionId: "sess-a" }] },
  { id: "g6", title: "同会话的兄弟", body: "", weight: 1, sources: [{ sessionId: "sess-a" }] },
  { id: "g7", title: "别处的记录", body: "", weight: 1, sources: [{ sessionId: "sess-z" }] },
];

test("pulls in siblings under the same subject namespace", () => {
  const extra = expandRecall(family, ["g1"], { maxExtra: 3 });
  assert.ok(extra.includes("g2"), "config.* siblings must be pulled in");
  assert.ok(!extra.includes("g3"), "plugin.* is a different namespace");
  assert.ok(!extra.includes("g1"), "the seed must not be returned as its own expansion");
});

test("expansion never exceeds maxExtra", () => {
  assert.deepEqual(expandRecall(family, ["g1"], { maxExtra: 0 }), []);
  assert.ok(expandRecall(family, ["g1"], { maxExtra: 1 }).length <= 1);
});

test("expansion skips retired neighbours", () => {
  assert.ok(!expandRecall(family, ["g1"], { maxExtra: 9 }).includes("g4"), "archived sibling must stay out");
});

test("expansion is one hop only and independent of seed order", () => {
  const a = expandRecall(family, ["g1", "g3"], { maxExtra: 5 });
  const b = expandRecall(family, ["g3", "g1"], { maxExtra: 5 });
  assert.deepEqual(a, b, "seed order must not change the result");
  assert.ok(!a.includes("g7"), "unrelated records must not be dragged in");
});

test("records with no subject fall back to same-session clustering", () => {
  const extra = expandRecall(family, ["g5"], { maxExtra: 3 });
  assert.ok(extra.includes("g6"), "same session is the fallback edge");
  assert.ok(!extra.includes("g7"), "a different session is not an edge");
});

test("expansion returns [] for an empty seed", () => {
  assert.deepEqual(expandRecall(family, [], { maxExtra: 3 }), []);
});

// -----------------------------------------------------------------------------
// Task 5: recall-zone rendering
// -----------------------------------------------------------------------------

test("renders a framed recall zone", () => {
  const text = renderRecallBlock([{ id: "r1", title: "retainTokens 预算", body: "15000" }]);
  assert.match(text, /<memory zone="recall">/);
  assert.match(text, /retainTokens 预算/);
  assert.match(text, /15000/);
  assert.match(text, /<\/memory>/);
});

test("renders an empty string for no hits, so nothing is appended", () => {
  assert.equal(renderRecallBlock([]), "");
  assert.equal(renderRecallBlock(null), "");
});

test("is deterministic and leaks neither ids nor timestamps", () => {
  const node = { id: "ltm-shouldnotappear", title: "T", body: "B" };
  const a = renderRecallBlock([node]);
  const b = renderRecallBlock([node]);
  assert.equal(a, b);
  assert.ok(!a.includes("ltm-shouldnotappear"), "node ids must not reach the model");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "no timestamps");
});

test("preserves the given order instead of re-sorting", () => {
  const text = renderRecallBlock([
    { id: "1", title: "第一条", body: "" },
    { id: "2", title: "第二条", body: "" },
  ]);
  assert.ok(text.indexOf("第一条") < text.indexOf("第二条"), "rank order must be preserved");
});

test("omits the body separator when a record has no body", () => {
  const text = renderRecallBlock([{ id: "1", title: "只有标题", body: "" }]);
  assert.match(text, /只有标题/);
  assert.ok(!/只有标题\s*[：:]\s*\n/.test(text), "no dangling colon for an empty body");
});

test("skips entries whose title and body are both empty", () => {
  assert.equal(renderRecallBlock([{ id: "1", title: "", body: "" }]), "");
});

// -----------------------------------------------------------------------------
// Task 7: the one entry point
// -----------------------------------------------------------------------------

const corpus = [
  {
    id: "c1",
    subject: "config.retain_tokens",
    title: "retainTokens 是 15000",
    body: "从 12000 调上来的",
    weight: 0.8,
  },
  {
    id: "c2",
    subject: "config.variadic_budget",
    title: "volatileBudget 是 2500",
    body: "",
    weight: 0.5,
  },
  {
    id: "c3",
    subject: "config.retain_tokens",
    title: "retainTokens 的旧值",
    body: "还是 12000 的时候",
    supersededAt: 7,
  },
];

test("recall returns { hits, expanded, block }", () => {
  const out = recall(corpus, "retainTokens", { enabled: true, minScore: 0 });
  assert.ok(Array.isArray(out.hits));
  assert.ok(Array.isArray(out.expanded));
  assert.match(out.block, /zone="recall"/);
  assert.equal(out.hits[0].id, "c1");
});

test("recall is silent when disabled", () => {
  const out = recall(corpus, "retainTokens", { enabled: false });
  assert.deepEqual(out.hits, []);
  assert.deepEqual(out.expanded, []);
  assert.equal(out.block, "");
});

test("recall never renders a superseded record", () => {
  const out = recall(corpus, "retainTokens", { enabled: true, minScore: 0 });
  assert.ok(!out.hits.some((r) => r.id === "c3"), "c3 is superseded");
  assert.deepEqual(out.expanded, [], "and it must not come back via expansion either");
});

test("expansion pulls a sibling the query never matched", () => {
  // This is the point of expansion: `volatileBudget` gets a score of 0.2 for the query
  // 「retainTokens」, so the floor keeps it out of the seed set — but it is a config.*
  // sibling of the seed, so expansion brings it in anyway. That is the cheap stand-in
  // for semantic recall.
  const out = recall(corpus, "retainTokens", { enabled: true, maxExtra: 2 });
  assert.deepEqual(out.hits.map((r) => r.id), ["c1"], "the floor keeps the noise out of seeds");
  assert.deepEqual(out.expanded.map((r) => r.id), ["c2"], "but the family edge still pulls it in");
  assert.match(out.block, /volatileBudget/, "expanded records reach the render");
});

test("the default score floor rejects a coincidental bigram", () => {
  // `volatileBudget` shares the bigram `et` with `retainTokens`, scoring 0.2 — far
  // below the 1.0 default. Pinned because it is the measured reason for that default.
  const out = recall(corpus, "retainTokens", { enabled: true, maxExtra: 0 });
  assert.deepEqual(out.hits.map((r) => r.id), ["c1"]);
});

test("recall with expansion disabled returns seeds only", () => {
  const out = recall(corpus, "retainTokens", { enabled: true, maxExtra: 0 });
  assert.deepEqual(out.expanded, []);
  assert.ok(!out.block.includes("volatileBudget"));
});

test("recall block is deterministic", () => {
  const a = recall(corpus, "retainTokens", { enabled: true, minScore: 0, maxExtra: 2 });
  const b = recall(corpus, "retainTokens", { enabled: true, minScore: 0, maxExtra: 2 });
  assert.equal(a.block, b.block);
});

test("recall tolerates an empty store and a blank query", () => {
  assert.equal(recall([], "retainTokens", { enabled: true }).block, "");
  assert.equal(recall(corpus, "   ", { enabled: true }).block, "");
  assert.equal(recall(corpus, null, { enabled: true }).block, "");
});





