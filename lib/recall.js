/**
 * v4 recall: local BM25 over character bigrams, plus gating, graph expansion and the
 * recall-zone renderer.
 *
 * Design constraints, each earned from an earlier failure:
 *
 * 1. **Pure and deterministic.** This runs on every `agent/pre-step`. Anything that
 *    varies between two identical calls — a timestamp, a counter, a Map iteration
 *    order — changes the rendered block, which changes the request prefix, which
 *    throws away the provider's cache. Measured hit rate before this feature was
 *    97-99%; that is the number this module must not break.
 *
 * 2. **Character bigrams, not a tokenizer.** Chinese has no word delimiters and there
 *    is no tokenizer dependency to lean on. Bigrams over characters are the standard
 *    zero-dependency answer. The cost is deliberate: 「保留」 and 「保存」 share the
 *    character 保 but no bigram, so they do not match. Direction is "miss, never
 *    over-match", because a wrongly recalled memory is worse than a missing one — it
 *    arrives looking authoritative.
 *
 * 3. **Silence is the default.** An empty result renders to `""` and appends nothing.
 *
 * `isSearchable` lives in `promote.js` because retirement is a property of the record,
 * not of the search; this module imports it rather than re-deriving the rules.
 */

import { isSearchable } from "./promote.js";
import { priceString } from "./pricing.js";
import { frameZone } from "./tree.js";

/** Okapi BM25 saturation and length-normalisation constants (standard defaults). */
const K1 = 1.2;
const B = 0.75;

/**
 * Character bigrams. A one-character string is its own token so short CJK queries do
 * not vanish, and an empty string yields no tokens at all.
 *
 * @param {string} text - input.
 * @returns {string[]} bigrams, in order of appearance.
 */
export function bigrams(text) {
  const chars = [...String(text ?? "").toLowerCase()];
  if (chars.length === 0) return [];
  if (chars.length === 1) return chars;
  const out = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

/**
 * Rank documents against a query with BM25.
 *
 * @param {{id: string, text: string}[]} docs - searchable documents.
 * @param {string} query - free text.
 * @param {object} [options] - tuning.
 * @param {number} [options.topK] - maximum hits returned.
 * @param {number} [options.k1] - term-frequency saturation.
 * @param {number} [options.b] - length normalisation.
 * @returns {{id: string, score: number}[]} hits, highest score first.
 */
export function bm25Rank(docs, query, options = {}) {
  const topK = Number.isFinite(options.topK) ? options.topK : 5;
  const k1 = Number.isFinite(options.k1) ? options.k1 : K1;
  const b = Number.isFinite(options.b) ? options.b : B;
  if (!Array.isArray(docs) || docs.length === 0) return [];

  const docTokens = docs.map((doc) => bigrams(doc?.text));
  const lens = docTokens.map((tokens) => tokens.length);
  const totalLen = lens.reduce((sum, n) => sum + n, 0);
  if (totalLen === 0) return [];
  const avgLen = totalLen / docs.length || 1;

  // term -> [[docIndex, tf], ...]. Built per call: 500 docs measured at 0.049 ms,
  // which is far below any threshold worth caching for.
  const postings = new Map();
  for (let d = 0; d < docTokens.length; d += 1) {
    const tf = new Map();
    for (const token of docTokens[d]) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [token, count] of tf) {
      let list = postings.get(token);
      if (!list) postings.set(token, (list = []));
      list.push([d, count]);
    }
  }

  const queryTokens = [...new Set(bigrams(query))];
  if (queryTokens.length === 0) return [];

  const scores = new Array(docs.length).fill(0);
  for (const token of queryTokens) {
    const list = postings.get(token);
    if (!list) continue;
    const df = list.length;
    const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
    for (const [d, tf] of list) {
      const denom = tf + k1 * (1 - b + b * (lens[d] / avgLen));
      scores[d] += idf * ((tf * (k1 + 1)) / denom);
    }
  }

  const hits = [];
  for (let d = 0; d < docs.length; d += 1) {
    if (scores[d] > 0) hits.push({ id: docs[d].id, score: scores[d] });
  }
  // Ties keep input order: `sort` is stable in V8, and re-ordering equal scores by id
  // would make the render depend on ids the model never sees.
  hits.sort((left, right) => right.score - left.score);
  return hits.slice(0, topK);
}

/**
 * Searchable text for one record. `subject` is included because it is what a user
 * actually types ("config.retain_tokens"), and because it is the key the supersede
 * chain is built on.
 *
 * @param {object} record - LTM record.
 * @returns {string} text to index.
 */
