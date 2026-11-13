/**
 * Self tree: durable user override on disk.
 *
 * Why this file exists
 * --------------------
 * The self tree is normally *only* a surface message: `publishSelf` renders the
 * nodes carried on the latest `memory:self` message, and a brand-new session has
 * none, so it falls back to `defaultSelfNodes()`. That is fine for a fixed
 * persona, but it means an edit made in the Settings page would vanish the moment
 * a new session started — the surface it lived on is gone.
 *
 * This module is that missing durable layer. The Settings page writes the whole
 * node set here; `publishSelf` reads it *first* and only falls back to the
 * surface copy (then the defaults) when no override file exists. So:
 *
 *   - no file            → behaviour is byte-identical to before (surface/defaults)
 *   - file present       → the user's edit wins, in every session, immediately
 *   - file deleted       → back to defaults (that is what "恢复默认" does)
 *
 * The file is intentionally small and human-editable JSON:
 *
 *   { "version": 1, "revision": 3, "updatedAt": "…",
 *     "nodes": [ { "id": "self-identity", "kind": "identity",
 *                  "order": 10, "title": "身份", "body": "…" }, … ] }
 *
 * Only the user-facing fields are persisted. Every structural field `validateNode`
 * or the renderer needs (`zone`, `parentId`, `weight`, `pinned`, `rev`,
 * `archived`) is re-derived by {@link normalizeSelfNodes}, so a hand-edited file
 * can never introduce an invalid node.
 *
 * Failure policy: every read is best-effort. A missing, unreadable, or corrupt
 * file returns the defaults rather than throwing — a bad override must never
 * brick folding, which runs on every single step.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultSelfNodes } from "./self.js";
import { KINDS, MAX_BODY, MAX_TITLE, validateNode } from "./tree.js";

/** File format version. Bumped only if the on-disk shape changes incompatibly. */
const VERSION = 1;

/** Id charset the renderer and storage domain both accept. */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Absolute path of the override file.
 * @returns {string} `~/.dsh/storages/dsh_memory_self.json`.
 */
export function selfStorePath() {
  return path.join(os.homedir(), ".dsh", "storages", "dsh_memory_self.json");
}

/**
 * Infer a node kind from a Chinese section title, mirroring `self.js`.
 * @param {string} title - section title.
 * @returns {string} one of {@link KINDS}.
 */
function kindFromTitle(title) {
  if (title === "身份") return "identity";
  if (title === "取舍") return "preference";
  return "constraint";
}

/**
 * Turn an arbitrary user payload into a valid, fully-formed node array.
 *
 * Throws on anything a user could not have meant (empty list, empty title,
 * over-long text). Missing structural fields are filled in; a missing/invalid id
 * is generated and guaranteed unique. Never truncates: silently cutting a body
 * reads as a complete fact that happens to stop mid-sentence.
 *
 * @param {Array<{id?:string,kind?:string,order?:number,title?:string,body?:string}>} input
 * @returns {import('./tree.js').MemoryNode[]} normalized nodes.
 */
export function normalizeSelfNodes(input) {
  if (!Array.isArray(input)) {
    throw new Error("自我认知必须是一个节点数组。");
  }
  if (input.length === 0) {
    throw new Error("自我认知至少要保留一条；要恢复默认请用「恢复默认」。");
  }
  const seen = new Set();
  /** @type {import('./tree.js').MemoryNode[]} */
  const out = [];
  input.forEach((raw, index) => {
    const label = `第 ${index + 1} 条`;
    const title = typeof raw?.title === "string" ? raw.title.trim() : "";
    if (title === "") throw new Error(`${label}缺少标题。`);
    if (title.length > MAX_TITLE) {
      throw new Error(`${label}标题过长（${title.length} 字，上限 ${MAX_TITLE}）。`);
    }
    const body = typeof raw?.body === "string" ? raw.body.trim() : "";
    if (body.length > MAX_BODY) {
      throw new Error(`${label}正文过长（${body.length} 字，上限 ${MAX_BODY}）。`);
    }
    let id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (id === "" || !ID_PATTERN.test(id) || seen.has(id)) {
      let n = index + 1;
      id = `self-u-${n}`;
      while (seen.has(id)) {
        n += 1;
        id = `self-u-${n}`;
      }
    }
    seen.add(id);
    const kind = KINDS.includes(raw?.kind) ? raw.kind : kindFromTitle(title);
    const order = Number.isFinite(raw?.order) ? Number(raw.order) : (index + 1) * 10;
    /** @type {import('./tree.js').MemoryNode} */
    const node = {
      id,
      zone: "frozen",
      kind,
      parentId: null,
      order,
      title,
      body,
      weight: 1,
      pinned: true,
      rev: 1,
      archived: false,
    };
    validateNode(node, "self-store");
    out.push(node);
  });
  return out;
}

