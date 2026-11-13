/**
 * `memory_recall` tool contract.
 *
 * The tool is defined in its own module — not inline in `index.js` — for one blunt
 * reason: `index.js` imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`,
 * neither of which resolves from this dev workspace, so **nothing in `index.js` can be
 * imported by a test at all**. That is how all four "1 entry did not activate"
 * failures reached a real machine unnoticed (HANDOFF §9 item 7).
 *
 * Keeping the tool a plain object with no host imports makes the part that decides
 * *what the model can call* testable here. `index.js` keeps only the wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RECALL_DEFAULTS, createRecallTool } from "../lib/recall-tool.js";

const STORE = [
  { id: "c1", subject: "config.retain_tokens", title: "retainTokens 是 15000", body: "从 12000 调上来", weight: 0.8 },
  { id: "c2", subject: "config.variadic_budget", title: "volatileBudget 是 2500", body: "", weight: 0.5 },
];

test("RECALL_DEFAULTS are frozen and conservative", () => {
  assert.ok(Object.isFrozen(RECALL_DEFAULTS));
  assert.equal(RECALL_DEFAULTS.recallEnabled, true);
  assert.equal(RECALL_DEFAULTS.recallBudget, 1200, "plan D12: recall zone <= 1200 tok");
  assert.equal(RECALL_DEFAULTS.recallTopK, 5);
  assert.equal(RECALL_DEFAULTS.recallMaxExtra, 2, "one-hop expansion, capped");
});

test("the tool is named memory_recall and takes a required query", () => {
  const tool = createRecallTool({ getRecords: () => STORE, config: RECALL_DEFAULTS });
  assert.equal(tool.name, "memory_recall");
  // `parameters` is an implicit property map (the registry compiles it to a JSON
  // Schema). Writing a full `{type:"object", properties:…}` here is rejected by the
  // loader with `parameters.type must be a value schema object` — this assertion pins
  // the map shape so that regression cannot come back.
  assert.equal(tool.parameters.type, undefined, "parameters must be a property map, not a schema object");
  assert.equal(tool.parameters.query.type, "string");
  assert.equal(tool.parameters.query.required, true, "the registry uses per-property required");
});

test("the output schema uses the registry's own dialect, not schemastery", () => {
  // `output.schema` is a raw JSON Schema with per-property `required: true`. Passing a
  // schemastery type here fails the whole plugin load — the exact failure recorded in
  // HANDOFF §9 item 7.
  const tool = createRecallTool({ getRecords: () => STORE, config: RECALL_DEFAULTS });
  const schema = tool.output.schema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  for (const [key, value] of Object.entries(schema.properties)) {
    assert.equal(value.required, true, `property ${key} must be required`);
    assert.equal(typeof value.type, "string", `property ${key} must declare a type`);
  }
  assert.ok(schema.properties.recalled, "the model needs to see what was recalled");
  assert.ok(schema.properties.block, "and the rendered block");
});

test("execute returns the recalled records and the rendered block", async () => {
  const tool = createRecallTool({ getRecords: () => STORE, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "retainTokens" });

  assert.deepEqual(value.recalled, [
    { id: "c1", title: "retainTokens 是 15000", score: value.recalled[0].score },
  ]);
  assert.match(value.block, /zone="recall"/);
  assert.match(value.block, /retainTokens 是 15000/);
});

test("execute is silent when nothing matches", async () => {
  const tool = createRecallTool({ getRecords: () => STORE, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "量子色动力学" });
  assert.deepEqual(value.recalled, []);
  assert.equal(value.block, "");
});

test("execute honours recallEnabled=false", async () => {
  const tool = createRecallTool({
    getRecords: () => STORE,
    config: { ...RECALL_DEFAULTS, recallEnabled: false },
  });
  const value = await tool.execute({ query: "retainTokens" });
  assert.deepEqual(value.recalled, []);
  assert.equal(value.block, "");
});

test("execute tolerates a store that is not loaded yet", async () => {
  // v3 is not wired, so at runtime the provider returns nothing. The tool must answer
  // "nothing recalled" rather than throw — a throwing tool turns every call into an
  // error the model has to explain.
  const tool = createRecallTool({ getRecords: async () => undefined, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "retainTokens" });
  assert.deepEqual(value.recalled, []);
  assert.equal(value.block, "");
});

test("execute never returns a retired record", async () => {
  const withDead = [
    ...STORE,
    { id: "c9", subject: "config.retain_tokens", title: "retainTokens 旧值", body: "", supersededAt: 3 },
  ];
  const tool = createRecallTool({ getRecords: () => withDead, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "retainTokens" });
  assert.ok(!value.recalled.some((r) => r.id === "c9"));
});

test("render produces one text block, like memory_stats does", async () => {
  const tool = createRecallTool({ getRecords: () => STORE, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "retainTokens" });
  const rendered = tool.output.render({}, value);
  assert.ok(Array.isArray(rendered));
  assert.equal(rendered[0].type, "text");
  assert.equal(typeof rendered[0].text, "string");
});

test("execute returns nothing the schema does not declare", async () => {
  // `additionalProperties: false` makes any extra field a runtime validation failure —
  // the registry rejects the tool result, not the tool call. An earlier draft returned
  // an `_expandedCount` for diagnostics and would have failed exactly this way.
  const tool = createRecallTool({ getRecords: () => STORE, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "retainTokens" });
  const declared = Object.keys(tool.output.schema.properties).sort();
  assert.deepEqual(Object.keys(value).sort(), declared);

  for (const record of value.recalled) {
    assert.deepEqual(
      Object.keys(record).sort(),
      Object.keys(tool.output.schema.properties.recalled.items.properties).sort(),
      "record fields must match the declared item schema",
    );
  }
});

test("a record with a missing title still validates against the schema", async () => {
  // title is declared `type: "string"`, so it must never come back undefined.
  const sparse = [{ id: "c1", subject: "config.x", body: "只有正文" }];
  const tool = createRecallTool({ getRecords: () => sparse, config: RECALL_DEFAULTS });
  const value = await tool.execute({ query: "只有正文" });
  for (const record of value.recalled) assert.equal(typeof record.title, "string");
});
