/**
 * v8-b work-name refinement: the model-facing half of turning temporary, per-session
 * work keys into human-meaningful, shared work names.
 *
 * Why this is a separate, pure module: the naming pass runs out-of-band (see
 * index.js `refineWorkNames`), but the instruction text and the parser are the parts
 * that must be deterministic and testable offline. `distillWithLlm` already shows the
 * pattern — build an instruction, call the model, parse+validate the answer. Here we do
 * the same for a much smaller question: "given these groups of records, what short work
 * name does each belong to, and which groups are actually the same work?"
 *
 * The contract the model must satisfy:
 *   - output a JSON array of {work, name} — one entry per input work key;
 *   - `work` echoes the input key verbatim (so we can map back unambiguously);
 *   - `name` is a short (<= 12 char) human-readable work name;
 *   - two different input keys that belong to the SAME work MUST get the SAME `name` —
 *     that is the merge signal (we do not invent a separate "merge" verb).
 *
 * Failure is safe: an unparseable / partial answer simply refines fewer groups. Missing
 * keys keep their temporary work key. It never throws on a bad row — it drops it.
 *
 * @module dsh-memory/work-name
 */

/** Max characters we keep from a refined work name (matches work.js's normaliser). */
const MAX_WORK_NAME_CHARS = 24;

/**
 * Render the representative text of one temporary work group for the model.
 * Bounded so a group of long records does not blow the prompt.
 *
 * @param {{key: string, samples: {title?: string, body?: string}[]}} group - work group.
 * @param {number} [maxChars] - per-group character budget.
 * @returns {string} a labelled block.
 */
export function renderWorkGroup(group, maxChars = 600) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 600;
  const lines = [`### ${group?.key ?? ""}`];
  for (const s of group?.samples ?? []) {
    const t = String(s?.title ?? "").trim();
    const b = String(s?.body ?? "").trim();
    const line = b === "" ? t : `${t}：${b}`;
    if (line !== "") lines.push(`- ${line}`);
    if (lines.join("\n").length >= budget) break;
  }
  const text = lines.join("\n");
  return text.length <= budget ? text : text.slice(0, budget);
}

/**
 * Build the instruction appended after the rendered work groups.
 *
 * @param {{keys: string[], mode?: 'conservative'|'balanced'}} input - keys + merge tightness.
 * @returns {string} instruction text.
 */
export function buildWorkNamingInstruction(input) {
  const keys = Array.isArray(input?.keys) ? input.keys : [];
  const mode = input?.mode === "balanced" ? "balanced" : "conservative";
  const mergeRules =
    mode === "conservative"
      ? [
          "- **宁可不合，也别错合**：只有两组是**同一个项目 / 同一个任务的连续步骤 / 同一目标的不同阶段**，",
          "  且你有把握时，才给相同 name。任何不确定都保持分开。",
          "- 『领域相同』『都涉及某工具（如 Zotero/browser）』『主题相近』『都是闲聊/自检/统计类』**都不算**同一件事。",
        ]
      : [
          "- 如果两组其实是**同一件事**（同一项目 / 同一任务的连续步骤 / 同一目标的不同会话），请给相同 name。",
          "- 只是『领域相同』『都涉及某工具』『主题相近』不算同一件事，须给不同 name。",
        ];
  return [
    "下面是若干组会话记忆，每组用一个临时键（形如 work:session-xxx）标识。",
    "请为每组提炼一个**简短的中文工作名**（不超过 12 字），用来概括这组记忆讲的是哪一件事。",
    "",
    "规则：",
    "- **先横向比较所有组**，再决定 name。",
    ...mergeRules,
    "- name 要具体，能概括工作主题；不要用『会话』『记忆』『内容』这类空词。",
    "- 保留专有名词（如 LTM、promote、Zotero、ACS、Adv. Mater.、DOI）。",
    "",
    "输入共有这些键：" + keys.join(", "),
    "",
    '只输出一个 JSON 数组，每条形如：{"work": "<原样照抄输入键>", "name": "<短工作名>"}',
    "必须为上面每一个键都输出一条。不要输出解释，只输出 ```json 代码块。",
  ].join("\n");
}