/**
 * Read the persisted override state.
 *
 * @param {string} [file] - override path (defaults to {@link selfStorePath}).
 * @returns {{nodes: import('./tree.js').MemoryNode[], revision: number, exists: boolean}}
 *   `exists:false` means "no usable override"; `nodes` is then the defaults and
 *   `revision` is 0 so the first save can be created without a conflict.
 */
export function readSelfState(file = selfStorePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const rawNodes = Array.isArray(raw?.nodes) ? raw.nodes : null;
    if (rawNodes !== null && rawNodes.length > 0) {
      return {
        nodes: normalizeSelfNodes(rawNodes),
        revision: Number.isFinite(raw?.revision) ? raw.revision : 1,
        exists: true,
      };
    }
  } catch {
    /* missing, unreadable, or corrupt → fall through to defaults */
  }
  return { nodes: defaultSelfNodes(), revision: 0, exists: false };
}

/**
 * Convenience read for the hot path: the override nodes, or null when none.
 * @param {string} [file] - override path.
 * @returns {import('./tree.js').MemoryNode[]|null} nodes or null.
 */
export function readSelfOverride(file = selfStorePath()) {
  const state = readSelfState(file);
  return state.exists ? state.nodes : null;
}

/**
 * Validate and persist a new node set.
 *
 * @param {Array} input - the user's node payload.
 * @param {number} [expectedRevision] - optimistic-concurrency guard; when finite
 *   and it does not match the current revision, throws `code:"self-conflict"`.
 * @param {string} [file] - override path.
 * @returns {{nodes: import('./tree.js').MemoryNode[], revision: number, exists: boolean}}
 */
export function writeSelfOverride(input, expectedRevision, file = selfStorePath()) {
  // Validate BEFORE touching the file, so a rejected payload never corrupts state.
  const nodes = normalizeSelfNodes(input);
  const current = readSelfState(file);
  if (Number.isFinite(expectedRevision) && expectedRevision !== current.revision) {
    const err = new Error("自我认知已被别处修改，已为你刷新最新内容，请重试。");
    // @ts-expect-error - annotate for the route layer's 409 mapping.
    err.code = "self-conflict";
    throw err;
  }
  const nextRevision = current.revision + 1;
  const doc = {
    version: VERSION,
    revision: nextRevision,
    updatedAt: new Date().toISOString(),
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      order: node.order,
      title: node.title,
      body: node.body,
    })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return { nodes: normalizeSelfNodes(doc.nodes), revision: nextRevision, exists: true };
}

/**
 * Reset to {@link defaultSelfNodes} by WRITING them, not deleting the file.
 *
 * Why not delete: the override file being the source of truth only holds while
 * it exists. If "reset" merely removed the file, the *current* session's surface
 * still carries the previously edited nodes, and `publishSelf`'s fallback chain
 * would read those right back — the user would click "恢复默认", see defaults in
 * the page, and the very next turn would republish the old text. Writing the
 * defaults keeps the file authoritative and makes reset deterministic in every
 * session. Deleting the file by hand is still a valid escape hatch for a *fresh*
 * session, but the in-app button uses this.
 *
 * @param {string} [file] - override path.
 * @returns {{nodes: import('./tree.js').MemoryNode[], revision: number, exists: boolean}}
 */
export function resetSelfOverride(file = selfStorePath()) {
  return writeSelfOverride(defaultSelfNodes(), undefined, file);
}

/**
 * The wire shape the Settings page consumes: just the editable fields plus
 * revision/existence/kind vocabulary. Keeps the transport free of structural
 * fields the client should not be able to set.
 * @param {{nodes: import('./tree.js').MemoryNode[], revision: number, exists: boolean}} state
 * @returns {object} plain JSON view.
 */
export function selfView(state) {
  return {
    nodes: state.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      order: node.order,
      title: node.title,
      body: node.body,
    })),
    revision: state.revision,
    exists: state.exists,
    kinds: [...KINDS],
  };
}
