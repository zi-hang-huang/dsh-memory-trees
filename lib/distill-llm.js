/**
 * v2 distillation: turn an LLM answer into validated memory nodes.
 *
 * v1 distils with rules only (`distill.js`): every message becomes a 120-char title
 * plus a 600-char excerpt, cut mid-sentence and mid-JSON. That is the loss the user
 * actually notices — a 2,000-char reply survives folding as its first 600 characters.
 * v2 replaces the cutter with a model call, which means the model can produce
 * *anything*, and everything downstream (the renderer, the budget pricer, the
 * orphan guard) assumes a well-formed node array.
 *
 * So this module is the boundary, and it is deliberately paranoid:
 *
 *   - the model never supplies ids — they are assigned here from the segment name,
 *     because an id collision silently overwrites a node in `mergeNodes`;
 *   - every node is parented to the segment anchor, so the tree stays one level deep
 *     and the orphan guard cannot be tripped by a model-invented edge;
 *   - title/body over the schema limit are truncated, not rejected: a slightly long
 *     body is still useful, and rejecting it would push the rejection rate that
 *     v2 is judged on (`< 5%`) up for cosmetic reasons;
 *   - everything else is rejected with a reason and counted, because "the model
 *     produced garbage" must be visible as a number, not as a thinner tree.
 *
 * Pure: no LLM, no session, no I/O. The caller owns the call and its fallback.
 */
import { MEMORY_SOURCE_KINDS } from "./admit.js";
import { ID_PATTERN, KINDS, MAX_BODY, MAX_NODES_PER_TURN, MAX_TITLE } from "./tree.js";
import { priceText } from "./pricing.js";

/** Kinds a model may emit. `task` is the human's own words — the model must not invent those. */
export const MODEL_KINDS = Object.freeze(["decision", "episode"]);

/** Default `llmMinSpan`: below this a fold is cheaper and safer done by rules. */
export const DEFAULT_MIN_SPAN = 4000;

/** Default node ceiling per LLM fold. */
export const DEFAULT_MAX_NODES = 8;

/** Default wall-clock ceiling for one distillation call. */
export const DEFAULT_TIMEOUT_MS = 20000;

/** Default input ceiling: a fold bigger than this is summarised head+tail. */
export const DEFAULT_MAX_INPUT = 12000;

/**
 * Does this fold qualify for a model call?
 *
 * Folding happens in `agent/pre-step`, so it fires on the order of once per step —
 * a 40-turn session measured 410 folds. Sending every one of those to a model would
 * roughly double the request count, so the model only sees folds big enough to be
 * worth it. Below the threshold the rule distiller is both cheaper and adequate.
 *
 * @param {object} config - resolved plugin config.
 * @param {number} shadowedTokens - tokens this fold is about to shadow.
 * @returns {boolean} true when the LLM should be asked.
 */
export function shouldUseLlm(config, shadowedTokens) {
  if ((config?.distillPolicy ?? "rules") !== "llm") return false;
  const min = Number.isFinite(config?.llmMinSpan) ? config.llmMinSpan : DEFAULT_MIN_SPAN;
  return Number.isFinite(shadowedTokens) && shadowedTokens >= min;
}

/**
 * Render the folded material as one plain-text block.
 *
 * Self-contained on purpose: replaying the conversation prefix would let the provider
 * cache cover it, but it also means re-sending everything up to the fold point on
 * every qualifying fold. The material is already bounded by the fold range, so a
 * standalone request is both simpler and cheaper here.
 *
 * Bounded on purpose too: a fold can shadow tens of thousands of tokens, and sending
 * all of it back to a model costs more than the fold saves. Over budget, keep the
 * head and the tail (where the decisions are) and drop the middle, deterministically.
 *
 * @param {object} material - result of `materialForRange`.
 * @param {number} [maxTokens] - input budget; defaults to {@link DEFAULT_MAX_INPUT}.
 * @returns {string} the transcript text.
 */
