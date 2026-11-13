/**
 * Rule-based distillation: turn messages into memory nodes without an LLM.
 *
 * Plan P3 locked v1 to rules only, so that v1 changes exactly one variable — the
 * context *structure* — and any behavioural regression is attributable to folding
 * rather than to a summarizer's output distribution. LLM distillation arrives in
 * v2 behind the same patch schema, so the node shapes produced here are the
 * contract v2 must also satisfy.
 *
 * Determinism is mandatory (see tree.js). Every id derives from the fold's start
 * seq and a per-kind ordinal, and every string is a pure function of the input.
 */

import { MAX_BODY, MAX_TITLE, MAX_NODES_PER_TURN } from "./tree.js";
import { isMemorySource, textOf, toolCallsOf } from "./admit.js";

/**
 * Per-node body budget for one tool call.
 *
 * Each tool call is now its OWN node (not one merged run), so this is the whole body
 * of that node, not a share of a shared one. 200 chars keeps a path, a key result or an
 * error message — which is what a reader needs — while making the node cheap. The
 * budget trimmer drops the lowest-weight tool nodes first, so a segment with sixty calls
 * still yields a bounded tree without any of them being silently crowded out by hand.
 */
const TOOL_EXCERPT = 200;

/**
 * Body budget for a failed tool call. A failure is what a reader must not lose, so it
 * gets a larger body than a success: enough for the full error message or stack head.
 */
const TOOL_FAILED_EXCERPT = 400;

/**
 * Character cost at or above which a tool result is "oversized" and gets the head+tail
 * treatment instead of a plain prefix excerpt.
 *
 * 200 chars of a 400-char result is fine; 200 chars of a 40,000-char JSON blob is not —
 * it keeps the header and throws away everything the model actually needs. Above this
 * threshold the body becomes "head … [omitted N; full text at seq S] … tail", so the
 * model sees both ends and knows exactly how to get the rest (`memory_fetch`).
 *
 * Chosen well above `TOOL_EXCERPT` so ordinary results are unchanged (no pointer noise).
 */
const TOOL_OVERSIZE_CHARS = 2000;

/**
 * Head/tail share of the body budget for an oversized result. 60/40: the head usually
 * carries the shape (keys, first rows, the command echo) and the tail carries the outcome
 * (final rows, the error, the closing brace) — the middle is the least informative part.
 */
const OVERSIZE_HEAD = 0.6;

/**
 * Body of one tool node: the tool's real output, excerpted.
 *
 * A blank success becomes its title (`run()`) — not `callId=…` noise and not an empty
 * string, which would render as a bare title. A failure shares the same body path but
 * with a larger budget, since the error message is the whole value of a failed call.
 *
 * **Oversized results (>= `TOOL_OVERSIZE_CHARS`) are head+tail, not a prefix.** A plain
 * prefix on a 39,542-char result keeps 126 chars of a JSON header and loses the data
 * (HANDOFF §5.15, session `bb7dc00b`). For these the body is the head and the tail joined
 * by a pointer carrying the event `seq`, which `memory_fetch(seq)` replays in full. The
 * pointer is written into the body text, not into the node schema, so the node stays a
 * plain `{title, body}` and the tree renderer is untouched.
 *
 * @param {{name?: string, ok?: boolean, text?: string, args?: string, seq?: number}} result
 *   one tool result; `seq` (when present) becomes the fetch pointer.
 * @returns {string} body, capped at `MAX_BODY`.
 */
export function toolBody(result) {
  const raw = String(result.text ?? "");
  const limit = result.ok === false ? TOOL_FAILED_EXCERPT : TOOL_EXCERPT;

  // Oversized path: head + pointer + tail, all within MAX_BODY so the node stays legal.
  if (raw.length >= TOOL_OVERSIZE_CHARS) {
    const hasSeq = Number.isFinite(result.seq);
    // Reserve room for the pointer sentence; split the rest 60/40 head/tail.
    const pointer = hasSeq
      ? `\n…[中间省略 ${raw.length} 字符，完整原文 seq=${result.seq}，可 memory_fetch(${result.seq}) 取回]…\n`
      : `\n…[中间省略 ${raw.length} 字符]…\n`;
    const room = Math.max(80, MAX_BODY - pointer.length - 8);
    const headLen = Math.floor(room * OVERSIZE_HEAD);
    const tailLen = room - headLen;
    const head = excerpt(raw, headLen);
    const tail = tailLen > 0 ? tailExcerpt(raw, tailLen) : "";
    // `excerpt`/`tailExcerpt` collapse whitespace, so the joined string stays single-ish
    // and its length is bounded by MAX_BODY; validateNode enforces the cap regardless.
    const body = `${head}${pointer}${tail}`;
    return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
  }

  const text = excerpt(raw, limit);
  if (text !== "") return text;
  return excerpt(toolTitle(result), MAX_BODY);
}