function indexText(record) {
  return [record?.title ?? "", record?.body ?? "", record?.subject ?? ""]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * The "family" a record belongs to, used as the edge in expansion.
 *
 * Priority (v8): **work → subject → session**.
 *   1. `work` (v8): every record about the same piece of work shares one `work:<name>`
 *      key, so a hit on any of them brings the whole work back. This is the structural
 *      edge that makes "同一个工作中的几条信息" recall together. `work` carries no date
 *      (see work.js), so the same work across days/sessions stays one family.
 *   2. `subject` is a dotted namespace (`config.retain_tokens`), so everything before
 *      the last dot is the family.
 *   3. Otherwise the first source session: two facts learned in the same session are
 *      often about the same task — the fallback when neither work nor subject exists.
 *
 * @param {object} record - LTM record.
 * @returns {string|null} family key.
 */
function familyOf(record) {
  // v8: work is the strongest edge — a work summary and its members all share it.
  const work = typeof record?.work === "string" ? record.work : "";
  if (work !== "") return `work:${work}`;
  const subject = typeof record?.subject === "string" ? record.subject : "";
  if (subject !== "") {
    const dot = subject.lastIndexOf(".");
    return `subject:${dot === -1 ? subject : subject.slice(0, dot)}`;
  }
  const sessionId = record?.sources?.[0]?.sessionId;
  return typeof sessionId === "string" ? `session:${sessionId}` : null;
}

/**
 * Expand a seed set with records from the same families — one hop, capped.
 *
 * This is what stands in for "graph expansion" in the plan. It does not fix
 * paraphrase; it answers "I matched one fact about config, what else is under config".
 * One hop only: a multi-hop walk over a store this small creates false relationships
 * faster than it finds real ones.
 *
 * @param {object[]} records - LTM records.
 * @param {string[]} seedIds - ids already recalled.
 * @param {object} [options] - expansion limits.
 * @param {number} [options.maxExtra] - extra records allowed; 0 disables expansion.
 * @returns {string[]} ids to add, best first.
 */
export function expandRecall(records, seedIds, options = {}) {
  const maxExtra = Number.isFinite(options.maxExtra) ? options.maxExtra : 2;
  if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
  if (maxExtra <= 0) return [];
  if (!Array.isArray(records) || records.length === 0) return [];

  const searchable = records.filter(isSearchable);
  const byId = new Map(searchable.map((record) => [record.id, record]));

  const wanted = new Set();
  for (const id of seedIds) {
    const seed = byId.get(id);
    if (!seed) continue;
    const key = familyOf(seed);
    if (key != null) wanted.add(key);
  }
  if (wanted.size === 0) return [];

  const seedSet = new Set(seedIds);
  const candidates = searchable
    .filter((record) => !seedSet.has(record.id))
    .sort((left, right) => {
      const byWeight = (right.weight ?? 0) - (left.weight ?? 0);
      if (byWeight !== 0) return byWeight;
      // Plain comparison, not localeCompare: the latter depends on the process locale
      // and would make the render non-reproducible across machines.
      return String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0;
    });

  const picked = [];
  const pushIfRoom = (record) => {
    if (picked.length >= maxExtra) return;
    if (record == null) return;
    if (seedSet.has(record.id) || picked.includes(record.id)) return;
    picked.push(record.id);
  };

  // (a) v8: a hit on a work member should first bring its pivot (the work outline),
  // because the pivot is the readable "what else is in this work" anchor. Explicit
  // parentId beats a generic family match, so pivot selection is not left to weight ties.
  const byIdAll = new Map(searchable.map((record) => [record.id, record]));
  for (const id of seedIds) {
    if (picked.length >= maxExtra) break;
    const seed = byIdAll.get(id);
    if (!seed) continue;
    const pid = typeof seed.parentId === "string" ? seed.parentId : null;
    if (pid != null) pushIfRoom(byIdAll.get(pid));
  }

  // (b) then fill from the same families (work/subject/session), best (weight) first.
  for (const record of candidates) {
    if (picked.length >= maxExtra) break;
    const key = familyOf(record);
    if (key != null && wanted.has(key)) pushIfRoom(record);
  }
  return picked;
}

/**
 * Render recalled records as a framed recall zone.
 *
 * Empty results render to `""` rather than an empty block: an empty block still
 * occupies a surface slot and would be re-sent every turn for nothing.
 *
 * Deliberately minimal — title, then body only when there is one. No ids, no scores,
 * no provenance: `sources` is audit material and putting it here would both cost
 * tokens and teach the model to cite things the user cannot see. Input order is
 * preserved so the caller's ranking survives.
 *
 * @param {object[]} records - selected records, best first.
 * @returns {string} framed block, or `""` when there is nothing to show.
 */
export function renderRecallBlock(records) {
  if (!Array.isArray(records) || records.length === 0) return "";
  const lines = [];
  for (const record of records) {
    const title = String(record?.title ?? "").trim();
    const body = String(record?.body ?? "").trim();
    if (title === "" && body === "") continue;
    // v8: a work summary is an outline of related items; render it as a header line so
    // the model reads it as "these belong to one work", not as one more flat fact.
    if (record?.kind === "work-summary") {
      lines.push(body === "" ? `- ${title}` : `- ${title}（${body}）`);
      continue;
    }
    if (body === "") lines.push(`- ${title}`);
    else if (title === "") lines.push(`- ${body}`);
    else lines.push(`- ${title}：${body}`);
  }
  if (lines.length === 0) return "";
  return frameZone("recall", lines.join("\n"));
}

/**
 * Select the records to recall: filter, rank, then trim to a token budget.
 *
 * Filtering uses `isSearchable` from `promote.js` — retirement is a property of the
 * record, and `mergeLtm` only *marks* records, never removes them. A recall path that
 * skipped this check would keep serving superseded values while the store looked
 * correct.
 *
 * @param {object[]} records - LTM records.
 * @param {string} query - free text.
 * @param {object} [options] - gating.
 * @param {number} [options.topK] - candidates to rank.
 * @param {number} [options.minScore] - BM25 score floor; below it nothing is recalled.
 *   Default 1.0, measured rather than guessed: a real match on this store's records
 *   scores 6.5-9.4, while a single coincidental bigram (`nt` inside both
 *   `retainTokens` and `quantum`) scores 0.17-0.60. 1.0 sits an order of magnitude
 *   above the noise and well below a real hit.
 * @param {number} [options.budget] - token ceiling for the selected records.
 * @returns {object[]} selected records, best first.
 */
export function selectRecall(records, query, options = {}) {
  if (typeof query !== "string" || query.trim() === "") return [];
  if (!Array.isArray(records) || records.length === 0) return [];

  const topK = Number.isFinite(options.topK) ? options.topK : 5;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1.0;
  const budget = Number.isFinite(options.budget) ? options.budget : 1200;

  const searchable = records.filter(isSearchable);
  if (searchable.length === 0) return [];

  const byId = new Map(searchable.map((record) => [record.id, record]));
  const docs = searchable.map((record) => ({ id: record.id, text: indexText(record) }));

  const ranked = bm25Rank(docs, query, { topK }).filter((hit) => hit.score >= minScore);

  const selected = [];
  let used = 0;
  for (const hit of ranked) {
    const record = byId.get(hit.id);
    if (!record) continue;
    const cost = priceString(`${record.title ?? ""}: ${record.body ?? ""}`);
    if (selected.length > 0 && used + cost > budget) break;
    if (selected.length === 0 && cost > budget) break;
    selected.push(record);
    used += cost;
  }
  return selected;
}

/**
 * The whole recall pipeline behind one call: filter → rank → trim → expand → render.
 *
 * One entry point so the pre-step hook and the `memory_recall` tool cannot drift: the
 * block the model sees automatically is produced by exactly the same code an explicit
 * tool call would run.
 *
 * `maxExtra: 0` disables expansion. Expansion runs *after* the budget trim so a large
 * family cannot push the seed set out of budget; the expanded records get whatever
 * room is left and are capped by `maxExtra` (default 2).
 *
 * @param {object[]} records - LTM records.
 * @param {string} query - free text.
 * @param {object} [options] - gating.
 * @param {boolean} [options.enabled] - when false, recalls nothing (config switch).
 * @param {number} [options.topK] - candidates to rank.
 * @param {number} [options.minScore] - BM25 score floor.
 * @param {number} [options.budget] - token ceiling.
 * @param {number} [options.maxExtra] - family-expansion limit; 0 disables.
 * @returns {{hits: object[], expanded: object[], block: string}} result.
 */
export function recall(records, query, options = {}) {
  const empty = { hits: [], expanded: [], block: "" };
  if (options.enabled === false) return empty;

  const hits = selectRecall(records, query, {
    topK: options.topK,
    minScore: options.minScore,
    budget: options.budget,
  });
  if (hits.length === 0) return empty;

  const maxExtra = Number.isFinite(options.maxExtra) ? options.maxExtra : 2;
  const extraIds = expandRecall(records, hits.map((record) => record.id), { maxExtra });
  const byId = new Map(records.filter(isSearchable).map((record) => [record.id, record]));
  const expanded = extraIds.map((id) => byId.get(id)).filter(Boolean);

  return { hits, expanded, block: renderRecallBlock([...hits, ...expanded]) };
}
