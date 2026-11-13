/**
 * `memory_save` tool definition — plain object, no host imports.
 *
 * Why this exists: promote-to-LTM is *fold-driven* (`agent/pre-step` → after a fold →
 * `promoteIfNeeded`). A model that learns a durable fact mid-turn — a user preference, a
 * decided constraint, a verified number — has no way to record it until a fold happens to
 * fire and happen to keep that node. `memory_save` gives the model a direct, immediate
 * entry point: it writes one record straight into the LTM store with a caller-supplied
 * weight, no fold required. That is the "模型可以随时记下" path the promote-only design
 * lacked.
 *
 * Like `recall-tool.js`, the definition lives here so it is testable with plain objects;
 * `index.js` keeps the `defineTool` wrapper and the storage wiring. The output schema is a
 * raw JSON Schema with per-property `required: true` — the registry's own dialect, not
 * schemastery (a schemastery type here fails the whole plugin load as "1 entry did not
 * activate").
 */

import { ltmId } from "./promote.js";

/** Default weight for a model-initiated save: above the promote threshold (0.4) so it
 *  always qualifies for recall, but not pinned — a human can still let it age out. */
export const SAVE_DEFAULTS = Object.freeze({
  saveEnabled: true,
  /** Weight stamped on a saved record when the caller gives none. */
  saveWeight: 0.8,
  /** Max title chars kept (a long title wastes recall budget on every hit). */
  titleMaxChars: 200,
  /** Max body chars kept. */
  bodyMaxChars: 2000,
});

/**
 * Build the `memory_save` tool.
 *
 * @param {object} deps - collaborators.
 * @param {(record: object) => Promise<{written: number, errors: string[]}>} deps.saveRecord
 *   - writes one already-built LTM record; returns counts (never throws on a per-record
 *   error — the caller reports it as `ok:false`). Absent ⇒ the tool answers `ok:false`
 *   with `"LTM store unavailable"` instead of throwing.
 * @param {object} [deps.config] - save config (defaults to {@link SAVE_DEFAULTS}).
 * @param {() => string} [deps.sessionId] - current session id for provenance.
 * @param {() => number} [deps.turn] - current turn for provenance.
 * @param {() => number} [deps.now] - wall clock in ms (default `Date.now`).
 * @returns {object} tool definition, ready for `defineTool`.
 */
export function createSaveTool(deps = {}) {
  const config = { ...SAVE_DEFAULTS, ...(deps.config ?? {}) };
  const saveRecord = typeof deps.saveRecord === "function" ? deps.saveRecord : null;
  const sessionId = typeof deps.sessionId === "function" ? deps.sessionId : () => "unknown";
  const turn = typeof deps.turn === "function" ? deps.turn : () => undefined;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  return {
    name: "memory_save",
    description:
      "Save a durable fact to long-term memory immediately, without waiting for a fold. Use it when the user states a lasting preference, a decision, or a verified fact that should be recalled in later turns and later sessions. Provide a short title and the fact itself.",
    parameters: {
      title: {
        type: "string",
        required: true,
        description: "Short label for the fact (a few words).",
      },
      body: {
        type: "string",
        required: true,
        description: "The fact itself, self-contained so it makes sense without the current conversation.",
      },
      // Optional parameter: `required` MUST be omitted, never `required: false`. This
      // registry dialect rejects `required: false` with `parameters.weight.required must
      // be true when present`, which throws inside `defineTool` and aborts the WHOLE
      // plugin apply — every tool disappears (surfacing only as "1 entry did not
      // activate"). Verified against the real `dsh-tools` 2026-11-06.
      weight: {
        type: "number",
        description: "Importance 0..1; higher survives eviction longer. Defaults to the save weight.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          id: { type: "string", required: true },
          reason: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value ?? {}, null, 2) }],
    },

    /**
     * @param {{title: string, body: string, weight?: number}} args - tool arguments.
     * @returns {Promise<{ok: boolean, id: string, reason: string}>} result.
     */
    async execute(args) {
      const title = String(args?.title ?? "").trim();
      const body = String(args?.body ?? "").trim();
      if (title === "" || body === "") {
        return { ok: false, id: "", reason: "title and body are both required" };
      }
      if (!saveRecord) {
        return { ok: false, id: "", reason: "LTM store unavailable" };
      }

      const weight = Number.isFinite(args?.weight)
        ? Math.min(1, Math.max(0, args.weight))
        : config.saveWeight;
      const currentTurn = turn();
      const ts = now();

      // Build a node-shaped object so we can reuse `ltmId` for the stable content id (the
      // same id a fold-driven promote of identical text would produce — so a manual save
      // and a later automatic promote converge on ONE record, not two).
      const node = {
        kind: "decision",
        title: title.slice(0, config.titleMaxChars),
        body: body.slice(0, config.bodyMaxChars),
        weight,
        born: Number.isFinite(currentTurn) ? currentTurn : 0,
      };

      let id;
      try {
        id = ltmId(node);
      } catch (error) {
        return { ok: false, id: "", reason: `could not build record id: ${error?.message ?? error}` };
      }

      const record = {
        id,
        zone: "recall",
        kind: "decision",
        parentId: null,
        order: 0,
        title: node.title,
        body: node.body,
        weight,
        pinned: false,
        rev: 1,
        born: node.born,
        archived: false,
        firstSeenTurn: node.born,
        hits: 1,
        sources: [
          {
            sessionId: sessionId(),
            turn: Number.isFinite(currentTurn) ? currentTurn : 0,
            promotedAt: ts,
          },
        ],
        subject: null,
        supersedes: [],
        supersededAt: null,
        frozen: false,
      };

      try {
        const res = await saveRecord({ record, node, ts });
        if (res && Array.isArray(res.errors) && res.errors.length > 0) {
          return { ok: false, id, reason: res.errors[0] };
        }
        return { ok: true, id, reason: "saved" };
      } catch (error) {
        return { ok: false, id, reason: `save failed: ${error?.message ?? error}` };
      }
    },
  };
}

export default createSaveTool;
