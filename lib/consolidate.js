/**
 * v3 consolidation: the pass that runs when nothing new is happening, and decides
 * what a memory is worth keeping.
 *
 * The tree currently only grows. `mergeNodes` ages nodes out of the *render* budget,
 * but nothing merges two nodes that say the same thing, nothing lowers a node's
 * weight because it has not mattered for a hundred turns, and nothing retires a node
 * without deleting it. That is fine while a session's tree lives and dies with the
 * session; it stops being fine the moment nodes are promoted into long-term memory,
 * because the LTM would then grow without bound.
 *
 * Three passes, all pure and all reversible:
 *
 *   dedupe   two nodes with the same normalized text become one.
 *   decay    weight halves every `halfLifeTurns`, floored.
 *   archive  old *and* light nodes are marked `archived` — never deleted.
 *
 * What is deliberately excluded, and why:
 *
 *   - `task` nodes never decay, never archive, and are never the loser of a merge.
 *     They are the human's own words, which the whole design treats as the one thing
 *     that outranks the budget.
 *   - `pinned` nodes are equally immune. That is the same rule `trimToBudget` uses.
 *   - an interior node is never archived while a live descendant exists, mirroring
 *     the trimmer: archiving a parent would orphan its children, and the renderer
 *     refuses to render orphans rather than silently showing an empty zone.
 *
 * Turn numbers, not wall-clock time: `born` is a turn, and a session that sat idle
 * for a week has not accumulated a week of memory. Using `Date.now()` here would make
 * the same input produce different output on every run, which breaks the
 * determinism the renderer's cache prefix depends on.
 */

/** Nodes that consolidation never touches. */
const PROTECTED_KINDS = Object.freeze(["task"]);

/** Defaults, tuned to the observed session shape (P50 2 turns, P90 20, max 47). */
export const DEFAULTS = Object.freeze({
  halfLifeTurns: 40,
  floorWeight: 0.05,
  archiveAfterTurns: 120,
  archiveBelowWeight: 0.1,
});

/**
 * Is this node immune to decay, archiving and merge loss?
 * @param {object} node - memory node.
 * @returns {boolean} true when protected.
 */
function isProtected(node) {
  return node?.pinned === true || PROTECTED_KINDS.includes(node?.kind);
}

/**
 * Normalized text used for duplicate detection.
 *
 * Each field is normalized on its own before joining: a title's trailing full stop is
 * noise, but the same character *inside* the text is meaning (`--test-concurrency=1`
 * is not `test concurrency 1`). Normalizing the joined string would make the title's
 * punctuation look internal and keep it.
 *
 * @param {object} node - memory node.
 * @returns {string} dedup key.
 */
export function dedupKey(node) {
  const clean = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.,;:!?。，；：！？…\s]+$/g, "")
      .trim();
  return `${clean(node?.title)}\n${clean(node?.body)}`;
}

/**
 * Round a weight to four decimals.
 *
 * Repeated decay on unrounded floats drifts, and a drifting weight changes the
 * renderer's sort order, which changes the cached prefix. Rounding is what keeps
 * "same input, same output" true across runs.
 *
 * @param {number} value - raw weight.
 * @returns {number} rounded weight.
 */
function roundWeight(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

/**
 * Merge nodes whose normalized text is identical.
 *
 * The survivor is chosen deterministically: a protected node beats an unprotected
 * one, then higher weight, then the later `rev` (the more recently corrected copy),
 * then the smaller id. Ties on all four are impossible because ids are unique.
 *
 * @param {object[]} nodes - candidate nodes.
 * @returns {{nodes: object[], merged: number}} survivors and how many disappeared.
 */
export function mergeDuplicates(nodes) {
  /** @type {Map<string, object>} */
  const byKey = new Map();
  const order = [];
  let merged = 0;

  for (const node of nodes) {
    if (node?.archived) continue;
    const key = dedupKey(node);
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, node);
      order.push(key);
      continue;
    }
    merged += 1;
    if (wins(node, seen)) byKey.set(key, node);
  }

  return { nodes: order.map((key) => byKey.get(key)), merged };
}

/**
 * Does `challenger` replace `holder` as the survivor of a duplicate pair?
 * @param {object} challenger - candidate.
 * @param {object} holder - current survivor.
 * @returns {boolean} true when the challenger wins.
 */
function wins(challenger, holder) {
  const a = isProtected(challenger);
  const b = isProtected(holder);
  if (a !== b) return a;
  if ((challenger.weight ?? 0) !== (holder.weight ?? 0)) return (challenger.weight ?? 0) > (holder.weight ?? 0);
  if ((challenger.rev ?? 1) !== (holder.rev ?? 1)) return (challenger.rev ?? 1) > (holder.rev ?? 1);
  return String(challenger.id) < String(holder.id);
}

