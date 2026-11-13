/**
 * v3 LTM store adapter: the thin, testable seam between the domain table and the rest of
 * the plugin. It holds NO host import (DI boundary) — `index.js` opens the domain and
 * hands in a table-like adapter; tests hand in a Map-backed fake.
 *
 * The table adapter must provide the `KvTableImpl` surface from dsh-storage-domain:
 *   get(key) -> value | undefined
 *   entries() -> Iterable<[key, value]>
 *   put(key, value) -> Promise<void>
 *   delete(key) -> Promise<boolean>
 *
 * We keep this deliberately small: read all live records for recall, load all records for
 * promote (needs retired ones too, to keep supersede state), and apply the write-diff from
 * promote-runner.
 *
 * @module dsh-memory/ltm-store
 */

import { isSearchable } from "./promote.js";

/**
 * Read every record currently in the table (live + retired). Promote needs the full set so
 * `mergeLtm` can see superseded / archived state and stay idempotent.
 * @param {{entries: () => Iterable<[string, object]>}} table - table adapter.
 * @returns {object[]} all records (a fresh array).
 */
export function readAllRecords(table) {
  if (!table || typeof table.entries !== "function") return [];
  const out = [];
  for (const [, record] of table.entries()) {
    if (record && typeof record === "object") out.push(record);
  }
  return out;
}

/**
 * Records eligible to appear in a recall result: everything stored, minus the three
 * retirement kinds (`isSearchable`). The recall tool then ranks these.
 * @param {{entries: () => Iterable<[string, object]>}} table - table adapter.
 * @returns {object[]} searchable records.
 */
export function readSearchableRecords(table) {
  return readAllRecords(table).filter((record) => isSearchable(record));
}

/**
 * Apply a `diffForWrite` result to the table.
 *
 * Writes are sequential on purpose: the domain table serialises its own writes through a
 * queue, and awaiting each keeps the change-event order matching the array order (so the
 * store and any `domain/changed` listener stay consistent). Errors from an individual put
 * are collected, not thrown, so one bad record cannot abort the whole pass — the caller
 * logs and keeps going (a promote pass is best-effort; the next pass retries).
 *
 * @param {object} table - table adapter with async put/delete.
 * @param {{put: object[], deletedIds: string[]}} diff - from `diffForWrite`.
 * @returns {Promise<{written: number, deleted: number, errors: string[]}>} outcome.
 */
export async function applyWriteDiff(table, diff) {
  const errors = [];
  let written = 0;
  let deleted = 0;
  if (!table) return { written, deleted, errors };

  for (const record of diff?.put ?? []) {
    try {
      await table.put(record.id, record);
      written += 1;
    } catch (error) {
      errors.push(`put ${record?.id}: ${error?.message ?? error}`);
    }
  }
  for (const id of diff?.deletedIds ?? []) {
    try {
      const removed = await table.delete(id);
      // KvTableImpl.delete resolves false when the key was absent; count only real deletes.
      if (removed !== false) deleted += 1;
    } catch (error) {
      errors.push(`delete ${id}: ${error?.message ?? error}`);
    }
  }
  return { written, deleted, errors };
}

export default readSearchableRecords;
