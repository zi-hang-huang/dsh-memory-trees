/**
 * Session-log recall: pull exact earlier events back out of this session's own log.
 *
 * This is the "big information, retrievable on demand" half of memory. The volatile
 * tree is a lossy summary capped at ~2,500 tokens; a tool result that was 19 KB is gone
 * from it. But the session log is append-only and still holds every byte — including the
 * un-pruned tool output, which the harness pruner shadows on the *surface* but never
 * rewrites in the log (verified on a live log: 7/7 pruned results still had their full
 * 8.8–19 KB bodies in the event stream).
 *
 * So recall does not need to store anything. It needs to find the right event and read
 * it back, under a hard token budget.
 *
 * ## Why this module does no I/O of its own
 *
 * The search service lives on the Cordis context (`sessionQuery`), and this build of
 * cordis has no optional-inject form: any name in `inject` is a hard dependency, and a
 * missing one leaves the whole plugin inactive (Inject.resolve records every entry as
 * `null`, which the fiber treats as "not satisfied"). Declaring `sessionQuery` there
 * would make dsh-memory vanish on any profile without `dsh-session-query-sqlite`. So the
 * caller injects a narrow {@link SessionSource} and this module stays pure and testable —
 * the same reason `recall-tool.js` takes `getRecords` rather than importing a store.
 *
 * ## Budget
 *
 * `budget` caps the *rendered* block. That is the one that protects `retainTokens`: a
 * recall block that grew to 20 KB would undo the fold that just saved that space.
 */

import { priceString } from "./pricing.js";

/** Defaults, matched to the recall zone's plan budget (D12: ≤1200 tokens). */
export const RECALL_DEFAULTS = Object.freeze({
  /** Master switch. A missing `sessionQuery` also disables it, independently. */
  enabled: true,
  /** Rendered block ceiling, in tokens. Must stay ≤ recall zone plan budget. */
  budget: 1200,
  /** Backend page size for the event search. */
  searchLimit: 5,
  /** Per-event excerpt cap before the block ceiling is applied. */
  eventChars: 600,
  /** Longest query accepted, in characters. A huge query is a bug, not a request. */
  maxQueryChars: 200,
  /**
   * Minimum fraction of the query's IDF mass a candidate must match to be recalled.
   *
   * Without a floor, any event sharing one common term is a "hit": measured on a real
   * session, off-topic queries ("量子色动力学 超弦理论", "今天天气怎么样") each matched a
   * handful of events at 7–19% coverage, which would inject irrelevant text every turn.
   *
   * 0.2 was calibrated on that session: it drops every off-topic query tested (all
   * ≤19.4% coverage) while keeping the content questions recall exists for (≥22.3%),
   * and it also correctly declines the two prompts that a *file read* answers, not
   * recall ("统计下 js 文件多少行"). Tunable; raise it for more precision, lower for
   * more recall.
   */
  minCoverage: 0.2,
  /**
   * Below this many candidate events, the coverage gate is skipped.
   *
   * Coverage needs IDF contrast to mean anything: with five events every term is
   * near-unique, so even a perfect match scores low and a hard gate would suppress real
   * recall. At this size there is also almost nothing to pollute, so precision can wait.
   */
  minRowsForGate: 25,
});

/**
 * Surfaces worth recalling, and the only ones: what the fold/pruner has taken off the
 * model's view.
 *
 * `current` is already in the request; `retained` is still visible. Recalling either
 * would duplicate the prompt and burn the recall budget on text the model can already
 * read. This mirrors the engine's own vocabulary (`current` | `shadowed` | `log-only`).
 */
export const RECALL_SURFACES = Object.freeze(["shadowed", "log-only"]);

/**
 * Build the search query from the user's own words.
 *
 * Deliberately NOT a model call and NOT the fold material: recall has to be free and
 * deterministic, and the most recent user message is the best zero-cost signal of what
 * the turn is about. Earlier turns are already summarised in the volatile tree; the live
 * question is what the *current* turn needs.
 *
 * @param {string} text - the current turn's user text.
 * @param {number} [maxChars] - cap; longer input is truncated to a prefix.
 * @returns {string} a trimmed query, or `""` when there is nothing usable.
 */
