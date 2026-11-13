/**
 * Context detail: turn the current session's visible node list into a
 * per-message breakdown the memory panel can render (v10 "看得到当前窗口具体内容").
 *
 * Why a separate pure module:
 *   - The official `dsh-token-meter` projection only exposes three aggregates
 *     (system / tools / message). The per-message detail lives in the session
 *     event log, which the plugin already walks in `agent/pre-step`. So the host
 *     half snapshots a compact list of messages here and the panel fetches it
 *     over the existing 7788 view server (`GET /context.json`).
 *   - Keeping the reduction pure (no fs / no host objects) makes it unit-testable
 *     and lets the panel and the host share exactly one definition of "a row".
 *
 * A "row" is one visible message: { seq, role, kind, tokens, chars, toolNames,
 * preview }. Rows are grouped into four buckets the human cares about —
 * system / tools / assistant / user — matching the colour legend the panel
 * already draws for the token bar (system blue, tools amber, message green,
 * split into assistant vs user inside message).
 */

/** Rough token estimate: CJK chars count ~1, ascii ~1/4. Never throw on odd input. */
export function estimateTokens(text) {
  const s = typeof text === "string" ? text : "";
  let cjk = 0;
  let ascii = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk + ascii / 4);
}

/** Concatenate the plain-text blocks of a message (drops reasoning / tool-call). */
function textOfContent(content) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Tool-call names carried by an assistant message. */
function toolNamesOfContent(content) {
  const names = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block && block.type === "tool-call") names.push(String(block.name ?? block.toolName ?? "?"));
  }
  return names;
}

/**
 * Classify one message into a bucket. Precedence matters: a tool *result*
 * message is a `tool` role with a tool name and belongs to "tools" (it is the
 * payload that bloats the window), while an assistant message that merely
 * *carries* tool calls is still "assistant".
 */
function bucketOf(role, kind, isToolResult) {
  if (isToolResult) return "tools";
  if (kind === "skill-catalog" || kind === "agent-instructions") return "system";
  if (kind === "memory" || kind === "memory:self") return "system";
  if (role === "system") return "system";
  if (role === "tool") return "tools";
  if (role === "assistant") return "assistant";
  return "user";
}

/**
 * Build one row from a derived message.
 * @param {number} seq
 * @param {object} message - a derived model message ({role, source, content}).
 * @param {number} [fixedTokens] - wall-clock token count if the caller knows it.
 */
export function rowOf(seq, message, fixedTokens) {
  const role = String(message?.role ?? "?");
  const kind = String(message?.source?.kind ?? "");
  const content = message?.content;
  const text = textOfContent(content);
  const toolNames = toolNamesOfContent(content);
  const isToolResult = role === "tool";
  const chars = text.length;
  const tokens = Number.isFinite(fixedTokens) ? fixedTokens : estimateTokens(text);
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    seq,
    role,
    kind,
    bucket: bucketOf(role, kind, isToolResult),
    tokens,
    chars,
    toolNames,
    preview,
  };
}

const BUCKET_LABEL = Object.freeze({
  system: "系统 / 注入",
  tools: "工具结果",
  assistant: "助手回复",
  user: "用户消息",
});

/**
 * Reduce a list of rows into the panel view-model: four ordered buckets, each
 * with a count, token sum, and the rows themselves; plus a session-level total.
 *
 * @param {Array<object>} rows
 * @returns {{ buckets: Array<object>, totalTokens: number, totalRows: number }}
 */
export function summarizeRows(rows) {
  const buckets = ["system", "tools", "assistant", "user"].map((key) => ({
    key,
    label: BUCKET_LABEL[key],
    count: 0,
    tokens: 0,
    rows: [],
  }));
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  let totalTokens = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const bucket = byKey.get(row.bucket) ?? byKey.get("user");
    bucket.count += 1;
    bucket.tokens += row.tokens;
    bucket.rows.push(row);
    totalTokens += row.tokens;
  }
  return { buckets, totalTokens, totalRows: Array.isArray(rows) ? rows.length : 0 };
}

/**
 * Full build: derive rows from a session snapshot and summarize.
 * The host half calls this with a function that maps seq → derived message.
 *
 * @param {number[]} seqs - the session surface node seqs, in order.
 * @param {(seq:number) => object|null} derive - seq → derived message (or null to skip).
 * @param {(seq:number) => number|undefined} [tokensOf] - optional exact token count.
 * @returns {{ buckets: Array<object>, totalTokens: number, totalRows: number }}
 */
export function buildContextDetail(seqs, derive, tokensOf) {
  const rows = [];
  for (const seq of Array.isArray(seqs) ? seqs : []) {
    let message;
    try {
      message = derive(seq);
    } catch {
      continue;
    }
    if (!message) continue;
    rows.push(rowOf(seq, message, tokensOf ? tokensOf(seq) : undefined));
  }
  return summarizeRows(rows);
}