/**
 * Parse the model's naming answer into a Map<workKey, name>.
 *
 * Tolerant: accepts a fenced block or a bare array; skips rows that are not objects,
 * lack a `work` that matches a known key, or produce an empty name. Never throws on a
 * bad row — a partial answer refines fewer groups, which is safe.
 *
 * @param {string} text - raw model output.
 * @param {string[]} knownKeys - the input keys we will accept answers for.
 * @returns {Map<string, string>} workKey → normalised name (only keys we know).
 */
export function parseWorkNames(text, knownKeys) {
  const known = new Set(Array.isArray(knownKeys) ? knownKeys : []);
  const mapping = new Map();
  if (typeof text !== "string" || text.trim() === "") return mapping;

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  let candidate = (fenced ? fenced[1] : text).trim();
  if (candidate === "") return mapping;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Fall back to the outermost [...] so one stray sentence does not sink the answer.
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start < 0 || end <= start) return mapping;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return mapping;
    }
  }
  if (!Array.isArray(parsed)) return mapping;

  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const work = typeof row.work === "string" ? row.work.trim() : "";
    if (!known.has(work)) continue; // only answer for keys we asked about
    const name = normaliseName(row.name);
    if (name === "") continue;
    // First answer for a key wins; a duplicate row cannot flip it (deterministic).
    if (!mapping.has(work)) mapping.set(work, name);
  }
  return mapping;
}

/**
 * Normalise a proposed work name: trim, collapse whitespace, fold nothing else (Chinese
 * names keep their case irrelevance naturally), clip to the max length.
 * @param {unknown} raw - proposed name.
 * @returns {string} normalised name, or "".
 */
export function normaliseName(raw) {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return "";
  return s.slice(0, MAX_WORK_NAME_CHARS);
}

// --- v8-c-1: pivot real summary ---------------------------------------------
//
// v8-b named each work but left the pivot `body` as a mechanical join of member
// titles (see promote.applyWorkPivots). This pass asks the model for a genuine
// 1-2 sentence summary of the work from its members' titles+bodies. Pure text
// builders + a tolerant parser, matching the naming pass's contract style.

/** Max characters we keep for a pivot summary body. */
const MAX_SUMMARY_CHARS = 240;

/**
 * Build the instruction for summarising one work's members.
 * @param {{work?: string}} input
 * @returns {string}
 */
export function buildWorkSummaryInstruction(input) {
  const work = typeof input?.work === "string" ? input.work.replace(/^work:/, "") : "";
  return [
    `下面是「${work}」这项工作下的一组会话记忆（标题+正文摘录）。`,
    "请用**一两句中文**概括这项工作到底做了什么、结论是什么，作为这项工作的摘要。",
    "",
    "规则：",
    "- 只写事实性概括，不要『我认为』『需要』这类空话，不要复述过程独白。",
    "- 保留专有名词、具体结论、关键数字（如 DOI、参数、判断）。",
    "- 不超过 120 字。",
    "",
    "只输出摘要正文本身，不要 JSON、不要代码块、不要任何前缀。",
  ].join("\n");
}

/**
 * Render the members of one work for the summary prompt.
 * @param {{title?: string, body?: string}[]} members
 * @param {number} [maxChars]
 * @returns {string}
 */
export function renderWorkMembers(members, maxChars = 1200) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1200;
  const lines = [];
  for (const m of members ?? []) {
    const t = String(m?.title ?? "").trim();
    const b = String(m?.body ?? "").trim();
    const line = b === "" ? t : `${t}：${b}`;
    if (line !== "") lines.push(`- ${line}`);
    if (lines.join("\n").length >= budget) break;
  }
  const text = lines.join("\n");
  return text.length <= budget ? text : text.slice(0, budget);
}

/**
 * Clean a model-returned summary: strip code fences/labels, collapse whitespace,
 * clip to MAX_SUMMARY_CHARS. Returns "" when nothing usable.
 * @param {unknown} raw
 * @returns {string}
 */
export function parseWorkSummary(raw) {
  let s = String(raw ?? "");
  // drop a leading ```json / ``` and trailing fence if the model added one
  const fenced = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) s = fenced[1];
  s = s
    .replace(/^\s*(摘要|总结|summary)[:：]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return "";
  return s.slice(0, MAX_SUMMARY_CHARS);
}