export function renderMaterial(material, maxTokens = DEFAULT_MAX_INPUT, admit = MEMORY_SOURCE_KINDS) {
  const lines = [];
  const admitSet = admit instanceof Set ? admit : new Set(admit);
  const push = (label, list) => {
    for (const message of list ?? []) {
      // A `memory` checkpoint is already-distilled material and a `memory:self` tree is
      // not conversation; neither is fold material. The v1 rule distiller filters with
      // `isMemorySource`; v2's renderer did not, so every fold re-fed the previous fold's
      // `<memory>` block to the model and got a fresh restatement of it back. Because
      // node ids are segment-scoped (`s<startSeq>-...`) those restatements never merged
      // and the tree grew by duplicates: measured live, 24 folds in 33 minutes yielded 55
      // nodes with 38% duplicate titles. A source-less entry (hand-built test material, a
      // tool result) has no kind and is kept, so small-span pass-through is unchanged.
      const kind = message?.source?.kind;
      if (typeof kind === "string" && !admitSet.has(kind)) continue;
      const text = blockTextOf(message);
      if (text.trim().length > 0) lines.push(`### ${label}\n${text.trim()}`);
    }
  };
  push("user", material?.userMessages);
  push("assistant", material?.assistantMessages);
  push("tool", material?.toolResults);
  const full = lines.join("\n\n");

  const budget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_INPUT;
  const priced = priceText(full);
  if (priced <= budget) return full;

  // Scale the character budget by the measured density rather than assuming a ratio;
  // the same text is ~2x denser in CJK. Head-heavy split: the opening of a span
  // states the task, the tail carries the outcome.
  const keepChars = Math.max(200, Math.floor((full.length * budget) / Math.max(1, priced)));
  const head = Math.floor(keepChars * 0.6);
  const tail = keepChars - head;
  return [
    full.slice(0, head),
    `\n\n[中间省略 ${Math.max(0, full.length - keepChars)} 字符]\n\n`,
    tail > 0 ? full.slice(-tail) : "",
  ].join("");
}

/**
 * Extract the readable text of one material entry.
 *
 * Material holds two shapes. Conversation messages carry `content: ContentBlock[]`.
 * Tool results from `materialForRange` are `{name, ok, text, callId}` records with no
 * `content` at all — the renderer used to read only `.content`, so `### tool` sections
 * were always empty and the model never saw a tool result. Both shapes are handled here
 * so a tool block prints its real output (and a failure is labelled), not `[object]`.
 *
 * @param {object} entry - a message or a tool-result record.
 * @returns {string} text to put under the section header.
 */
function blockTextOf(entry) {
  if (Array.isArray(entry?.content)) {
    return entry.content
      .map((block) => (block?.type === "text" ? block.text : block?.type === "tool-call" ? `[tool ${block.name}]` : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof entry?.text === "string") {
    const label = `${entry.name ?? "tool"}${entry.ok === false ? " (failed)" : ""}`;
    return `[${label}] ${entry.text}`;
  }
  return "";
}

/**
 * Collect the text of an assistant stream.
 *
 * Handles both stream shapes: adapters that emit `text-delta` chunks (the common
 * case) and adapters that only close a block with the full text. Anything else is
 * ignored rather than guessed at.
 *
 * @param {AsyncIterable<object>} stream - chunk source.
 * @returns {Promise<string>} concatenated assistant text.
 */
export async function collectStreamText(stream) {
  let text = "";
  let closed = "";
  for await (const chunk of stream) {
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    else if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
      closed += chunk.block.text;
    }
  }
  return text.length > 0 ? text : closed;
}

/**
 * Ask the model to distil a fold range into memory nodes.
 *
 * Resolves to validated nodes. Throws on anything the caller cannot use — no text,
 * unparseable JSON, a provider error, an aborted signal — because the caller must
 * fall back to the rule distiller rather than ship a half-built tree.
 *
 * @param {object} input - call parameters.
 * @param {object} input.llm - `ctx.llm` service.
 * @param {object} input.agent - owning agent (for provider/model/session id).
 * @param {object} input.material - result of `materialForRange`.
 * @param {object} input.plan - fold plan.
 * @param {number} [input.turn] - material's turn.
 * @param {number} [input.maxNodes] - node ceiling.
 * @param {number} [input.maxInputTokens] - transcript input ceiling.
 * @param {AbortSignal} [input.signal] - step cancellation.
 * @param {number} [input.timeoutMs] - wall-clock ceiling.
 * @returns {Promise<{nodes: object[], rejected: object[], clipped: number}>} result.
 */
export async function distillWithLlm(input) {
  const { llm, agent, material, plan } = input;
  if (typeof llm?.stream !== "function") throw new Error("distill-llm: llm service unavailable");

  const session = agent?.session;
  const routed = session?.requestHeader?.()?.config ?? null;
  const provider = routed?.provider ?? agent?.options?.provider;
  const model = routed?.model ?? agent?.options?.model;
  if (typeof provider !== "string" || typeof model !== "string") {
    throw new Error("distill-llm: no routed provider/model to distil with");
  }

  const turn = Number.isFinite(input.turn) ? input.turn : 0;
  const maxNodes = Number.isFinite(input.maxNodes) ? input.maxNodes : DEFAULT_MAX_NODES;
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_TIMEOUT_MS;

  const transcript = renderMaterial(material, input.maxInputTokens);
  if (transcript.trim().length === 0) throw new Error("distill-llm: nothing to distil");

  const signal = withTimeout(input.signal, timeoutMs);
  const options = {
    provider,
    model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `${transcript}\n\n---\n\n${buildDistillInstruction({ turn, maxNodes })}` }],
      },
    ],
    // Distillation must not be able to act on the session: no tools, no tool history.
    toolHistory: [],
    maxTokens: 1200,
    // `purpose` is deliberately omitted. The service types it as
    // `'compaction' | 'session-title'`; inventing a third value would either be
    // rejected or silently mislabel the call in telemetry. The field is optional.
    ...(session?.id === undefined ? {} : { sessionId: session.id }),
    ...(signal === undefined ? {} : { signal }),
  };

  const raw = await collectStreamText(llm.stream(options));
  if (raw.trim().length === 0) throw new Error("distill-llm: empty model output");
  const patch = parsePatch(raw);
  return validatePatch(patch, { segment: `s${plan.startSeq}`, turn, maxNodes });
}

