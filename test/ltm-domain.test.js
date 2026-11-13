/**
 * Tests for lib/ltm-domain.js.
 *
 * The module has NO top-level host import (DI boundary), so this test borrows the REAL
 * zod and @deepseek-ai/dsh-storage-domain from the desktop profile via createRequire.
 * That is deliberate: we want to prove the schema/spec actually validate under the same
 * zod dialect the host uses, not a stand-in. If the profile is absent (CI without DSH),
 * the real-dependency cases are skipped; the pure shape checks still run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LTM_DOMAIN_NAME,
  LTM_DOMAIN_VERSION,
  LTM_TABLE,
  buildLtmRecordSchema,
  buildLtmDomainSpec,
  buildLtmDomainSpecPlain,
  checkLtmRecordShape,
} from "../lib/ltm-domain.js";

// `DSH_PROFILE` in this environment is set to a bare name ("desktop"), not a path, so we
// only honour it when it looks absolute; otherwise fall back to the conventional desktop
// profile under the current user's home directory.
const ENV_PROFILE = process.env.DSH_PROFILE;
const DEFAULT_PROFILE = join(homedir(), ".dsh", "profiles", "desktop");
const PROFILE =
  ENV_PROFILE && /^[A-Za-z]:[\\/]/.test(ENV_PROFILE)
    ? ENV_PROFILE
    : DEFAULT_PROFILE;
const req = createRequire(pathToFileURL(join(PROFILE, "x.js")));

function tryLoad(name) {
  try {
    return req(name);
  } catch {
    return null;
  }
}
const zodMod = tryLoad("zod");
const z = zodMod?.z ?? zodMod;
const sdMod = tryLoad("@deepseek-ai/dsh-storage-domain");

/** A full, valid LTM record (what toLtmRecord produces). */
function validRecord(overrides = {}) {
  return {
    id: "ltm-abc123def4567890",
    zone: "recall",
    kind: "decision",
    title: "config.retainTokens 改为 15000",
    body: "从 12000 调整。",
    weight: 0.8,
    pinned: false,
    rev: 1,
    born: 5,
    archived: false,
    firstSeenTurn: 5,
    hits: 1,
    sources: [{ sessionId: "s1", turn: 5, promotedAt: 1000 }],
    subject: "config.retaintokens",
    supersedes: [],
    supersededAt: null,
    frozen: false,
    ...overrides,
  };
}

test("ltm-domain: constants honour storage-domain's UNIT_NAME_RE", () => {
  assert.match(LTM_DOMAIN_NAME, /^[a-z][a-z0-9_]*$/);
  assert.ok(Number.isInteger(LTM_DOMAIN_VERSION) && LTM_DOMAIN_VERSION >= 0);
  assert.match(LTM_TABLE, /^[a-z][a-z0-9_]*$/);
});

test("ltm-domain: buildLtmRecordSchema rejects a non-zod argument", () => {
  assert.throws(() => buildLtmRecordSchema(null), /zod instance/);
  assert.throws(() => buildLtmRecordSchema({}), /zod instance/);
});

test("ltm-domain: checkLtmRecordShape accepts a valid record", () => {
  assert.equal(checkLtmRecordShape(validRecord()), null);
});

test("ltm-domain: checkLtmRecordShape rejects broken records", () => {
  assert.ok(checkLtmRecordShape(null));
  assert.ok(checkLtmRecordShape(validRecord({ id: "" })));
  assert.ok(checkLtmRecordShape(validRecord({ zone: "volatile" })));
  assert.ok(checkLtmRecordShape(validRecord({ weight: "0.8" })));
  assert.ok(checkLtmRecordShape(validRecord({ subject: 5 })));
  assert.ok(checkLtmRecordShape(validRecord({ supersededAt: "x" })));
});

// --- Real-dependency cases (skipped when the desktop profile is unavailable) --------

test("ltm-domain: zod schema parses a valid record and rejects a broken one", { skip: z === null }, () => {
  const schema = buildLtmRecordSchema(z);
  const ok = schema.parse(validRecord());
  assert.equal(ok.id, "ltm-abc123def4567890");
  assert.equal(ok.subject, "config.retaintokens");

  assert.throws(() => schema.parse(validRecord({ zone: "volatile" })), /zone|literal|invalid/i);
  assert.throws(() => schema.parse(validRecord({ sources: "not-array" })), /array|invalid/i);
});

test("ltm-domain: zod schema accepts subject:null and supersededAt:null", { skip: z === null }, () => {
  const schema = buildLtmRecordSchema(z);
  const parsed = schema.parse(validRecord({ subject: null, supersededAt: null }));
  assert.equal(parsed.subject, null);
  assert.equal(parsed.supersededAt, null);
});

test("ltm-domain: buildLtmDomainSpec yields a valid domain spec via real defineDomain", {
  skip: z === null || sdMod === null,
}, () => {
  const spec = buildLtmDomainSpec({
    z,
    defineDomain: sdMod.defineDomain,
    domainTable: sdMod.domainTable,
  });
  assert.equal(spec.name, LTM_DOMAIN_NAME);
  assert.equal(spec.version, LTM_DOMAIN_VERSION);
  assert.ok(spec.tables && spec.tables[LTM_TABLE], "declares the records table");
  assert.ok(typeof spec.tables[LTM_TABLE].valueSchema?.parse === "function", "table has a zod schema");
});

test("ltm-domain: buildLtmDomainSpecPlain builds the same shape with only zod (no storage-domain)", { skip: z === null }, () => {
  const spec = buildLtmDomainSpecPlain(z);
  assert.equal(spec.name, LTM_DOMAIN_NAME);
  assert.equal(spec.version, LTM_DOMAIN_VERSION);
  assert.ok(spec.tables[LTM_TABLE], "declares the records table");
  // The table entry is exactly `{ valueSchema }` — what domainTable(schema) returns.
  assert.deepEqual(Object.keys(spec.tables[LTM_TABLE]), ["valueSchema"]);
  assert.equal(typeof spec.tables[LTM_TABLE].valueSchema.parse, "function");
  // And the schema actually validates a record (proves the plain path is not a stub).
  const parsed = spec.tables[LTM_TABLE].valueSchema.parse(
    validRecord(),
  );
  assert.equal(parsed.id, "ltm-abc123def4567890");
});