// --- v8-c-2: merge-granularity (whole-store reorganisation) ------------------
//
// The automatic naming pass merges only *temporary* keys created within one refine
// window; but real stores accumulate already-named work that later turns out to be
// the same job split across sessions (ACS-search → save-to-Zotero, etc.). This pass
// looks at ALL live work names at once and asks the model which are actually the
// same work. Same answer as naming: two keys sharing one name = merge. Used by both
// the `memory_organize` tool and the LTM-page button. Pure builders; parse reuses
// parseWorkNames (identical {work,name} contract).

/**
 * Render one work for the merge prompt: its name + a few member samples so the model
 * can tell whether two similarly-named works are truly the same job.
 * @param {{work: string, samples: {title?: string, body?: string}[]}} group
 * @param {number} [maxChars]
 * @returns {string}
 */
export function renderWorkForMerge(group, maxChars = 400) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 400;
  const key = String(group?.work ?? "");
  const name = key.replace(/^work:/, "");
  const lines = [`### ${name}`, `（键：${key}）`];
  let used = lines.join("\n").length;
  for (const s of group?.samples ?? []) {
    const t = String(s?.title ?? "").trim();
    const b = String(s?.body ?? "").trim();
    const line = b === "" ? t : `${t}：${b}`;
    if (line === "") continue;
    if (used + line.length > budget) break;
    lines.push(`- ${line.slice(0, 120)}`);
    used += line.length;
  }
  return lines.join("\n");
}

/**
 * Build the instruction for the whole-store merge pass.
 * @param {{works: string[], mode?: 'conservative'|'balanced'}} input - keys + tightness.
 * @returns {string}
 */
export function buildWorkMergeInstruction(input) {
  const works = Array.isArray(input?.works) ? input.works : [];
  const mode = input?.mode === "balanced" ? "balanced" : "conservative";
  const mergeRules =
    mode === "conservative"
      ? [
          "- **宁可不合，也别错合**：只有当两组确实是**同一个项目 / 同一个任务的连续步骤 / 同一目标的不同阶段**，",
          "  且你有**把握**时，才给相同的 name。任何不确定、任何『像是相关』都保持分开。",
          "- 『领域相同』『都涉及某工具（如 Zotero/browser）』『主题相近』『都是闲聊/自检/统计/文献类』**都不算**同一件事。",
          "- 宁可多留几个独立组，也不要错并——错并比不并更糟。",
        ]
      : [
          "- 只有当两组确实是**同一个项目 / 同一个任务的连续步骤 / 同一目标的不同阶段**时，才给相同的 name。",
          "- 只是『领域相同』『都涉及某工具』『主题相近』**不算**同一件事，必须保持不同 name。",
        ];
  return [
    "下面是一份『长期记忆』里现有的全部工作分组。每组已经有一个工作名，但它们是不同会话",
    "各自命名的，可能是同一件被拆成了多组。请判断：**哪些工作其实指的是同一件事**，",
    "并把同一件事的组统一成同一个规范工作名。",
    "",
    "规则（很重要）：",
    ...mergeRules,
    "- 同一件事的组，name 用最能概括这件事的**一个**短名（不超过 12 字）。",
    "- 独立的组，name 尽量沿用/简化它原来的名字，别乱改。",
    "- 保留专有名词（如 LTM、Zotero、ACS、Adv. Mater.、DOI）。",
    "",
    "输入的工作键：" + works.join(", "),
    "",
    '只输出一个 JSON 数组，每条形如：{"work": "<原样照抄输入键>", "name": "<规范工作名>"}',
    "必须为上面每一个键都输出一条。不要输出解释，只输出 ```json 代码块。",
  ].join("\n");
}

// --- v10: split an over-merged work (the inverse of merge) -------------------
//
// Merge's blind spot: automatic naming and `optimizeWorkGranularity` can over-merge, and once
// two different jobs share one `work` key there is NO way to pull them apart — the merge
// answer is just "two keys → one name". Split is the inverse and reuses the same
// {work,name} vocabulary: we feed the model ONE work plus an enumerated list of its
// members, and ask it to partition the members into sub-groups, giving each sub-group a
// short name. Every member is referenced by its index (m0, m1, …) — a stable id the model
// can echo back that is independent of record ids (which are content hashes and meaningless
// to a model). A sub-group whose name equals the work's own name is the "keep" partition;
// any other name becomes a NEW work key. Partial / unparseable answers are safe: members
// the model did not place are left on the original work.

