/**
 * Tests for lib/save-tool.js — the fold-independent `memory_save` tool.
 *
 * Exercises the tool definition with plain objects: argument validation, the no-store
 * path, provenance stamping, weight clamping, and that a save converges with a later
 * automatic promote (same content → same content-hash id → one record).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSaveTool, SAVE_DEFAULTS } from "../lib/save-tool.js";
import { ltmId } from "../lib/promote.js";

test("save-tool: exposes the expected shape", () => {
  const tool = createSaveTool();
  assert.equal(tool.name, "memory_save");
  assert.ok(tool.parameters.title.required);
  assert.ok(tool.parameters.body.required);
  // Optional: `required` must be OMITTED, never `false` — the registry rejects
  // `required: false` with "parameters.weight.required must be true when present".
  assert.equal(tool.parameters.weight.required, undefined);
});

test("save-tool: no parameter may set `required: false` (real registry aborts the whole plugin)", () => {
  // Regression guard for the 2026-11-06 activation failure: the real dsh-tools rejects
  // `parameters.X.required: false` ("must be true when present"), which throws inside
  // defineTool and aborts apply() — every tool vanishes. Optional MUST omit the key.
  const tool = createSaveTool();
  for (const [name, spec] of Object.entries(tool.parameters)) {
    if ("required" in spec) {
      assert.equal(spec.required, true, `parameter ${name} sets required:${spec.required}; optional must omit it`);
    }
  }
});

test("save-tool: rejects empty title or body", async () => {
  const saved = [];
  const tool = createSaveTool({ saveRecord: async (r) => { saved.push(r); return { written: 1, errors: [] }; } });
  const a = await tool.execute({ title: "", body: "x" });
  const b = await tool.execute({ title: "x", body: "  " });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(saved.length, 0, "nothing written for invalid args");
});

test("save-tool: reports ok:false when the store is unavailable", async () => {
  const tool = createSaveTool();
  const res = await tool.execute({ title: "T", body: "B" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unavailable/);
});

test("save-tool: writes a record with provenance and the default weight", async () => {
  const captured = [];
  const tool = createSaveTool({
    saveRecord: async ({ record }) => { captured.push(record); return { written: 1, errors: [] }; },
    sessionId: () => "s-abc",
    turn: () => 7,
    now: () => 1000,
  });
  const res = await tool.execute({ title: "  Allow root  ", body: "  user allows root  " });
  assert.equal(res.ok, true);
  assert.equal(captured.length, 1);
  const rec = captured[0];
  assert.equal(rec.title, "Allow root", "title trimmed");
  assert.equal(rec.body, "user allows root", "body trimmed");
  assert.equal(rec.weight, SAVE_DEFAULTS.saveWeight);
  assert.equal(rec.sources[0].sessionId, "s-abc");
  assert.equal(rec.sources[0].turn, 7);
  assert.equal(rec.zone, "recall");
});

test("save-tool: clamps a caller weight into 0..1", async () => {
  const captured = [];
  const tool = createSaveTool({ saveRecord: async ({ record }) => { captured.push(record); return { written: 1, errors: [] }; } });
  await tool.execute({ title: "T", body: "B", weight: 5 });
  await tool.execute({ title: "T2", body: "B2", weight: -1 });
  assert.equal(captured[0].weight, 1);
  assert.equal(captured[1].weight, 0);
});

test("save-tool: the id equals what an automatic promote of the same text would produce", async () => {
  const captured = [];
  const tool = createSaveTool({
    saveRecord: async ({ record }) => { captured.push(record); return { written: 1, errors: [] }; },
    turn: () => 3,
  });
  await tool.execute({ title: "Retain is 12k", body: "retainTokens 12000" });
  const expected = ltmId({ kind: "decision", title: "Retain is 12k", body: "retainTokens 12000" });
  assert.equal(captured[0].id, expected, "save and promote converge on one id");
});

test("save-tool: a per-record write error surfaces as ok:false", async () => {
  const tool = createSaveTool({ saveRecord: async () => ({ written: 0, errors: ["disk full"] }) });
  const res = await tool.execute({ title: "T", body: "B" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /disk full/);
});
