/**
 * v3 LTM domain: the long-term-memory record store, declared as a `@deepseek-ai/dsh-storage-domain`
 * domain over the host's storage hub (JSON backend → `~/.dsh/storages/dsh_memory.json`).
 *
 * Why a domain and not our own file: the host already runs a storage stack
 * (`@deepseek-ai/dsh-storage` + `dsh-storage-domain` + `dsh-storage-json`) — proven by
 * `~/.dsh/storages/workspace.json`. `defineDomain` gives schema validation, change events,
 * and durable KV with zero bespoke IO (v7 plan §2). This is the LTM half of that.
 *
 * Dependency-injection boundary (this repo's rule — `lib/*.js` never imports
 * `@deepseek-ai/*` at top level; only `index.js` does): the record schema is built by
 * `buildLtmRecordSchema(z)` from a zod instance passed in. `index.js` passes the host's
 * zod; a test passes the profile's zod via createRequire. This module has NO top-level
 * host import, so it is importable from the source tree with no node_modules.
 *
 * @module dsh-memory/ltm-domain
 */

/** Domain name. Must match storage-domain's UNIT_NAME_RE: ^[a-z][a-z0-9_]*$. */
export const LTM_DOMAIN_NAME = "dsh_memory";

/** Domain version. Bump when the record schema changes incompatibly. */
export const LTM_DOMAIN_VERSION = 1;

/** The single table holding LTM records (key = record.id, the content hash). */
export const LTM_TABLE = "records";

/**
 * Build the zod record schema for one LTM record.
 *
 * Mirrors exactly the object `toLtmRecord` in promote.js produces. Kept in lock-step
 * with that function — if you add a field there, add it here or the store will reject
 * the record on reopen (`invalid-record`). `nextOffset`-style pitfalls do not apply here
 * (this is a record schema consumed by `parseRecord`, not a tool schema), but we still
 * avoid nullable-integer ambiguity: `supersededAt` is `number | null` and `subject` is
 * `string | null`, both of which zod handles natively via `.nullable()`.
 *
 * @param {object} z - a zod instance (`{ object, string, number, array, literal, ... }`).
 * @returns {object} the zod object schema for a record.
 */
export function buildLtmRecordSchema(z) {
  if (!z || typeof z.object !== "function") {
    throw new Error("buildLtmRecordSchema: a zod instance with .object/.string/... is required");
  }
  const sourceSchema = z.object({
    sessionId: z.string(),
    turn: z.number(),
    seqRange: z.tuple([z.number(), z.number()]).optional(),
    promotedAt: z.number(),
  });
  return z.object({
    id: z.string(),
    zone: z.literal("recall"),
    kind: z.string(),
    parentId: z.string().nullable().optional(),
    order: z.number().optional(),
    // v8: work grouping edge + pivot linkage. Optional + nullable so pre-v8 records
    // (which have neither) still validate on reopen — no version bump / no migration.
    work: z.string().nullable().optional(),
    pivotId: z.string().nullable().optional(),
    title: z.string(),
    body: z.string(),
    weight: z.number(),
    pinned: z.boolean(),
    rev: z.number(),
    born: z.number(),
    archived: z.boolean(),
    firstSeenTurn: z.number(),
    hits: z.number(),
    sources: z.array(sourceSchema),
    subject: z.string().nullable(),
    supersedes: z.array(z.string()),
    supersededAt: z.number().nullable(),
    frozen: z.boolean(),
  });
}

/**
 * Build the storage-domain spec declaring the LTM table.
 *
 * `defineDomain` validates the name / version / table shape at module load and throws on
 * misconfiguration (before any medium is touched). It is passed in rather than imported
 * for the same DI reason as the schema.
 *
 * @param {object} deps - `{ z, defineDomain, domainTable }`.
 * @returns {object} the domain spec to hand to `ctx.storageDomain.open(spec)`.
 */
export function buildLtmDomainSpec({ z, defineDomain, domainTable } = {}) {
  if (typeof defineDomain !== "function" || typeof domainTable !== "function") {
    throw new Error("buildLtmDomainSpec: defineDomain and domainTable are required (from @deepseek-ai/dsh-storage-domain)");
  }
  const schema = buildLtmRecordSchema(z);
  return defineDomain({
    name: LTM_DOMAIN_NAME,
    version: LTM_DOMAIN_VERSION,
    tables: { [LTM_TABLE]: domainTable(schema) },
  });
}

