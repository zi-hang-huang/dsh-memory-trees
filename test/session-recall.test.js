import test from "node:test";
import assert from "node:assert/strict";

import {
  RECALL_DEFAULTS,
  RECALL_SURFACES,
  buildRecallQuery,
  fetchCandidates,
  filterEventsToRows,
  queryTerms,
  rankDocuments,
  recallFromCandidates,
  renderRecallBlock,
  selectRecall,
  toCandidate,
} from "../lib/session-recall.js";

test("buildRecallQuery collapses whitespace and returns empty for blank input", () => {
  assert.equal(buildRecallQuery("  a   b \n c "), "a b c");
  assert.equal(buildRecallQuery("   "), "");
  assert.equal(buildRecallQuery(undefined), "");
});

test("buildRecallQuery caps a huge query to a prefix", () => {
  const long = "字".repeat(500);
  const query = buildRecallQuery(long, 50);
  assert.equal(query.length, 50);
  assert.ok(long.startsWith(query), "the prefix is preserved verbatim");
});

test("toCandidate reads the backend row shape and drops seq-less hits", () => {
  const candidate = toCandidate({ sessionId: "s1", seq: 42, type: "tool/result", snippet: "PORT=8080" });
  assert.deepEqual(
    { seq: candidate.seq, title: candidate.title, text: candidate.text },
    { seq: 42, title: "tool/result", text: "PORT=8080" },
  );
  assert.equal(toCandidate({ type: "tool/result" }), null, "a hit with no seq cannot be read back");
  assert.equal(toCandidate(null), null);
});

test("toCandidate skips events that are still on the current surface", () => {
  // Recalling what is already in the request spends budget to duplicate the prompt.
  assert.equal(toCandidate({ seq: 10, type: "tool/result", snippet: "x", surface: "current" }), null);
  assert.ok(toCandidate({ seq: 11, type: "tool/result", snippet: "x", surface: "shadowed" }));
  assert.ok(toCandidate({ seq: 12, type: "tool/result", snippet: "x", surface: "log-only" }));
});

test("toCandidate strips a reasoning payload from a snippet", () => {
  const candidate = toCandidate({
    seq: 5,
    type: "assistant/message",
    surface: "shadowed",
    snippet: "visible <reasoning>secret chain</reasoning> text",
  });
  assert.ok(!candidate.text.includes("secret chain"), "reasoning must never be recalled");
  assert.ok(candidate.text.includes("visible"));
});

test("selectRecall never returns nothing when there is one hit, even over budget", () => {
  const huge = { seq: 1, title: "tool/result", text: "x".repeat(20000) };
  const selected = selectRecall([huge], { budget: 100 });
  assert.equal(selected.length, 1, "the one hit is admitted regardless of size");
});

test("selectRecall fills up to the budget and stops", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    seq: i,
    title: "tool/result",
    text: "y".repeat(400),
  }));
  const selected = selectRecall(candidates, { budget: 500 });
  assert.ok(selected.length >= 1 && selected.length < candidates.length, "partial fill, not all");
});

test("selectRecall orders by backend score when provided", () => {
  const candidates = [
    { seq: 1, title: "t", text: "low", score: 1 },
    { seq: 2, title: "t", text: "high", score: 9 },
    { seq: 3, title: "t", text: "mid", score: 5 },
  ];
  const selected = selectRecall(candidates, { budget: 10090 });
  assert.deepEqual(selected.map((c) => c.seq), [2, 3, 1]);
});

test("renderRecallBlock frames the zone and cites each seq", () => {
  const block = renderRecallBlock([
    { seq: 7, title: "tool/result", text: "file contents here" },
    { seq: 9, title: "user/message", text: "the request" },
  ]);
  assert.ok(block.startsWith('<memory zone="recall">'));
  assert.ok(block.endsWith("</memory>"));
  assert.ok(block.includes("[seq 7]"), "seq is the handle to read the full event");
  assert.ok(block.includes("file contents here"));
});

test("renderRecallBlock is silent when there is nothing usable", () => {
  assert.equal(renderRecallBlock([]), "");
  assert.equal(renderRecallBlock([{ seq: 1, title: "t", text: "   " }]), "");
  assert.equal(renderRecallBlock(null), "");
});

test("recallFromCandidates respects the master switch", () => {
  const candidates = [{ seq: 1, title: "t", text: "something" }];
  assert.deepEqual(recallFromCandidates(candidates, { enabled: false }), { selected: [], block: "" });
  const on = recallFromCandidates(candidates, { enabled: true });
  assert.equal(on.selected.length, 1);
  assert.ok(on.block.includes("something"));
});