/**
 * Render one work for the split prompt: its name + every member enumerated `m<i>` with a
 * bounded excerpt, so the model can decide which members belong together.
 *
 * @param {{work: string, members: {title?: string, body?: string}[]}} group
 * @param {number} [maxChars] - total character budget for the member lines.
 * @returns {string}
 */
export function renderWorkForSplit(group, maxChars = 1600) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1600;
  const key = String(group?.work ?? "");
  const name = key.replace(/^work:/, "");
  const lines = [`### ${name}`, `（当前工作键：${key}）`];
  let used = lines.join("\n").length;
  const members = Array.isArray(group?.members) ? group.members : [];
  members.forEach((m, i) => {
    const t = String(m?.title ?? "").trim();
    const b = String(m?.body ?? "").trim();
    const line = b === "" ? t : `${t}：${b}`;
    if (line === "") return;
    const clipped = `- m${i}: ${line.slice(0, 160)}`;
    if (used + clipped.length > budget && i > 0) return; // keep at least the first
    lines.push(clipped);
    used += clipped.length;
  });
  return lines.join("\n");
}

/**
 * Build the instruction for splitting one work.
 *
 * @param {{work: string, memberCount: number, mode?: 'conservative'|'balanced'}} input
 * @returns {string}
 */
export function buildWorkSplitInstruction(input) {
  const work = typeof input?.work === "string" ? input.work.replace(/^work:/, "") : "";
  const count = Number.isFinite(input?.memberCount) ? input.memberCount : 0;
  const mode = input?.mode === "balanced" ? "balanced" : "conservative";
  const splitRules =
    mode === "conservative"
      ? [
          "- **宁可不拆，也别错拆**：只有当这些记忆里确实有**明显不同的几件事**（不同项目 / 不同目标 / 强行拼在一起）时才拆。",
          "- 如果它们其实就是同一件事的自然展开，**保持不拆**：给所有成员相同的 name（就等于原来那个工作名）。",
          "- 『都是同一个项目的不同步骤』不算该拆；『都是文献/工具/调试类』更不算该拆。",
        ]
      : [
          "- 如果这些记忆里包含**明显不同的几件事**，请拆开；同一件事的不同步骤不必拆。",
          "- 拆开后每个子组各给一个能概括它的短名。",
        ];
  return [
    `下面是一项工作「${work}」下的全部 ${count} 条记忆，每条用一个序号（m0、m1…）标识。`,
    "这项工作可能在之前的合并里**拼过头了**——把好几件不同的事硬塞进了一组。请判断：它们应该拆成几组？",
    "",
    "规则：",
    ...splitRules,
    "- 每个子组给一个**简短的中文工作名（不超过 12 字）**，要具体、能概括这组讲了什么。",
    "- 保持不拆的情况下，子组名就用原来的工作名「" + work + "」。",
    "- 保留专有名词（如 LTM、Zotero、ACS、DOI、参数名）。",
    "",
    '只输出一个 JSON 数组，每条形如：{"name": "<子组工作名>", "members": ["m0","m3"]}',
    "必须把上面每一个 m<序号> 都放到某一个组里，不重不漏。不要输出解释，只输出 ```json 代码块。",
  ].join("\n");
}

/**
 * Parse the model's split answer into an array of {name, memberIds:number[]} sub-groups.
 *
 * Tolerant: accepts fenced or bare JSON; drops unknown / duplicate member indices; ignores
 * empty names or groups. Members the model omitted are simply absent from every group (the
 * caller leaves them on the original work). Never throws.
 *
 * @param {string} text - raw model output.
 * @param {number} [memberCount] - when given, indices must be within [0, memberCount).
 * @returns {Array<{name: string, memberIds: number[]}>}
 */