/**
 * Tail excerpt: the last `limit` chars, on a sentence boundary, whitespace-collapsed.
 *
 * Mirrors {@link excerpt} but from the end, so an oversized body can show how it ends
 * (a closing brace, the final error line) rather than only how it starts.
 *
 * @param {string} text - raw text.
 * @param {number} limit - max characters.
 * @returns {string} single-line tail excerpt.
 */
export function tailExcerpt(text, limit) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= limit) return flat;
  return flat.slice(flat.length - limit).trim();
}

/**
 * Collapse whitespace and cut at a sentence boundary.
 *
 * Cutting mid-sentence is avoided because a truncated statement reads as a
 * complete one: "the port is 8080 and the token is sk-" is worse than "the port
 * is 8080", since the first invites a confident wrong answer.
 *
 * @param {string} text - raw text.
 * @param {number} limit - max characters.
 * @returns {string} single-line excerpt.
 */
export function excerpt(text, limit) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = Math.max(
    cut.lastIndexOf("\u3002"),
    cut.lastIndexOf("\uFF01"),
    cut.lastIndexOf("\uFF1F"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf("; "),
    cut.lastIndexOf("\uFF1B"),
  );
  const body = stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut;
  return body.trim();
}

/**
 * @typedef {object} SegmentInput
 * @property {string} segment - anchor id for this distillation batch.
 * @property {number} turn - turn number the batch starts in.
 * @property {object[]} userMessages - `user/message` events' messages.
 * @property {object[]} assistantMessages - `assistant/message` events' messages.
 * @property {object[]} toolResults - `{name, ok, text, callId, args}` records.
 * @property {[number, number]} [seqRange] - event range this segment covers.
 */

/**
 * Build one segment's nodes.
 *
 * Anchoring is per segment, not per turn, because a fold boundary routinely lands
 * inside a turn: measured turns carry 21 messages at the median and 158 at P95, so
 * a token window almost never ends on a turn edge. A turn-anchored scheme would
 * have to either refuse that fold or drop the messages it could not summarise —
 * the first stalls, the second loses data silently. A segment anchor distils
 * exactly what is being removed; whatever survives in the tail stays verbatim.
 *
 * Node kinds are chosen so the budget trimmer can act on meaning:
 *   task      the human's own words — never trimmed, never paraphrased
 *   decision  assistant prose — trimmed after tool pointers
 *   episode   a tool call — trimmed first, cheapest information
 *
 * Tool calls become one `episode` node each (`read(file_path=X): 内容…`), carrying the
 * call arguments in the title and the real output in the body. Two rejected designs:
 * per-call pointers with only `callId=…` (measured: 63 of them were 66.6% of the tree's
 * tokens and a `callId` resolves to nothing here), and one merged run node (a single body
 * cannot say which output came from which call and cannot carry arguments). Per-node is
 * also how "which to drop" is decided: the trimmer removes lowest weight, and a failure
 * (0.8) outranks a success (0.4), so a segment of sixty calls yields a bounded tree with
 * failures kept, no hand-rolled budget split.
 *
 * @param {SegmentInput} input - segment material.
 * @returns {object[]} nodes, each parented to the segment anchor.
 */