test("fetchCandidates prefers filterEvents on the base engine (no index)", async () => {
  // The base engine is always mounted and scans this session directly; the sqlite FTS
  // path is what built a ~95MB index and froze the desktop.
  let seenFilters = null;
  let seenSession = null;
  let searchCalled = false;
  const source = {
    filterEvents: async (sessionId, filters) => {
      seenSession = sessionId;
      seenFilters = filters;
      return [
        { seq: 10, type: "tool/result", text: "PORT=8080 in config", surface: "shadowed" },
        { seq: 11, type: "user/message", text: "unrelated chatter", surface: "log-only" },
      ];
    },
    searchEvents: async () => {
      searchCalled = true;
      return { items: [] };
    },
  };
  const hits = await fetchCandidates(source, { sessionId: "s1", query: "PORT 8080", limit: 5 });
  assert.equal(searchCalled, false, "must not touch the FTS backend when filterEvents exists");
  assert.equal(seenSession, "s1");
  // Regression: the engine's `text` filter is a literal, order-sensitive regex, so the
  // shipped v5 sent the whole query and matched nothing on every real Chinese turn.
  // fetchCandidates must NOT send a text predicate; it filters by surface and ranks
  // locally. This assertion is the one that would have caught the v5 bug.
  assert.equal(
    seenFilters.some((f) => f.kind === "text"),
    false,
    "must not hand the engine a whole-sentence text predicate",
  );
  assert.ok(seenFilters.some((f) => f.kind === "surface" && f.values.includes("shadowed")));
  assert.ok(seenFilters.some((f) => f.kind === "surface" && f.values.includes("log-only")));
  assert.equal(hits[0].seq, 10, "the hit matching both terms ranks first");
  assert.equal(hits.length, 1, "the non-matching event is dropped");
});

test("fetchCandidates matches a Chinese sentence to a real event (v5 regression)", async () => {
  // The exact failure found on a live 15-turn session: a natural Chinese question must
  // recall the event that answers it, even though the event shares no long verbatim
  // substring with the question. Under the old whole-string text filter this returned
  // 0 hits for every turn and recallPublished stayed 0 for the whole session.
  const records = [
    { seq: 185, type: "tool/result", text: "Pd/Ni 纳米多层膜，5 个周期交替蒸镀，用于氢气检测", surface: "shadowed" },
    { seq: 250, type: "assistant/message", text: "全文只测了 3 种气体，每种气体对应一种敏感材料", surface: "shadowed" },
    { seq: 300, type: "user/message", text: "今天天气怎么样", surface: "log-only" },
  ];
  const source = { filterEvents: async () => records };

  const aboutFilm = await fetchCandidates(source, {
    sessionId: "s",
    query: "这篇文章里的氢气传感薄膜是怎么做的",
    limit: 5,
  });
  assert.ok(aboutFilm.length > 0, "a Chinese sentence must recall something");
  assert.equal(aboutFilm[0].seq, 185, "the hydrogen-film event must rank first");

  const aboutGases = await fetchCandidates(source, {
    sessionId: "s",
    query: "统计下这篇文章测了哪些气体，用什么材料测的",
    limit: 5,
  });
  assert.ok(aboutGases.length > 0, "a second, differently-worded Chinese sentence must also recall");
  assert.equal(aboutGases[0].seq, 250, "the gas-count event must rank first");
  assert.ok(
    !aboutGases.some((hit) => hit.seq === 300),
    "the unrelated weather message must not be recalled",
  );
});

test("fetchCandidates falls back to searchEvents and forwards the signal", async () => {
  const controller = new AbortController();
  let seenExec = null;
  const source = {
    searchEvents: async (_request, exec) => {
      seenExec = exec;
      return { items: [{ seq: 3 }] };
    },
  };
  const hits = await fetchCandidates(source, { sessionId: "s", query: "find me", limit: 2 }, controller.signal);
  assert.equal(seenExec?.signal, controller.signal);
  assert.equal(hits.length, 1);
});

test("fetchCandidates returns [] on every failure path instead of throwing", async () => {
  assert.deepEqual(await fetchCandidates(null, { sessionId: "s", query: "q", limit: 5 }), []);
  assert.deepEqual(await fetchCandidates({}, { sessionId: "s", query: "q", limit: 5 }), []);
  assert.deepEqual(
    await fetchCandidates(
      { filterEvents: async () => { throw new Error("backend down"); } },
      { sessionId: "s", query: "q", limit: 5 },
    ),
    [],
  );
});

test("queryTerms splits CJK into bigrams but keeps latin words whole", () => {
  // CJK: keep the whole segment AND add every character bigram, so a natural sentence
  // can match an event that only shares a few adjacent characters.
  const terms = queryTerms("这个文件 写了什么？PORT 8080");
  for (const whole of ["这个文件", "写了什么"]) assert.ok(terms.includes(whole), `keeps whole segment ${whole}`);
  for (const gram of ["这个", "个文", "文件", "写了", "了什", "什么"]) assert.ok(terms.includes(gram), `adds bigram ${gram}`);
  // Latin segments stay whole words — bigram-splitting them would match unrelated text.
  assert.ok(terms.includes("port"));
  assert.ok(terms.includes("8080"));
  assert.ok(!terms.includes("po"), "latin words must not be bigram-split");

  assert.deepEqual(queryTerms("a b cd"), ["cd"], "single-char words are dropped");
  assert.deepEqual(queryTerms(""), []);
});

