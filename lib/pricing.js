/**
 * Token pricing, calibrated against this machine's real provider reports.
 *
 * The stock DSH heuristic (`dsh-token-meter`) charges `ceil(chars / 4)` per text
 * block and ignores script density. v0 (`dsh-memory-v0/calibrate.mjs`) recovered
 * real prompt-token counts from provider `CONTEXT_WINDOW_EXCEEDED` messages and
 * fitted two parameters by least squares over 5 trusted samples:
 *
 *   CJK      0.7063 tok/char   (stock: 0.25 -> under-priced 2.83x)
 *   non-CJK  0.3629 tok/char   (stock: 0.25 -> under-priced 1.45x)
 *   R2 = 0.9999
 *
 * Honest caveat, carried from v0: the fit rests on 2 independent content points
 * (808k and 959k tokens), so the two-parameter split is under-determined. Treat
 * absolute values as +/- 20%. `SCALE` is the pooled ratio and is the safer
 * headline number.
 *
 * This file must stay dependency-free: the fold planner runs inside the host
 * process and must not pull anything the session layer does not already have.
 */

/** Pooled estimate/actual ratio from v0: real prompt is ~1.5x the stock count. */
export const SCALE = 1.5;

/** Per-character token density by script class. */
export const DENSITY = Object.freeze({ cjk: 0.7063, nonCjk: 0.3629 });

/** Fixed per-block overhead, matching the stock heuristic's shape. */
export const BLOCK_OVERHEAD = 4;

/** Fixed per-message overhead, matching the stock heuristic's shape. */
export const ROLE_OVERHEAD = 4;

const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

/**
 * Price a string by counting CJK and non-CJK characters separately.
 * @param {string} text - the text to price.
 * @returns {number} token estimate.
 */
export function priceText(text) {
  let cjk = 0;
  let nonCjk = 0;
  for (const char of String(text ?? "")) {
    if (CJK.test(char)) cjk += 1;
    else nonCjk += 1;
  }
  return cjk * DENSITY.cjk + nonCjk * DENSITY.nonCjk;
}

/**
 * Price one content block.
 * @param {{type: string, text?: string}} block - a model content block.
 * @returns {number} token estimate.
 */
export function priceBlock(block) {
  if (block === null || typeof block !== "object") return BLOCK_OVERHEAD;
  if (block.type === "text") return priceText(block.text) + BLOCK_OVERHEAD;
  // Non-text blocks (tool calls, thinking, images) are charged a flat overhead.
  // Their payload lives in a separate channel and never dominates the budget we
  // are trying to control; charging them exactly would require the provider's
  // own tokenizer for a payload we do not send verbatim.
  return BLOCK_OVERHEAD;
}

/**
 * Price a message's content array.
 * @param {object[]} blocks - content blocks.
 * @returns {number} token estimate.
 */
export function priceContent(blocks) {
  let total = 0;
  for (const block of blocks ?? []) total += priceBlock(block);
  return total;
}

/**
 * Price a whole message, including role overhead.
 * @param {{content?: object[]}} message - a model message.
 * @returns {number} token estimate.
 */
export function priceMessage(message) {
  return priceContent(message?.content) + ROLE_OVERHEAD;
}

/**
 * Price a bare string as if it were one text block in one message.
 * @param {string} text - the text.
 * @returns {number} token estimate.
 */
export function priceString(text) {
  return priceText(text) + BLOCK_OVERHEAD + ROLE_OVERHEAD;
}