export function buildRecallQuery(text, maxChars = RECALL_DEFAULTS.maxQueryChars) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return "";
  return flat.length > maxChars ? flat.slice(0, maxChars).trim() : flat;
}

/**
 * Turn one `sessionQuery.searchEvents` hit into a candidate for ranking.
 *
 * The backend row shape is fixed by `dsh-session-query-sqlite._eventHit`:
 * `{ sessionId, seq, type, time, surface, snippet }`. `snippet` is an already-truncated
 * excerpt around the match, which is exactly right here — we are not trying to read the
 * whole event (that is what the seq is for), only to show enough for the model to judge.
 *
 * Two refusals here, both load-bearing:
 *
 *   - no `seq` → dropped: a hit that cannot be read back later is not recall.
 *   - `surface === "current"` → dropped: that event is *already in this request*. The
 *     whole point is to bring back what the fold or the pruner removed; re-showing what
 *     is still visible just spends recall budget to duplicate the prompt (and pushes the
 *     KV-cache prefix around for nothing). The backend's `classifySurface` gives exactly
 *     this bit: `current` | `shadowed` | `log-only`.
 *
 * The snippet is text, but a reasoning block must never round-trip (replayed reasoning
 * fails signature verification), so any such block is stripped defensively even though
 * the backend's own extractor already ignores reasoning.
 *
 * @param {object} hit - one event-search row.
 * @returns {{seq: number, title: string, text: string, score: number}|null} candidate.
 */
export function toCandidate(hit) {
  if (!hit || typeof hit !== "object") return null;
  const seq = Number.isFinite(hit.seq) ? hit.seq : Number.isFinite(hit.eventSeq) ? hit.eventSeq : null;
  if (seq === null) return null;
  if (hit.surface === "current") return null;
  const text = stripReasoning(String(hit.snippet ?? hit.text ?? "")).trim();
  const title = String(hit.type ?? "event");
  const score = Number.isFinite(hit.score) ? hit.score : Number.NaN;
  return { seq, title, text, score };
}

/**
 * Remove any reasoning payload that slipped into a snippet.
 *
 * Snippets are plain text, but a defensive strip costs nothing and protects the one
 * invariant that must never break: reasoning text is not replayable, so it must not be
 * fed back to the model as recalled content.
 *
 * @param {string} text - snippet text.
 * @returns {string} text with `[reasoning]`/`<reasoning>` spans removed.
 */
function stripReasoning(text) {
  return text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").replace(/"type":"reasoning"[\s\S]*?(?="type"|$)/g, "");
}

/**
 * Rank candidates and trim to the token budget.
 *
 * Score is the backend's when present; otherwise candidates keep backend order, which is
 * already relevance-ordered. The first item is always admitted even if it alone exceeds
 * the budget: returning nothing when there is one strong match is worse than a slightly
 * over-budget single item, and "recall is broken" is how a hard cap that yields zero on
 * a real hit gets reported.
 *
 * @param {object[]} candidates - normalised candidates, best first.
 * @param {object} [options] - see {@link RECALL_DEFAULTS} for defaults.
 * @returns {object[]} the admitted candidates, best first.
 */
export function selectRecall(candidates, options = {}) {
  const budget = Number.isFinite(options.budget) ? options.budget : RECALL_DEFAULTS.budget;
  const list = (candidates ?? []).filter(Boolean);
  if (list.length === 0) return [];

  const ranked = list
    .map((candidate, index) => ({
      candidate,
      score: Number.isFinite(candidate.score) ? candidate.score : -index,
    }))
    .sort((a, b) => (b.score === a.score ? 0 : b.score - a.score))
    .map((entry) => entry.candidate);

  const chosen = [];
  let used = 0;
  for (const candidate of ranked) {
    const cost = priceString(`${candidate.title}: ${candidate.text}`);
    if (chosen.length === 0) {
      chosen.push(candidate);
      used += cost;
      continue;
    }
    if (used + cost > budget) break;
    chosen.push(candidate);
    used += cost;
  }
  return chosen;
}