export function distillTurn(input) {
  const { segment, turn, userMessages, assistantMessages, toolResults } = input;
  const nodes = [];

  // Provenance carried onto EVERY node: the event span this segment distilled.
  // A promoted record reads it back as `sources[].seqRange`, which is what lets
  // `memory_fetch(sessionId, seq)` walk from an LTM hit back to the original events.
  // Absent (older callers, hand-built test material) simply means "no span" — the
  // field is optional everywhere downstream.
  const span =
    Array.isArray(input.seqRange) && input.seqRange.length === 2
      ? { seqRange: [input.seqRange[0], input.seqRange[1]] }
      : {};

  const push = (node) => {
    if (nodes.length >= MAX_NODES_PER_TURN) return;
    nodes.push({ ...node, ...span });
  };

  let userIndex = 0;
  for (const message of userMessages ?? []) {
    if (!isMemorySource(message)) continue;
    const text = textOf(message);
    if (text.trim() === "") continue;
    push({
      id: `${segment}-task-${userIndex}`,
      zone: "volatile",
      kind: "task",
      parentId: segment,
      order: 10 + userIndex,
      title: excerpt(text, MAX_TITLE),
      body: excerpt(text, MAX_BODY),
      weight: 1,
      pinned: true,
      rev: 1,
      born: turn,
      archived: false,
    });
    userIndex += 1;
  }

  let sayIndex = 0;
  for (const message of assistantMessages ?? []) {
    const text = textOf(message);
    if (text.trim() === "") continue;
    push({
      id: `${segment}-decision-${sayIndex}`,
      zone: "volatile",
      kind: "decision",
      parentId: segment,
      order: 30 + sayIndex,
      title: excerpt(text, MAX_TITLE),
      body: excerpt(text, 300),
      weight: 0.6,
      pinned: false,
      rev: 1,
      born: turn,
      archived: false,
    });
    sayIndex += 1;
  }

  // One node PER tool call, not one merged run. Merging made a single 600-char body that
  // could not say which output came from which call, and could not carry the call
  // arguments; splitting lets each node read `read(file_path=HANDOFF.md): 内容…`, and
  // hands the "which to drop" decision to the budget trimmer's weight ordering instead
  // of a hand-rolled budget split. Failures get a higher weight so they survive trimming
  // first-in; the trimmer removes lowest weight (and `episode` before `decision`) first.
  let toolIndex = 0;
  for (const result of toolResults ?? []) {
    const failed = result.ok === false;
    push({
      id: `${segment}-tool-${toolIndex}`,
      zone: "volatile",
      kind: "episode",
      parentId: segment,
      order: 50 + toolIndex,
      title: toolTitle(result),
      body: toolBody(result),
      weight: failed ? 0.8 : 0.4,
      pinned: false,
      rev: 1,
      born: turn,
      archived: false,
    });
    toolIndex += 1;
  }

  if (nodes.length === 0) return [];
  nodes.sort((a, b) => a.order - b.order);
  return nodes;
}

/**
 * Title of one tool node: `name(args)`, or `name(args) FAILED`, then its real output.
 *
 * The arguments are the point of this node. A `read` whose body is a page of text is
 * useless without the path it read; a `bash` that printed nothing is useless without the
 * command. Both live in the title so the tree reads as "what was done", and the body
 * reads as "what came back".
 *
 * @param {{name?: string, ok?: boolean, args?: string}} result - one tool result.
 * @returns {string} title, capped at `MAX_TITLE`.
 */
export function toolTitle(result) {
  const name = result.name ?? "tool";
  const args = String(result.args ?? "").trim();
  const head = args === "" ? name : `${name}(${args})`;
  const label = result.ok === false ? `${head} FAILED` : head;
  return excerpt(label, MAX_TITLE);
}

/**
 * Build the anchor every distilled node hangs from.
 *
 * Without it every node is an orphan and the renderer throws (`tree.js`). That is
 * intentional: v0 shipped a version that produced orphan nodes and rendered an
 * empty zone without complaint, which read as "the memory is empty" rather than as
 * a bug.
 *
 * @param {string} segment - anchor id, unique per fold.
 * @param {number} turn - turn the segment starts in.
 * @param {number} order - sort order; the segment's first seq keeps them stable.
 * @param {number} messageCount - how many messages the segment covered.
 * @returns {object} the anchor node.
 */
export function segmentAnchor(segment, turn, order, messageCount) {
  return {
    id: segment,
    zone: "volatile",
    kind: "episode",
    parentId: null,
    order,
    title: `T${turn}`,
    body: `${messageCount} msg`,
    weight: 1,
    pinned: false,
    rev: 1,
    born: turn,
    archived: false,
  };
}

/**
 * Lift the tool calls an assistant message made, for provenance linking.
 * Kept separate from `distillTurn` so the plugin can record which call ids a
 * segment produced without re-walking the message.
 *
 * @param {object[]} assistantMessages - assistant messages of one segment.
 * @returns {Array<{id: string, name: string}>} call ids in order.
 */
export function callsOf(assistantMessages) {
  const calls = [];
  for (const message of assistantMessages ?? []) calls.push(...toolCallsOf(message));
  return calls;
}
