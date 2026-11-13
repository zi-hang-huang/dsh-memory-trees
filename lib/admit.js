/**
 * Admission: which messages are allowed to become memory, and which must never
 * be folded away.
 *
 * Two separate questions live here because they are answered by two different
 * facts and conflating them produces the two worst failure modes of this design:
 *
 *   1. `isMemorySource` — may this message become a memory node?
 *      v0 found 98.6% of `user/message` tokens are framework or plugin
 *      injections, not the human. Admitting by `role === "user"` pins a 25k-char
 *      skill catalog into memory every turn. The rule is an explicit allowlist
 *      and unknown kinds are dropped.
 *
 *   2. `isBarrierSource` — must this message survive a fold untouched?
 *      The criterion is not a literal `source.kind`; it is behavioural: does the
 *      injector decide what to re-publish by reading `session.surface.nodes`?
 *      `dsh-tool-skill` does (`lib/index.js:1059-1076`: `const visible = new
 *      Set(agent.session.surface.nodes)` then `if (visible.has(event.seq))
 *      return ...`), and so does `dsh-agent-instructions` (`lib/index.js:1348`
 *      `agent.session.surface.nodes.some(...)`). Folding such a node makes the
 *      injector believe nothing was published and it re-sends the full payload
 *      next step — harmless but pure waste, plus an extra replace event.
 *
 * `memory:self` is a barrier by construction: it is authored by this plugin and
 * looked up by `source.kind` over the surface, so a fold that hides it would
 * silently erase the persona for that turn.
 */

/** Source kinds admitted as memory material. Everything else is dropped. */
export const MEMORY_SOURCE_KINDS = Object.freeze(["user", "agent-message", "goal"]);

/**
 * Default fold barriers. See the module comment for why these three.
 * `skill-catalog` and `agent-instructions` are surface-aware injectors;
 * `memory:self` is this plugin's own surface-aware message.
 */
export const DEFAULT_BARRIER_KINDS = Object.freeze([
  "skill-catalog",
  "agent-instructions",
]);

/**
 * Build a predicate over `source.kind`.
 * @param {Iterable<string>} kinds - allowed kinds.
 * @returns {(message: object) => boolean} predicate.
 */
export function makeKindFilter(kinds) {
  const set = new Set(kinds);
  return (message) => set.has(message?.source?.kind);
}

/**
 * Is this message memory material?
 * @param {object} message - a model message.
 * @param {Set<string>} [admit] - override allowlist.
 * @returns {boolean} true when it may become a node.
 */
export function isMemorySource(message, admit) {
  const kinds = admit ?? new Set(MEMORY_SOURCE_KINDS);
  return kinds.has(message?.source?.kind);
}

/**
 * Must this message survive a fold untouched?
 * @param {object} message - a model message.
 * @param {Set<string>} [barriers] - override barrier set.
 * @returns {boolean} true when the fold must not cover it.
 */
export function isBarrierSource(message, barriers) {
  const kinds = barriers ?? new Set(DEFAULT_BARRIER_KINDS);
  return kinds.has(message?.source?.kind);
}

/**
 * Concatenate the text blocks of a message, dropping reasoning and tool calls.
 *
 * Reasoning blocks are excluded unconditionally, not because they are large but
 * because they cannot be replayed: `dsh-llm`'s adapters carry a `signature` per
 * thinking block and a replayed block whose text was rewritten fails signature
 * verification, forcing the provider onto a degraded path. Rewriting a reasoning
 * block to store it in memory is therefore never round-trippable, so the only
 * correct rule is to drop it.
 *
 * @param {{content?: object[]}} message - a model message.
 * @returns {string} concatenated text.
 */
export function textOf(message) {
  const parts = [];
  for (const block of message?.content ?? []) {
    if (block?.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * List the tool calls carried by an assistant message.
 * @param {{content?: object[]}} message - an assistant message.
 * @returns {Array<{id: string, name: string}>} tool calls in order.
 */
export function toolCallsOf(message) {
  return (message?.content ?? []).filter((block) => block?.type === "tool-call");
}
