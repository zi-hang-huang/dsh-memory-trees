/**
 * `memory_recall` tool definition — plain object, no host imports.
 *
 * Why this is not inline in `index.js`: `index.js` imports `@deepseek-ai/schemastery`
 * and `@deepseek-ai/dsh-tools`, and neither resolves from the dev workspace, so no
 * test can import `index.js` at all. Every "1 entry did not activate" failure this
 * project hit in production (HANDOFF §9 item 7) lived in code no test could reach.
 *
 * Keeping the definition here means the part that decides *what the model may call and
 * what shape its answer takes* is testable with plain objects. `index.js` keeps the
 * `defineTool` wrapper and the Context wiring.
 *
 * The output schema must be a raw JSON Schema with a per-property `required: true` —
 * that is the tool registry's own dialect. A schemastery type there fails the entire
 * plugin load, which surfaces only as "1 entry did not activate".
 */

import { recall as runRecall } from "./recall.js";

/** Recall budget and limits. Frozen so a caller cannot mutate shared config. */
export const RECALL_DEFAULTS = Object.freeze({
  /** Master switch. The pre-step hook and the tool both honour it. */
  recallEnabled: true,
  /** Token ceiling for the rendered block. plan D12: recall zone <= 1200 tok. */
  recallBudget: 1200,
  /** Candidates to rank before the budget trim. */
  recallTopK: 5,
  /** Family-expansion cap; 0 disables expansion. One hop only. */
  recallMaxExtra: 2,
});

/**
 * Build the `memory_recall` tool.
 *
 * `getRecords` is injected rather than imported so the tool does not need to know where
 * LTM lives. While v3 is unwired it returns `undefined`, and the tool answers "nothing
 * recalled" instead of throwing — a throwing tool makes the model explain an error it
 * cannot fix.
 *
 * @param {object} deps - collaborators.
 * @param {() => object[] | Promise<object[]>} deps.getRecords - LTM store accessor.
 * @param {object} [deps.config] - recall config (defaults to {@link RECALL_DEFAULTS}).
 * @returns {object} tool definition, ready for `defineTool`.
 */
export function createRecallTool(deps = {}) {
  const config = { ...RECALL_DEFAULTS, ...(deps.config ?? {}) };
  const getRecords = typeof deps.getRecords === "function" ? deps.getRecords : () => [];

  return {
    name: "memory_recall",
    description:
      "Search long-term memory for records relevant to a query. Returns the recalled records and the exact block that would be shown to the model. Long-term memory is empty until a session has been consolidated, so an empty result is normal.",
    // `parameters` is an IMPLICIT property map, not a JSON-Schema object: the registry
    // compiles it to `{type:"object", properties:…}` itself. Writing
    // `{type:"object", properties:{query:…}}` here makes the loader reject the whole
    // plugin with `parameters.type must be a value schema object` — verified against the
    // real `dsh-tools` in `_depstest` on 2026-11-03. `memory_stats` hid this because its
    // (empty) parameter map compiled to a valid empty object.
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "What to look for, in the user's own words.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          recalled: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                // `id` is returned for the caller's benefit (it is what
                // `/memory forget <id>` takes); the rendered block never contains it.
                id: { type: "string", required: true },
                title: { type: "string", required: true },
                score: { type: "number", required: true },
              },
            },
          },
          block: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value ?? {}, null, 2) }],
    },

    /**
     * @param {{query: string}} args - tool arguments.
     * @returns {Promise<{recalled: {id: string, title: string, score: number}[], block: string}>} result.
     */
    async execute(args) {
      const query = typeof args?.query === "string" ? args.query : "";
      const records = (await getRecords()) ?? [];
      if (records.length === 0) return { recalled: [], block: "" };

      const { hits, block } = runRecall(records, query, {
        enabled: config.recallEnabled,
        budget: config.recallBudget,
        topK: config.recallTopK,
        maxExtra: config.recallMaxExtra,
      });

      // `recalled` reports the seed hits only. The expanded records are in the block —
      // they are context the model benefits from, not search results it asked for, and
      // listing them separately would invite the model to cite a record that did not
      // match the query. Nothing else is returned: the output schema sets
      // `additionalProperties: false`, so an extra field is a runtime validation
      // failure, not a harmless detail.
      return {
        recalled: hits.map((record) => ({
          id: record.id,
          title: String(record.title ?? ""),
          score: Number(record.score ?? 0),
        })),
        block,
      };
    },
  };
}