test("RECALL_SURFACES is exactly what the fold removed, never current", () => {
  assert.deepEqual([...RECALL_SURFACES], ["shadowed", "log-only"]);
  assert.ok(!RECALL_SURFACES.includes("current"), "recalling the current event duplicates the prompt");
});

test("rankDocuments orders by term-hit count and drops zero-score rows", () => {
  const rows = [
    { seq: 1, title: "t", text: "alpha" },
    { seq: 2, title: "t", text: "alpha beta" },
    { seq: 3, title: "t", text: "nothing" },
  ];
  const ranked = rankDocuments(rows, ["alpha", "beta"]);
  assert.deepEqual(ranked.map((r) => r.seq), [2, 1]);
  // Coverage is a fraction of the query's IDF mass; the row matching both terms covers all.
  assert.ok(Math.abs(ranked[0].coverage - 1) < 1e-9, "both-term row covers the whole query");
  assert.ok(ranked[1].coverage < ranked[0].coverage, "single-term row covers less");
});

test("coverage gate suppresses tangential queries but keeps real ones (v5 precision)", async () => {
  // A corpus big enough to pass minRowsForGate so the gate is actually exercised, shaped
  // like a real log: assistant answers are long and restate the question in their own
  // words (that echo is exactly what makes coverage work on live data — verified against
  // a real 15-turn session), while unrelated turns share only common connective words.
  const common = ["这篇文章", "怎么做", "什么", "处理", "文件", "分析", "结果", "数据", "确认", "检查", "运行"];
  const filler = Array.from({ length: 40 }, (_, i) => ({
    seq: 100 + i,
    type: "tool/result",
    text: `第${i}步，我检查了这个文件并分析了结果，数据没问题，怎么处理都可以，确认一下再运行。${common[i % common.length]}`,
    surface: "shadowed",
  }));
  const relevant = [
    {
      seq: 1,
      type: "assistant/message",
      text: "这篇文章里的氢气传感薄膜是怎么做的？我查了一下，氢气敏感膜是 Pd/Ni 纳米多层膜，5 个周期交替蒸镀，用电子束热蒸发，室温工作。",
      surface: "shadowed",
    },
    {
      seq: 2,
      type: "assistant/message",
      text: "我统计下这篇文章测了哪些气体、用什么材料测的：全文只测了 3 种气体，每种气体对应一种专门的敏感材料。",
      surface: "shadowed",
    },
  ];
  const source = { filterEvents: async () => [...relevant, ...filler] };

  const real = await fetchCandidates(source, {
    sessionId: "s",
    query: "这篇文章里的氢气传感薄膜是怎么做的",
    limit: 5,
  });
  assert.ok(real.length > 0, "a real question must survive the gate");
  assert.equal(real[0].seq, 1, "the hydrogen-film event must rank first");

  // Off-topic wording that only superficially shares common characters must be gated to [].
  const noise = await fetchCandidates(source, {
    sessionId: "s",
    query: "推荐几本好看的小说",
    limit: 5,
  });
  assert.deepEqual(noise, [], "off-topic query must not inject recall");
});

test("rankDocuments is stable below the gate's row threshold (small sessions still recall)", async () => {
  // Under minRowsForGate, IDF has no contrast; the gate must be skipped so a real hit in a
  // short session is still recalled. This is the regression that the first cut of the
  // coverage gate introduced.
  const source = {
    filterEvents: async () => [
      { seq: 7, type: "tool/result", text: "氢气敏感膜是 Pd/Ni 多层膜", surface: "shadowed" },
      { seq: 8, type: "user/message", text: "今天天气不错", surface: "log-only" },
    ],
  };
  const hits = await fetchCandidates(source, { sessionId: "s", query: "氢气薄膜怎么做", limit: 5 });
  assert.ok(hits.length > 0, "a short session must still recall");
  assert.equal(hits[0].seq, 7);
});

test("filterEventsToRows drops seq-less and reasoning-only documents", () => {
  const rows = filterEventsToRows([
    { seq: 5, type: "tool/result", text: "real content" },
    { type: "tool/result", text: "no seq" },
    { seq: 6, type: "assistant/message", text: "<reasoning>secret</reasoning>   " },
  ]);
  assert.deepEqual(rows.map((r) => r.seq), [5]);
});

test("defaults keep the recall block within the plan's <=1200 token zone", () => {
  assert.ok(RECALL_DEFAULTS.budget <= 1200, "a bigger block would undo the fold that saved the space");
  assert.equal(RECALL_DEFAULTS.enabled, true);
});