export function parseWorkSplit(text, memberCount) {
  const out = [];
  if (typeof text !== "string" || text.trim() === "") return out;

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  let candidate = (fenced ? fenced[1] : text).trim();
  if (candidate === "") return out;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start < 0 || end <= start) return out;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return out;
    }
  }
  if (!Array.isArray(parsed)) return out;

  const limit = Number.isFinite(memberCount) ? memberCount : Infinity;
  const seen = new Set();
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const name = normaliseName(row.name);
    if (name === "") continue;
    const rawIds = Array.isArray(row.members) ? row.members : [];
    const ids = [];
    for (const raw of rawIds) {
      const idx = parseMemberIndex(raw);
      if (idx === null) continue;
      if (idx < 0 || idx >= limit) continue;
      if (seen.has(idx)) continue; // a member belongs to exactly one group
      seen.add(idx);
      ids.push(idx);
    }
    if (ids.length > 0) out.push({ name, memberIds: ids.sort((a, b) => a - b) });
  }
  return out;
}

/**
 * Accept "m3" / "M3" / 3 / "3" → 3. Returns null when not an index.
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseMemberIndex(raw) {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^m?(\d+)$/i);
  return m ? Number(m[1]) : null;
}

/**
 * Normalise an approved split plan into the canonical apply shape `{ name, memberIds }`.
 *
 * This is the single seam between "a plan surfaced to the user" and "a plan applyWorkSplit
 * consumes". It deliberately accepts BOTH `memberIds` (what parseWorkSplit / dryRun emit and
 * what applyWorkSplit consumes) and `members` (a hand-written plan), because a mismatch here
 * was a real bug: index.js used to read only `members`, so every confirmed split — whose plan
 * carried `memberIds` — was filtered to nothing and failed with "no valid partition to apply".
 *
 * Rows with an empty name or no in-range indices are dropped. Member order is preserved and
 * de-duplicated across groups (a member belongs to exactly one sub-work).
 *
 * @param {unknown[]} plan
 * @param {number} memberCount
 * @returns {{name:string, memberIds:number[]}[]}
 */
export function normalizeSplitPlan(plan, memberCount) {
  const out = [];
  if (!Array.isArray(plan)) return out;
  const limit = Number.isFinite(memberCount) ? memberCount : Infinity;
  const seen = new Set();
  for (const row of plan) {
    if (row === null || typeof row !== "object") continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name === "") continue;
    const src = Array.isArray(row.memberIds)
      ? row.memberIds
      : Array.isArray(row.members)
        ? row.members
        : [];
    const ids = [];
    for (const n of src) {
      if (!Number.isInteger(n) || n < 0 || n >= limit) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      ids.push(n);
    }
    if (ids.length > 0) out.push({ name, memberIds: ids });
  }
  return out;
}

/**
 * Heuristic: is a group of member titles "likely a single topic"?
 *
 * Purpose: the ✂️ split button should not invite splitting a group whose members
 * are all about the same thing (e.g. 3 records of "你好 / 在吗 / 你好呀"). Splitting
 * such a group only manufactures fragments — historically that exact scenario also
 * produced the orphan-pivot bug. We cannot run an LLM before the click, so we use a
 * cheap, deterministic character-bigram Jaccard similarity: if the *average* pairwise
 * similarity is high, members share a lot of surface form ⇒ treat as single-topic.
 *
 * CJK-friendly: works on characters, so no word segmentation is needed. Pure and
 * side-effect free so it is unit-testable.
 *
 * @param {string[]} titles
 * @param {{threshold?:number, minMembers?:number}} [opts]
 * @returns {{ singleTopic:boolean, score:number, pairs:number }}
 *   score = mean pairwise Jaccard (0..1); singleTopic = score >= threshold.
 */
export function isLikelySingleTopic(titles, opts = {}) {
  const threshold = typeof opts.threshold === "number" ? opts.threshold : 0.5;
  const minMembers = typeof opts.minMembers === "number" ? opts.minMembers : 2;
  const list = Array.isArray(titles) ? titles.map((t) => String(t ?? "")) : [];
  if (list.length < minMembers) return { singleTopic: false, score: 0, pairs: 0 };

  const bigrams = (s) => {
    const norm = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const set = new Set();
    if (norm.length < 2) {
      if (norm.length === 1) set.add(norm);
      return set;
    }
    for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2));
    return set;
  };
  const sets = list.map(bigrams);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const uni = a.size + b.size - inter;
      sum += uni === 0 ? 0 : inter / uni;
      pairs++;
    }
  }
  const score = pairs === 0 ? 0 : sum / pairs;
  return { singleTopic: score >= threshold, score: Number(score.toFixed(3)), pairs };
}

export default buildWorkNamingInstruction;
