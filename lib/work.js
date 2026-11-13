/**
 * v8 work key: derive the stable "which piece of work is this about" identity for an
 * LTM record.
 *
 * Why this exists: `familyOf` in recall.js can only group records that either share a
 * `subject` prefix (config keys) or came from the same session. Neither says "these
 * several facts belong to the same working task", which is exactly what a user means
 * by "同一个工作中的几条信息". A `work` key gives such records a common, stable edge
 * so one-hop expansion (`expandRecall`) can bring the whole set back together, and so
 * the lazy pivot node (promote-runner) has something to hang off.
 *
 * Design constraints (see `v8-LTM组织性.md`):
 *   - **The key does NOT contain a date.** work is an *identity*: the same project on
 *     two different days, or in two sessions, must map to the SAME key (and therefore
 *     the same pivot). Putting a time bucket in the key would split the family per day
 *     and break the very association this feature exists to create. Freshness is
 *     handled by `weight`/`born` in recall ranking, never by severing the family.
 *   - **Pure, deterministic.** Same input → same output. No clock, no randomness. The
 *     caller passes an already-derived `name`; this module only normalises it.
 *   - **Conservative: null when unsure.** A null work key simply means the record falls
 *     back to the old subject/session family — behaviour identical to v7, never worse.
 *   - **A replaceable `namer` hook.** In v8-a the caller supplies a rule-based name
 *     (cwd basename). In v8-b a content-derived name (a light model/摘要 over the first
 *     records of the work) can be plugged in through `options.namer` WITHOUT changing
 *     this function's signature or the key format. That is the seam that keeps v8-b
 *     from touching the write hot path ahead of time.
 *
 * @module dsh-memory/work
 */

/** Max characters kept from a work name. A work key is a grouping id, not a sentence. */
const MAX_WORK_NAME_CHARS = 48;

/** Generic workspace names that are useless as a project identity. */
const GENERIC_NAMES = Object.freeze(new Set(["default-workspace", "workspace", "default", "unnamed"]));

/**
 * Normalise a raw work name to a stable lowercase key body.
 * Collapses whitespace, folds case, trims leading/trailing separators.
 * @param {string} raw - raw name.
 * @returns {string} normalised body (may be "").
 */
export function normaliseWorkName(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .slice(0, MAX_WORK_NAME_CHARS);
}

/**
 * Is this raw name too generic to identify a work?
 * @param {string} name - already-normalised name.
 * @returns {boolean} true when the name should not be used on its own.
 */
export function isGenericWorkName(name) {
  return name === "" || GENERIC_NAMES.has(name);
}

/**
 * Derive the work key for an LTM record.
 *
 * @param {object} input - inputs.
 * @param {string} [input.name] - the raw work name (e.g. a project / cwd basename, or a
 *   content-derived name in v8-b).
 * @param {string} [input.fallback] - a fallback identity when `name` is generic/empty
 *   (e.g. a short session id). Kept separate from `name` so a real name always wins.
 * @param {object} [options] - extension point.
 * @param {(input: object) => string} [options.namer] - v8-b seam: when supplied, its
 *   return value is used as the name instead of `input.name`. Signature and key format
 *   are unchanged, so v8-b swaps the naming without touching callers.
 * @returns {string|null} `work:<body>`, or null when nothing usable exists.
 */
export function extractWork(input = {}, options = {}) {
  const namer = typeof options.namer === "function" ? options.namer : null;
  const rawName = namer ? namer(input) : input?.name;

  let body = normaliseWorkName(rawName);
  // A generic / empty name is not an identity; try the fallback before giving up.
  if (isGenericWorkName(body)) {
    body = normaliseWorkName(input?.fallback);
  }
  if (body === "") return null;
  return `work:${body}`;
}

export default extractWork;