/**
 * Build the same domain spec WITHOUT the storage-domain helpers, by hand.
 *
 * Why this exists: the plugin must not top-level import `@deepseek-ai/dsh-storage-domain`,
 * and at runtime a dynamic `import("@deepseek-ai/dsh-storage-domain")` from a `file:` plugin
 * may not resolve to the host's copy (asar + module-interception is not guaranteed for a
 * profile plugin's own bare import — the same class of problem as the @deepseek-ai peer).
 * `defineDomain` is *validation + `return spec`* (storage-domain lib, `defineDomain` body),
 * and `domainTable(schema)` is just `{ valueSchema: schema }`. So we can construct the spec
 * ourselves with zero storage-domain dependency — only `z` (zod), which DOES resolve from
 * the profile's node_modules. This removes the single riskiest runtime import.
 *
 * The trade-off: we skip defineDomain's load-time validation. We replicate the checks that
 * matter here (name/version/table shape), and `open()` still validates/behaves identically
 * because it receives the exact same spec object shape.
 *
 * @param {object} z - a zod instance.
 * @returns {object} a spec acceptable to `ctx.storageDomain.open(spec)`.
 */
export function buildLtmDomainSpecPlain(z) {
  const schema = buildLtmRecordSchema(z);
  // Mirror defineDomain's name / version / table-name validation (the parts a bug here
  // would trip); open() will throw the same class of error if we got it wrong.
  if (!/^[a-z][a-z0-9_]*$/.test(LTM_DOMAIN_NAME)) {
    throw new Error(`LTM domain name '${LTM_DOMAIN_NAME}' must match ^[a-z][a-z0-9_]*$`);
  }
  if (!Number.isInteger(LTM_DOMAIN_VERSION) || LTM_DOMAIN_VERSION < 0) {
    throw new Error(`LTM domain version must be a non-negative integer, got ${LTM_DOMAIN_VERSION}`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(LTM_TABLE)) {
    throw new Error(`LTM table name '${LTM_TABLE}' must match ^[a-z][a-z0-9_]*$`);
  }
  return {
    name: LTM_DOMAIN_NAME,
    version: LTM_DOMAIN_VERSION,
    tables: { [LTM_TABLE]: { valueSchema: schema } },
  };
}

/**
 * Records that must not be written as-is / that the store can represent. Kept as a plain
 * structural check (no zod) so index.js can sanity-check a record before `put` without
 * pulling the schema into hot paths, and so tests can assert shape with zero deps.
 *
 * @param {object} record - candidate LTM record.
 * @returns {string|null} an error string, or null when the record is structurally sound.
 */
export function checkLtmRecordShape(record) {
  if (record === null || typeof record !== "object") return "record must be an object";
  if (typeof record.id !== "string" || record.id === "") return "record.id must be a non-empty string";
  if (record.zone !== "recall") return "record.zone must be 'recall'";
  if (typeof record.title !== "string") return "record.title must be a string";
  if (typeof record.body !== "string") return "record.body must be a string";
  if (typeof record.weight !== "number") return "record.weight must be a number";
  if (typeof record.born !== "number") return "record.born must be a number";
  if (!Array.isArray(record.sources)) return "record.sources must be an array";
  if (!(record.subject === null || typeof record.subject === "string")) return "record.subject must be string|null";
  // v8: work / pivotId are optional; when present must be string|null. Undefined is fine
  // (pre-v8 records), so we only reject a wrong *type*.
  if (!(record.work === undefined || record.work === null || typeof record.work === "string")) {
    return "record.work must be string|null";
  }
  if (!(record.pivotId === undefined || record.pivotId === null || typeof record.pivotId === "string")) {
    return "record.pivotId must be string|null";
  }
  if (!Array.isArray(record.supersedes)) return "record.supersedes must be an array";
  if (!(record.supersededAt === null || typeof record.supersededAt === "number")) {
    return "record.supersededAt must be number|null";
  }
  return null;
}

export default buildLtmDomainSpec;
