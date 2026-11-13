/**
 * `memory_fetch` tool definition — plain object, no host imports.
 *
 * Why separate from `index.js`: `index.js` imports `@deepseek-ai/schemastery` and
 * `@deepseek-ai/dsh-tools`, neither of which resolves from the dev workspace, so no test
 * can import it (same reason `recall-tool.js` exists). Keeping the schema and the paging
 * logic here makes them testable with plain objects.
 *
 * ## What this is for (HANDOFF §7.7)
 *
 * A folded tool result keeps only ~200 chars (or, for oversized results, a head+tail with
 * a `seq` pointer — §7.7 ⑤b). The full original is still in the append-only session log.
 * `memory_fetch(seq)` reads it back via `sessionQuery.readEvent(seq)`. Without it the
 * pointer the distiller writes is a dead end and the model can never reach the data it
 * was told about.
 *
 * ## Two hard constraints this design respects
 *
 * 1. **Paged, not truncating.** A 39,542-char event cannot be returned whole — that would
 *    blow the request window. `sliceEventText` returns a window `[offset, offset+limit)`
 *    plus a notice of what remains, so the model pages with `offset`. Limiting the *shown*
 *    size is not limiting the *stored* size; the log keeps everything.
 * 2. **The caller decides how it enters the request.** This tool returns ordinary tool
 *    output — a `tool/result` surface node. That node is itself foldable, so a *huge* fetch
 *    would be folded next step (the §7.7 death loop). The mitigation is the page cap
 *    (default well under a fold's retain budget) plus the caller wiring: it passes
 *    `exec.agent.session.id` and the fetched text is bounded, so no single fetch becomes a
 *    giant node. A future transient-injection variant is noted in §7.7 but not built here.
 */

/** Default page size, in characters. Well under the 12k-token retain budget. */
export const FETCH_DEFAULT_CHARS = 6000;

/** Hard ceiling on a single page, in characters, regardless of what the caller asks. */
export const FETCH_MAX_CHARS = 16000;

/**
 * Slice one event's text into a page.
 *
 * Pure and testable: takes the full text and an offset, returns the visible page, the
 * offset to continue from (or null when done), and a human-readable notice. The notice is
 * what the model reads to decide whether to page on — without it a page looks complete.
 *
 * @param {string} text - full event text.
 * @param {number} [offset] - start offset in characters (>= 0). Clamped to [0, length].
 * @param {number} [limit] - page size in characters. Clamped to [1, FETCH_MAX_CHARS].
 * @returns {{page: string, offset: number, nextOffset: number|null, total: number, notice: string}}
 *   the page and pagination state.
 */
export function sliceEventText(text, offset = 0, limit = FETCH_DEFAULT_CHARS) {
  const full = String(text ?? "");
  const total = full.length;
  const size = Number.isFinite(limit)
    ? Math.max(1, Math.min(FETCH_MAX_CHARS, Math.floor(limit)))
    : FETCH_DEFAULT_CHARS;
  const start = Number.isFinite(offset) ? Math.max(0, Math.min(total, Math.floor(offset))) : 0;
  const end = Math.min(total, start + size);
  const page = full.slice(start, end);
  const nextOffset = end < total ? end : null;

  let notice;
  if (total === 0) {
    notice = "该事件没有文本内容。";
  } else if (nextOffset === null) {
    notice =
      start === 0
        ? `完整原文 ${total} 字（已全部返回）。`
        : `完整原文 ${total} 字，已返回 [${start}, ${end})，这是结尾。`;
  } else {
    notice = `完整原文 ${total} 字，本次返回 [${start}, ${end})；还有 ${total - end} 字未返回，用 offset=${nextOffset} 继续。`;
  }
  return { page, offset: start, nextOffset, total, notice };
}

/**
 * Extract the readable text of a fetched session event.
 *
 * A `tool/result` event stores its payload under `data.message.content[].text`; a
 * `user/message` under `data.content[].text`. Both shapes are handled. Reasoning and
 * tool-call blocks are dropped (not replayable / not text).
 *
 * @param {object} event - a session event from `readEvent`.
 * @returns {string} concatenated text blocks.
 */