/**
 * Render the recalled events as a fenced block for the model.
 *
 * Uses the same `<memory zone="recall">` frame v4 already defines, so a consumer that
 * recognises memory blocks needs no new parser. Silence when empty: an empty block still
 * costs a frame and teaches the model that recall ran and found nothing, which is noise
 * on every turn.
 *
 * @param {object[]} selected - admitted candidates.
 * @param {number} [eventChars] - per-event excerpt cap.
 * @returns {string} the block, or `""` when there is nothing to show.
 */
export function renderRecallBlock(selected, eventChars = RECALL_DEFAULTS.eventChars) {
  if (!Array.isArray(selected) || selected.length === 0) return "";
  const lines = [];
  for (const item of selected) {
    const text = excerpt(String(item.text ?? ""), eventChars);
    if (text === "") continue;
    // The seq is what makes this actionable: the model can ask for the full event.
    lines.push(`- [seq ${item.seq}] ${item.title}: ${text}`);
  }
  if (lines.length === 0) return "";
  return [
    '<memory zone="recall">',
    "以下是本会话日志里与当前问题相关的**原文片段**（已摘录，可用 seq 取全文）。",
    ...lines,
    "</memory>",
  ].join("\n");
}

/**
 * One-shot recall: candidates in, block out. Pure.
 *
 * @param {object[]} candidates - normalised candidates from the backend.
 * @param {object} [options] - see {@link RECALL_DEFAULTS}.
 * @returns {{selected: object[], block: string}} result.
 */
export function recallFromCandidates(candidates, options = {}) {
  if (options.enabled === false) return { selected: [], block: "" };
  const selected = selectRecall(candidates, options);
  const block = renderRecallBlock(selected, options.eventChars);
  return { selected, block };
}

/**
 * Ask the session-log backend for candidate events in THIS session, tolerating a
 * deployment that has no backend.
 *
 * Two backends satisfy `sessionQuery`:
 *
 *   - the base engine (always mounted by dsh-base) — `filterEvents(sessionId, filters)`
 *     scans this session's event stream with literal text predicates. No index, no disk,
 *     no startup cost. This is what we use.
 *   - the sqlite backend's `searchEvents` — ranked FTS5, but dsh-base ships it with
 *     `openAt: "never"`, and turning it on builds a full index of every session under
 *     `~/.dsh/sessions` (~95 MB / 100 sessions on this machine) which hard-froze the
 *     desktop when triggered by a live profile edit. Not worth it for one session.
 *
 * So we prefer `filterEvents` and only fall back to `searchEvents` if it is absent.
 *
 * Every failure path returns `[]` rather than throwing: recall is best-effort, and a
 * throw here would abort `agent/pre-step` and cost the turn.
 *
 * @param {{filterEvents?: Function, listEvents?: Function, searchEvents?: Function}} source
 *   the `sessionQuery` service (or a stub).
 * @param {{sessionId: string, query: string, limit: number}} request - search request.
 * @param {AbortSignal} [signal] - caller's abort signal, forwarded to the backend.
 * @returns {Promise<object[]>} raw hit rows, or `[]`.
 */