/**
 * Combine the caller's signal with a wall-clock ceiling.
 * @param {AbortSignal|undefined} signal - caller cancellation.
 * @param {number} timeoutMs - ceiling in ms.
 * @returns {AbortSignal|undefined} combined signal.
 */
function withTimeout(signal, timeoutMs) {
  const TimeoutCtor = typeof AbortSignal?.timeout === "function" ? AbortSignal : null;
  if (TimeoutCtor === null) return signal;
  const timer = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timer;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timer]) : signal;
}


/**
 * Instruction appended after the folded range.
 *
 * Kept short on purpose: the call reuses the conversation's own prefix (like
 * `compaction-basic` does) so the provider's warm cache covers the range; only this
 * tail is new. A long instruction would be paid on every fold.
 *
 * @param {object} input - call parameters.
 * @param {number} input.turn - turn the folded material belongs to.
 * @param {number} input.maxNodes - how many nodes the caller will accept.
 * @returns {string} the instruction text.
 */
export function buildDistillInstruction(input) {
  const turn = Number.isFinite(input?.turn) ? input.turn : 0;
  const maxNodes = Number.isFinite(input?.maxNodes) ? input.maxNodes : 8;
  return [
    "你是会话记忆的蒸馏器。上面这段对话即将被丢弃，只留下你写下的条目。",
    "",
    "输出一个 JSON 数组，最多 " + maxNodes + " 条，每条形如：",
    '  {"kind": "decision" | "episode", "title": "<= 40 字", "body": "<= 600 字", "weight": 0.3..1}',
    "",
    "规则：",
    "- 只写这段对话里**已经发生**的事实：结论、决定、未完成的动作、失败原因。",
    "- 带「工具输出」的段落是工具真实返回的内容：把**它得到了什么**写成一条 decision（关键结果、数值、路径、错误原因），不要只写「调用了某工具」。",
    "- 不要写过程叙述（“我先看了…”），不要复述原文，不要写建议。",
    "- 用户原话不用你抄，系统会单独保留；你只负责归纳。",
    "- 有具体数值、路径、参数名、错误码时，原样保留，不要改写。",
    "- 没有值得留的东西就输出 []。",
    "",
    "不要输出解释、不要用 markdown 围栏以外的任何内容。只输出一个 ```json 代码块。",
    `（这段材料属于第 ${turn} 轮。）`,
  ].join("\n");
}