/**
 * Halve weights by age, floored, relative to a remembered base weight.
 *
 * Decay is **absolute, not incremental**. Computing `weight * 0.5^age` would compound
 * every time the consolidator ran — two passes over the same node would halve it
 * twice for the same age, and the result would depend on how often the pass ran rather
 * than on how old the memory is. `baseWeight` is recorded the first time a node is
 * decayed, so a second pass at the same turn reproduces the same number.
 *
 * @param {object[]} nodes - candidate nodes.
 * @param {object} [options] - tuning.
 * @param {number} options.now - current turn.
 * @param {number} [options.halfLifeTurns] - turns for a weight to halve.
 * @param {number} [options.floorWeight] - lowest weight decay may reach.
 * @returns {{nodes: object[], decayed: number}} updated copies and how many changed.
 */
export function decayWeights(nodes, options) {
  const now = Number.isFinite(options?.now) ? options.now : 0;
  const halfLife = Number.isFinite(options?.halfLifeTurns) && options.halfLifeTurns > 0 ? options.halfLifeTurns : DEFAULTS.halfLifeTurns;
  const floor = Number.isFinite(options?.floorWeight) ? options.floorWeight : DEFAULTS.floorWeight;

  let decayed = 0;
  const next = nodes.map((node) => {
    if (node?.archived || isProtected(node)) return node;
    const born = typeof node?.born === "number" ? node.born : now;
    const base = typeof node?.baseWeight === "number" ? node.baseWeight : node?.weight ?? 1;
    const age = Math.max(0, now - born);
    const weight = roundWeight(Math.max(floor, base * 0.5 ** (age / halfLife)));
    const moved = weight !== node.weight;
    if (!moved && node.baseWeight === base) return node;
    // Recording `baseWeight` is bookkeeping, not decay: only a weight that actually
    // moved counts, or the counter would report every node on the first pass.
    if (moved) decayed += 1;
    return { ...node, baseWeight: base, weight };
  });
  return { nodes: next, decayed };
}

/**
 * Mark old, light nodes as archived.
 *
 * Archival is a flag, not a deletion: the node leaves the render and the budget, and
 * comes back if anything refreshes it. The orphan guard mirrors `trimToBudget` — a
 * node with a live descendant stays, because archiving it would leave children with
 * a missing parent and the renderer throws on orphans.
 *
 * @param {object[]} nodes - candidate nodes.
 * @param {object} [options] - tuning.
 * @param {number} options.now - current turn.
 * @param {number} [options.archiveAfterTurns] - age at which a light node retires.
 * @param {number} [options.archiveBelowWeight] - weight under which it can retire.
 * @returns {{nodes: object[], archived: number}} updated copies and how many retired.
 */
export function archiveStale(nodes, options) {
  const now = Number.isFinite(options?.now) ? options.now : 0;
  const after = Number.isFinite(options?.archiveAfterTurns) ? options.archiveAfterTurns : DEFAULTS.archiveAfterTurns;
  const below = Number.isFinite(options?.archiveBelowWeight) ? options.archiveBelowWeight : DEFAULTS.archiveBelowWeight;

  const live = nodes.filter((node) => node && !node.archived);
  const hasLiveChild = new Set();
  for (const node of live) {
    if (node.parentId != null) hasLiveChild.add(node.parentId);
  }

  let archived = 0;
  const next = nodes.map((node) => {
    if (!node || node.archived || isProtected(node) || hasLiveChild.has(node.id)) return node;
    const born = typeof node?.born === "number" ? node.born : now;
    const old = now - born >= after;
    const light = (node.weight ?? 1) < below;
    if (!old || !light) return node;
    archived += 1;
    return { ...node, archived: true };
  });
  return { nodes: next, archived };
}

/**
 * Run the whole consolidation pass.
 *
 * Order matters: dedupe first (two half-decayed copies of one fact should merge
 * before either is weighed), then decay, then archive. Running it twice on the same
 * input and the same `now` is a no-op the second time — that property is what makes
 * it safe to call from a schedule.
 *
 * @param {object[]} nodes - candidate nodes.
 * @param {object} [options] - tuning, see {@link DEFAULTS}.
 * @returns {{nodes: object[], stats: {merged: number, decayed: number, archived: number, kept: number}}} result.
 */
export function consolidate(nodes, options = {}) {
  const merged = mergeDuplicates(nodes);
  const decayed = decayWeights(merged.nodes, options);
  const archived = archiveStale(decayed.nodes, options);
  const kept = archived.nodes.filter((node) => !node.archived).length;
  return {
    nodes: archived.nodes,
    stats: {
      merged: merged.merged,
      decayed: decayed.decayed,
      archived: archived.archived,
      kept,
    },
  };
}