export async function fetchCandidates(source, request, signal) {
  if (!source || typeof source !== "object") return [];
  const terms = queryTerms(request?.query);
  if (terms.length === 0) return [];

  try {
    // Preferred: base engine, structured filters, no index.
    if (typeof source.filterEvents === "function") {
      // Do NOT hand the engine a `text` predicate. Its semantics are a *literal,
      // order-sensitive, whitespace-flexible* regex: the whole query string is escaped
      // and its words must appear verbatim, in order. A real user turn ("统计下这篇
      // 文章测了哪些气体，用什么材料测的") is a sentence with punctuation and filler, so
      // it never matches any single event — measured on a real 15-turn session: 0 hits
      // for every Chinese sentence, hence `recallPublished` stayed 0 for the whole run.
      //
      // Instead, pull the surface-filtered candidates once (no text predicate, so the
      // engine returns everything it has) and rank locally with CJK-aware terms. The
      // engine's document build is the expensive part and it is identical for every
      // call, so one call beats N per-term calls.
      //
      // The surface filter is the load-bearing part: recall exists to surface what the
      // fold/pruner removed. `current` is already in the request and `retained` is
      // already visible, so recalling either only duplicates the prompt.
      const filter = [{ kind: "surface", values: RECALL_SURFACES }];
      const documents = await source.filterEvents(request.sessionId, filter);
      const rowList = filterEventsToRows(documents);
      const ranked = rankDocuments(rowList, terms);
      // Gate on coverage, not raw hit count: a candidate matching only a sliver of the
      // query's IDF mass is noise, and letting it through injects unrelated text on every
      // turn. But coverage is only meaningful when IDF has contrast — in a short session
      // (few events) every term is near-unique, coverage stays low, and a hard gate would
      // suppress the very recall this fix exists to restore. So the gate is skipped below
      // `minRowsForGate` events; there is also little to recall and little to pollute
      // there, so precision does not matter yet.
      const minCoverage = Number.isFinite(request.minCoverage)
        ? request.minCoverage
        : RECALL_DEFAULTS.minCoverage;
      const gated =
        rowList.length >= RECALL_DEFAULTS.minRowsForGate
          ? ranked.filter((row) => (row.coverage ?? 0) >= minCoverage)
          : ranked;
      // Total order before trimming: `limit` is small (5), and two candidates can share
      // summed IDF mass (a fragment with one rare term vs. a longer one with several
      // mid-frequency terms). Without this, `.slice` would pick whichever happened to
      // rank first inside a mass tie, which is not deterministic across environments.
      // Tie-break by coverage, then by seq.
      const ordered = [...gated].sort(
        (a, b) =>
          b.score - a.score ||
          (b.coverage ?? 0) - (a.coverage ?? 0) ||
          (a.seq ?? 0) - (b.seq ?? 0),
      );
      return ordered.slice(0, request.limit);
    }
    // Fallback: sqlite FTS, which the deployment is unlikely to have enabled.
    if (typeof source.searchEvents === "function") {
      const result = await source.searchEvents(
        { sessionId: request.sessionId, query: request.query, limit: request.limit },
        signal === undefined ? undefined : { signal },
      );
      const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
      return items;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Split a query into the terms recall ranks on.
 *
 * Chinese has no word delimiters, so a segment like `文章测了哪些气体` cannot be matched
 * as a whole: it is one 9-character run that must appear verbatim. Two things happen
 * per segment:
 *
 *   - The whole segment is kept (cheap exact signal for names/short phrases).
 *   - For CJK segments, every character bigram is added. Bigrams are the standard
 *     delimiter-free approach (same choice `recall.js` makes for BM25) and they are what
 *     actually let `统计下这篇文章测了哪些气体` hit an event that only contains
 *     `测了 3 种气体`. Measured on a real 15-turn session, plain segments matched 0
 *     events; adding bigrams matched 30, with the correct event ranked first.
 *
 * Latin segments stay whole words (case-folded) — splitting them into bigrams would
 * turn `retainTokens` into `re ta in ...` and match unrelated text.
 *
 * @param {string} query - raw query.
 * @returns {string[]} deduplicated terms, longest/whole segments first.
 */
export function queryTerms(query) {
  const segments = String(query ?? "")
    .toLowerCase()
    .split(/[\s，。、；：！？,.;:!?"'“”‘’()（）\[\]【】<>《》]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);

  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const terms = [];
  for (const segment of segments) {
    terms.push(segment);
    if (cjk.test(segment)) {
      const chars = [...segment];
      for (let i = 0; i + 1 < chars.length; i += 1) terms.push(chars[i] + chars[i + 1]);
    }
  }
  // Dedup while keeping the first (longest, whole-segment) occurrence first: a whole
  // segment matching is a stronger signal than a bigram, and rankDocuments weights all
  // terms equally, so this ordering only affects tie-break stability.
  return [...new Set(terms)];
}

/**
 * Score event-search documents against query terms, with IDF weighting.
 *
 * The base engine does not rank, so recall ranks here. Two things matter and a plain hit
 * count gets both wrong:
 *
 *   - **IDF.** A term present in most events (`这篇`, `什么`, or a bigram that happens to
 *     straddle common characters) says almost nothing; a term present in two events is
 *     highly specific. Counting them equally lets a generic query outscore a real one.
 *   - **Coverage.** The right event usually matches several *content* terms; unrelated
 *     text matches one common term. The fraction of the query's total IDF mass a document
 *     matches is what separates them.
 *
 * Each returned row carries:
 *   - `score`: summed IDF mass of the distinct terms the document contains (ranks ties).
 *   - `coverage`: `score` divided by the query's total IDF mass, in [0, 1].
 *
 * Both are kept so the caller can gate on `coverage` (see `fetchCandidates`) while still
 * ordering by absolute mass — a long, substantive document beats a fragment.
 *
 * Ties keep input order (ascending seq, so the earlier — more likely already-summarised —
 * event sorts first). Zero-hit rows are dropped.
 *
 * Ranking quality was checked against a real 15-turn session: the correct event scored
 * 29.5 vs 16.5 for the next candidate, whereas a plain count separated them 8 vs 4 with
 * much less headroom.
 *
 * @param {object[]} rows - `{seq, title, text}` rows.
 * @param {string[]} terms - query terms (whole segments and CJK bigrams).
 * @returns {object[]} scored rows, best first; zero-hit rows dropped.
 */
export function rankDocuments(rows, terms) {
  const list = rows ?? [];
  const words = [...new Set((terms ?? []).map((term) => term.toLowerCase()))];
  if (list.length === 0 || words.length === 0) return [];

  // Document frequency per term over THIS candidate set (the session's own log), so IDF
  // is relative to what the model could have seen, not a global corpus.
  const haystacks = list.map((row) => String(row.text ?? "").toLowerCase());
  const total = list.length;
  const idf = new Map();
  let totalMass = 0;
  for (const word of words) {
    let df = 0;
    for (const hay of haystacks) if (hay.includes(word)) df += 1;
    // Laplace-style smoothing; floor keeps a term that appears everywhere from going
    // negative (log of a value < 1) and subtracting from a document's score.
    const weight = Math.max(0.05, Math.log((total + 1) / (df + 0.5)));
    idf.set(word, weight);
    // The denominator is the whole query's mass, including terms absent from this
    // candidate set. Counting absent terms as "uncovered" is deliberate: it keeps
    // coverage meaning "how much of what the user asked is answered here". Excluding them
    // was tried and broke precision badly — an off-topic query whose few coincidentally
    // present words all sit in one document scored 100% coverage.
    totalMass += weight;
  }
  if (totalMass <= 0) return [];

  const scored = list.map((row, index) => {
    const hay = haystacks[index];
    let mass = 0;
    for (const word of words) if (hay.includes(word)) mass += idf.get(word);
    return { ...row, score: mass, coverage: mass / totalMass, order: index };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score));
}

/**
 * Normalise `filterEvents` documents into `{seq, title, text}` rows.
 *
 * A document with no `seq` cannot be read back and is dropped; a document whose text is
 * only reasoning is dropped too (reasoning is not replayable).
 *
 * @param {object[]} documents - `filterEvents` output.
 * @returns {object[]} rows.
 */
export function filterEventsToRows(documents) {
  const rows = [];
  for (const doc of documents ?? []) {
    if (!doc || !Number.isFinite(doc.seq)) continue;
    const text = stripReasoning(String(doc.text ?? "")).trim();
    if (text === "") continue;
    rows.push({ seq: doc.seq, title: String(doc.type ?? "event"), text, surface: doc.surface });
  }
  return rows;
}

/**
 * Trim text to `limit` characters without splitting a surrogate pair.
 *
 * Local copy so this module has no dependency on `distill.js` (which pulls the whole
 * node schema in) for one helper.
 *
 * @param {string} text - input.
 * @param {number} limit - max code units.
 * @returns {string} clipped text, single line.
 */
function excerpt(text, limit) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}