/**
 * Pull the node array out of an LLM answer.
 *
 * Accepts a fenced ```json block, a bare fenced block, or a bare array — models
 * produce all three and rejecting the wrong wrapper would be a self-inflicted
 * rejection. Anything else throws, and the caller falls back to rules.
 *
 * @param {string} text - raw model output.
 * @returns {object[]} the parsed array (not yet validated).
 */
export function parsePatch(text) {
  if (typeof text !== "string") throw new Error("distill-llm: model output is not a string");
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  if (candidate.length === 0) throw new Error("distill-llm: model output is empty");

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    // A model that emits a fenced array plus commentary would fail here; retry once
    // on the outermost [...] so one stray sentence does not cost the whole fold.
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error(`distill-llm: not JSON (${error.message})`);
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new Error(`distill-llm: not JSON (${error.message})`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error("distill-llm: patch must be a JSON array");
  return parsed;
}

/**
 * Cut a string to a length without splitting a surrogate pair.
 * @param {unknown} value - candidate text.
 * @param {number} limit - max code units.
 * @returns {string} clipped text.
 */
function clip(value, limit) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Validate and normalize a raw patch into nodes the renderer can accept.
 *
 * Normalisation, not policing: ids are assigned, parents are forced, long text is
 * clipped. What remains are genuine rejections — an unknown kind, a node with no
 * text at all, or more nodes than the caller asked for.
 *
 * @param {object[]} patch - parsed array from {@link parsePatch}.
 * @param {object} options - validation context.
 * @param {string} options.segment - anchor id, e.g. `s1234`.
 * @param {number} [options.turn] - turn stamped into `born`.
 * @param {number} [options.maxNodes] - accepted node ceiling.
 * @returns {{nodes: object[], rejected: {index: number, reason: string}[], clipped: number}} result.
 */
export function validatePatch(patch, options) {
  const segment = String(options?.segment ?? "");
  if (!ID_PATTERN.test(segment)) throw new Error(`distill-llm: bad segment name ${JSON.stringify(segment)}`);
  const turn = Number.isFinite(options?.turn) ? options.turn : 0;
  const maxNodes = Math.min(
    Number.isFinite(options?.maxNodes) ? options.maxNodes : MAX_NODES_PER_TURN,
    MAX_NODES_PER_TURN,
  );

  /** @type {object[]} */
  const nodes = [];
  /** @type {{index: number, reason: string}[]} */
  const rejected = [];
  let clipped = 0;

  for (let index = 0; index < patch.length; index += 1) {
    if (nodes.length >= maxNodes) {
      rejected.push({ index, reason: "over-max-nodes" });
      continue;
    }
    const raw = patch[index];
    if (raw === null || typeof raw !== "object") {
      rejected.push({ index, reason: "not-an-object" });
      continue;
    }
    const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
    if (!MODEL_KINDS.includes(kind) || !KINDS.includes(kind)) {
      rejected.push({ index, reason: `bad-kind:${kind || "missing"}` });
      continue;
    }
    const title = clip(typeof raw.title === "string" ? raw.title.trim() : "", MAX_TITLE);
    const body = clip(typeof raw.body === "string" ? raw.body.trim() : "", MAX_BODY);
    if (title.length === 0 && body.length === 0) {
      rejected.push({ index, reason: "empty" });
      continue;
    }
    if (
      (typeof raw.title === "string" && raw.title.length > MAX_TITLE) ||
      (typeof raw.body === "string" && raw.body.length > MAX_BODY)
    ) {
      clipped += 1;
    }
    const weight = Number.isFinite(raw.weight) ? Math.min(1, Math.max(0.1, raw.weight)) : kind === "decision" ? 0.6 : 0.4;

    nodes.push({
      // Ids are ours: a model-supplied id is either arbitrary or collides, and a
      // collision silently overwrites an existing node in `mergeNodes`.
      id: `${segment}-${kind}-m${index}`,
      zone: "volatile",
      kind,
      // One level under the anchor. A model-invented edge would let it create
      // orphans, which the renderer refuses (correctly).
      parentId: segment,
      order: kind === "decision" ? 100 + index : 200 + index,
      title,
      body,
      weight,
      pinned: false,
      rev: 1,
      born: turn,
      archived: false,
    });
  }

  return { nodes, rejected, clipped };
}