export function eventText(event) {
  const content =
    event?.data?.message?.content ??
    event?.data?.content ??
    [];
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

/**
 * Build the `memory_fetch` tool definition.
 *
 * `readEvent` is injected (async `(sessionId, seq) => event | null`) so the tool does not
 * need the service and is testable with a stub. The caller (index.js) wires it to
 * `ctx.get("sessionQuery", false)?.readEvent`.
 *
 * @param {object} deps - collaborators.
 * @param {(sessionId: string, seq: number) => Promise<object|null>} deps.readEvent
 *   resolves a session event by seq, or null when unavailable.
 * @param {object} [deps.config] - `{ maxChars }` overrides.
 * @returns {object} tool definition, ready for `defineTool`.
 */
export function createFetchTool(deps = {}) {
  const readEvent = typeof deps.readEvent === "function" ? deps.readEvent : async () => null;
  const maxChars = Number.isFinite(deps.config?.maxChars) ? deps.config.maxChars : FETCH_DEFAULT_CHARS;

  return {
    name: "memory_fetch",
    description:
      "Fetch the full text of a session event by its seq (the pointer a folded tool result carries, e.g. 'seq=617'). Returns a page of the original — use offset to page through a large event. Use this when a memory block or a tool-result excerpt says the full text is available at a seq.",
    // `parameters` is an IMPLICIT property map, not a JSON-Schema object — the registry
    // compiles it to `{type:"object", properties:…}` itself. See recall-tool.js for the
    // failure this avoids ("parameters.type must be a value schema object").
    parameters: {
      seq: {
        type: "integer",
        required: true,
        description: "The event seq to fetch (from a folded-excerpt pointer).",
      },
      sessionId: {
        type: "string",
        // Optional: omit `required` entirely (see the note below — writing
        // `required: false` fails the whole plugin load).
        //
        // Why this exists: `seq` is scoped to ONE session. A pointer remembered in
        // LTM, or a memory block from a past conversation, carries a seq that belongs
        // to the session that produced it — replaying it against the current session
        // would either miss or, worse, land on an unrelated event with the same seq.
        // The default stays "this session" so every existing pointer keeps working.
        description:
          "Fetch from this session id instead of the current one. Use it when the seq came from an older session (LTM provenance `sources[].sessionId`).",
      },
      offset: {
        type: "integer",
        // NOTE: do NOT write `required: false` here. This build's tool-registry schema
        // dialect (`dsh-tools` `compilePropertyMap`) rejects it with
        // `JsonSchemaError: parameters.offset.required must be true when present` — a
        // preset `required` key must be literally `true`; optional means *omit the key*.
        // Getting this wrong fails the WHOLE plugin load ("entries did not activate"),
        // taking memory_stats/memory_recall down with it — verified live 2026-11-06.
        description: "Character offset to start from. Omit for the first page.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          seq: { type: "integer", required: true },
          text: { type: "string", required: true },
          total: { type: "integer", required: true },
          // `nextOffset` is ALWAYS an integer in the returned value: the offset to
          // continue from, or -1 when there is no more. It is never null.
          //
          // Why: the output validator (`tool returned invalid output`) is stricter than
          // the parameter compiler — it rejected `"{value.nextOffset} must be an integer"`
          // for a page that had no next offset (verified live 2026-11-06). An optional
          // integer field cannot carry null here, so a sentinel is used instead. `required`
          // is present and true because the value is always emitted.
          nextOffset: { type: "integer", required: true },
          notice: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value ?? {}, null, 2) }],
    },

    /**
     * @param {{seq: number, offset?: number}} args - tool arguments.
     * @param {object} [exec] - tool exec context; `exec.agent.session.id` is the session.
     * @returns {Promise<object>} the page.
     */
    async execute(args, exec) {
      const seq = Number(args?.seq);
      if (!Number.isInteger(seq) || seq < 0) {
        return { seq: 0, text: "", total: 0, nextOffset: -1, notice: `无效的 seq：${args?.seq}` };
      }
      // Precedence: an explicit `args.sessionId` (a pointer from an older session)
      // wins over the executing session. Empty/whitespace falls back, so a caller
      // that stitches `{sessionId: provenance.sessionId}` with an absent field keeps
      // working against the current session rather than failing.
      const requested = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      const currentId = exec?.agent?.session?.id;
      const sessionId = requested !== "" ? requested : currentId;
      if (typeof sessionId !== "string" || sessionId === "") {
        return { seq, text: "", total: 0, nextOffset: -1, notice: "取回不可用：当前会话不可访问。" };
      }
      let event = null;
      try {
        event = await readEvent(sessionId, seq);
      } catch (error) {
        return { seq, text: "", total: 0, nextOffset: -1, notice: `取回失败：${error?.message ?? error}` };
      }
      if (!event) {
        return { seq, text: "", total: 0, nextOffset: -1, notice: `会话里没有 seq=${seq} 的事件。` };
      }
      const text = eventText(event);
      const { page, total, nextOffset, notice } = sliceEventText(text, args?.offset, maxChars);
      // `sliceEventText` uses null for "no more pages" (natural for a pure function);
      // the tool output must be an integer, so null becomes -1 at this boundary.
      return { seq, text: page, total, nextOffset: nextOffset === null ? -1 : nextOffset, notice };
    },
  };
}
