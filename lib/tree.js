/**
 * Memory tree: node schema, deterministic renderer, and budget trimming.
 *
 * The renderer is the part that must be *deterministic*: the same node array
 * must always produce byte-identical text. This is not a style preference. The
 * checkpoint message sits near the front of the request, and provider KV cache
 * matches on a byte prefix — one incidental character of churn (a timestamp, a
 * re-sorted sibling, a counter that advances on re-render) invalidates every
 * cached token after it. v0 measured that cost: DSH itself pays 38,030 wasted
 * tokens on average for a 23-token edit to the model-name line (`v0-findings.md`
 * §2.10). Determinism rules enforced here:
 *
 *   - preorder traversal, siblings sorted by `(order, id)` — never by insertion
 *   - fixed field order in the emitted line
 *   - no timestamps, no random ids, no counters that advance on re-render
 *   - archived nodes are skipped entirely (not rendered as an empty line)
 *
 * Orphan detection is deliberately fatal. A node whose parent is missing is
 * silently absent from the render, which for a memory tree means silent memory
 * loss — the one failure mode that looks exactly like success. v0 hit this: a
 * turn-anchor node was never created, every child became an orphan, and the
 * volatile zone rendered as zero tokens with no error.
 */

/** Canonical zone names, in render order. */
export const ZONES = Object.freeze(["frozen", "volatile", "recall"]);

/** Node kinds. Closed set — decides which render bucket a node lands in. */
export const KINDS = Object.freeze([
  "identity",
  "preference",
  "constraint",
  "fact",
  "entity",
  "task",
  "decision",
  "question",
  "episode",
  "skill",
]);

/** Node id charset. storage-domain record keys only accept `[a-zA-Z0-9_-]`. */
export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const MAX_TITLE = 120;
export const MAX_BODY = 600;

/**
 * Per-turn volatile budget, in tokens (plan D6b strategy C).
 *
 * Fallback only — `cordis.patch.yml` supplies the real number.
 *
 * 2026-11-02 history: 1500 -> 5000 -> 2500.
 *
 * 5000 was set because the tree is the cheap side of the trade (+11% surface for ~3x
 * more retained nodes). It was lowered again the same day, but for a different reason
 * than cost: measured at step granularity (the plugin folds in `agent/pre-step`, so a
 * turn can fold several times), going 5000 -> 2500 did **not** reduce fold count at
 * all (41 -> 41 on a 20-turn eval, 410 -> 410 on a 6-catalog one). The binding term is
 * the barrier, not the tree: a `skill-catalog` is ~9,560 tokens and can never be
 * folded, so `retainTokens` must exceed `barriers + tree + one step's content` or the
 * fold never converges and re-fires at every step. 2500 buys cheaper folds and a
 * smaller surface, nothing more.
 */
export const VOLATILE_BUDGET = 2500;

/** Node-count safety valve, not a budget (plan D6b: count is a bad unit). */
export const MAX_NODES_PER_TURN = 64;

/**
 * @typedef {object} MemoryNode
 * @property {string} id            - stable, `[a-zA-Z0-9_-]+`
 * @property {string} zone          - frozen / volatile / recall
 * @property {string} kind          - one of {@link KINDS}
 * @property {string|null} parentId - null for a zone root
 * @property {number} order         - sibling sort key, stable
 * @property {string} title         - one-line index, <= 120 chars
 * @property {string} body          - payload, <= 600 chars
 * @property {number} weight        - 0..1 salience
 * @property {boolean} pinned       - never trimmed
 * @property {number} rev           - optimistic concurrency
 * @property {boolean} archived
 */

/**
 * Validate one node. Throws rather than truncates: a body that exceeds the cap
 * must be split into children by the distiller, not silently cut, because a cut
 * body reads as a complete fact that happens to stop mid-sentence.
 * @param {MemoryNode} node - node to validate.
 * @param {string} origin - caller label for the error message.
 * @returns {MemoryNode} the same node.
 */
export function validateNode(node, origin = "memory") {
  if (typeof node?.id !== "string" || !ID_PATTERN.test(node.id)) {
    throw new Error(`${origin}: node id must match ${ID_PATTERN}: ${JSON.stringify(node?.id)}`);
  }
  if (typeof node.title !== "string" || node.title.length > MAX_TITLE) {
    throw new Error(`${origin}/${node.id}: title must be a string <= ${MAX_TITLE} chars (${node.title?.length})`);
  }
  if (typeof node.body !== "string" || node.body.length > MAX_BODY) {
    throw new Error(`${origin}/${node.id}: body must be a string <= ${MAX_BODY} chars (${node.body?.length})`);
  }
  if (!Number.isFinite(node.order)) {
    throw new Error(`${origin}/${node.id}: order must be finite`);
  }
  if (!KINDS.includes(node.kind)) {
    throw new Error(`${origin}/${node.id}: unknown kind ${JSON.stringify(node.kind)}`);
  }
  if (!Number.isFinite(node.weight)) {
    throw new Error(`${origin}/${node.id}: weight must be finite`);
  }
  return node;
}

/**
 * Index nodes into deterministic child lists.
 * @param {MemoryNode[]} nodes - nodes of one zone.
 * @returns {Map<string|null, MemoryNode[]>} children by parent id.
 */
function indexChildren(nodes) {
  /** @type {Map<string|null, MemoryNode[]>} */
  const children = new Map();
  for (const node of nodes) {
    if (node.archived) continue;
    const key = node.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1));
  }
  return children;
}

/**
 * Render one zone as an indented bullet list, deterministically.
 * @param {MemoryNode[]} nodes - nodes of one zone.
 * @param {{depth?: number, origin?: string}} [options] - depth cap and label.
 * @returns {string} rendered text, `""` when nothing survives.
 */
export function renderZoneTree(nodes, options = {}) {
  const maxDepth = options.depth ?? 3;
  const origin = options.origin ?? "render";
  for (const node of nodes) validateNode(node, origin);

  const children = indexChildren(nodes);
  const lines = [];
  const seen = new Set();

  /**
   * @param {string|null} parentId
   * @param {number} depth
   */
  const walk = (parentId, depth) => {
    if (depth > maxDepth) return;
    for (const node of children.get(parentId) ?? []) {
      seen.add(node.id);
      const body = node.body.trim();
      const line = body === "" ? node.title : `${node.title}: ${body}`;
      lines.push(`${"  ".repeat(depth - 1)}- ${line}`);
      walk(node.id, depth + 1);
    }
  };
  walk(null, 1);

  const live = nodes.filter((node) => !node.archived);
  const orphans = live.filter((node) => !seen.has(node.id));
  if (orphans.length > 0) {
    const sample = orphans.slice(0, 5).map((node) => `${node.id}(parent=${node.parentId})`);
    throw new Error(
      `${origin}: ${orphans.length} node(s) unreachable from root — ` +
        `missing parent or beyond depth ${maxDepth}: ${sample.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Frame a rendered zone so the model can tell which budget zone it is reading.
 * @param {string} zone - zone name.
 * @param {string} body - rendered tree.
 * @returns {string} framed text.
 */
export function frameZone(zone, body) {
  return `<memory zone="${zone}">\n${body}\n</memory>`;
}

/**
 * Merge this turn's freshly distilled nodes into the carried-forward set.
 *
 * Carrying forward matters: a node distilled on turn 3 must survive turns 4..N
 * or the model rediscovers it every turn and the STM never accumulates. `rev`
 * bumps only when the rendered text actually changed, so an unchanged node does
 * not churn the render.
 *
 * @param {MemoryNode[]} carried - nodes carried from the previous checkpoint.
 * @param {MemoryNode[]} fresh - nodes distilled from this turn.
 * @param {number} turn - current turn number, used for id scoping.
 * @returns {MemoryNode[]} merged nodes, deterministic order.
 */
export function mergeNodes(carried, fresh, turn) {
  const byId = new Map();
  for (const node of carried) byId.set(node.id, node);

  // Content identity, separate from id identity.
  //
  // Node ids are segment-scoped (`s<startSeq>-m<index>`), so the same fact distilled by
  // two different folds gets two different ids and by-id merging never sees them as one.
  // Measured on a live session: 24 folds in 33 minutes produced 55 model nodes of which
  // 38% were duplicate titles ("运行环境与文件策略参数" was kept five times). The id
  // records which fold happened to produce a node; title+body is what the model reads.
  //
  // Dedup is leaf-only on purpose. An anchor is the parent of its children and a task
  // node is the human's own words (pinned); collapsing either by content would orphan
  // children or discard the words this design never drops. Two nodes are "the same fact"
  // only when they render identically and neither owns children.
  const signature = (node) => `${node.kind}\u0000${node.title}\u0000${node.body}`;
  const owners = new Set([...carried, ...fresh].map((node) => node.parentId).filter((id) => id !== null && id !== undefined));
  const canDedup = (node) => !node.pinned && !owners.has(node.id) && (node.parentId ?? null) !== null;
  const bySig = new Map();
  for (const node of carried) if (canDedup(node)) bySig.set(signature(node), node.id);

  for (const node of fresh) {
    const previous = byId.get(node.id);
    if (previous !== undefined) {
      const unchanged = previous.title === node.title && previous.body === node.body;
      byId.set(node.id, unchanged ? previous : { ...node, rev: previous.rev + 1 });
      continue;
    }
    if (canDedup(node)) {
      const existingId = bySig.get(signature(node));
      if (existingId !== undefined && byId.has(existingId)) {
        // The same fact is already carried under an earlier segment. Keep that node's id
        // and order so the render stays stable; just mark it refreshed by this fold.
        const existing = byId.get(existingId);
        byId.set(existingId, { ...existing, rev: existing.rev + 1, born: turn });
        continue;
      }
    }
    byId.set(node.id, node);
  }
  // Turn-scoped pruning: nodes nobody refreshed for 20 turns drop out. The
  // window is deliberately generous — an idle-but-true fact (a port number) is
  // cheaper to keep than to rediscover.
  //
  // Age comes from the `born` field, not from the id. v0-derived ids were
  // `t<turn>-...`, so parsing the prefix looked workable; segment ids are
  // `s<seq>-...`, where the same parse yields NaN and every node silently escapes
  // decay. A silent no-op is the failure mode with no symptom until the budget
  // overflows for no visible reason, so the field is explicit.
  const all = [...byId.values()];
  const freshIds = new Set(fresh.map((node) => node.id));
  /** @type {Set<string>} */
  const drop = new Set();
  for (const node of all) {
    if (node.pinned) continue;
    // A node this fold just produced is not stale: it was refreshed right now, even
    // though its material may be many turns old. Without this exemption a backlog
    // fold (distilling turn 2 at turn 40) ages out everything it just learned, the
    // tree renders empty, and the fold silently abandons — leaving the context
    // unbounded with no error anywhere. Measured on `2d026c40`: without it the
    // surface ends at 134k instead of 81k.
    if (freshIds.has(node.id)) continue;
    const born = typeof node.born === "number" ? node.born : null;
    if (born !== null && turn - born > 20) drop.add(node.id);
  }

  // An interior node may not be aged out while anything still hangs beneath it,
  // or the renderer sees an orphan and throws. Cascading the drop downwards is not
  // an option either: the descendants include `task` nodes, and the human's words
  // are the one thing this design never discards to save budget.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of all) {
      if (!drop.has(node.id)) continue;
      if (all.some((other) => other.parentId === node.id && !drop.has(other.id))) {
        drop.delete(node.id);
        changed = true;
      }
    }
  }

  const kept = all.filter((node) => !drop.has(node.id));
  kept.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1));
  return kept;
}

/**
 * Trim a node set to a token budget, deterministically.
 *
 * Trim order is `episode` (tool pointers) first, then `decision` (assistant
 * prose), and never `task` (the human's own words) or pinned nodes. v0 measured
 * three strategies (`out/policycompare2.json`): capping by node count left 10 of
 * 444 turns over budget and still threw away utterances; capping tool tokens
 * alone left 34 over budget; capping the whole zone by tokens was the only one
 * that kept P95 inside 1,490 tokens with 0 turns over and 0 utterances lost.
 * The reason is that node count and token count are not proportional — 16 nodes
 * may be 16 short tool pointers (~200 tok) or 16 paragraphs of instruction
 * (~3,000 tok).
 *
 * @param {MemoryNode[]} nodes - candidate nodes.
 * @param {number} budget - token budget.
 * @param {(node: MemoryNode) => number} price - token pricer for one node.
 * @returns {{kept: MemoryNode[], dropped: MemoryNode[], oversized: boolean}} the trim.
 */
export function trimToBudget(nodes, budget, price) {
  const kept = nodes.filter((node) => !node.archived);
  const dropped = [];
  const total = () => kept.reduce((sum, node) => sum + price(node), 0);

  /**
   * Does any node still in `kept` hang below this one?
   *
   * Removing an anchor while a child survives leaves an orphan, and the renderer
   * throws on orphans — correctly, because a silently empty zone reads as "there
   * is no memory" rather than as a bug. Rather than teach the renderer to tolerate
   * orphans, the trimmer refuses to create them: an interior node is only
   * removable once nothing hangs beneath it. The consequence is that an anchor
   * survives as long as any `task` node under it does, which is the intended
   * priority — the human's words outrank the budget.
   *
   * @param {MemoryNode} node - candidate parent.
   * @returns {boolean} true when a descendant is still kept.
   */
  const hasKeptDescendant = (node) => kept.some((other) => other.parentId === node.id);

  const removable = () =>
    kept
      .filter((node) => !node.pinned && node.kind !== "task" && !hasKeptDescendant(node))
      .sort((a, b) => a.weight - b.weight || b.order - a.order);

  /** @type {string[]} */
  const order = ["episode", "decision"];
  for (const kind of order) {
    while (total() > budget) {
      const candidates = removable().filter((node) => node.kind === kind);
      if (candidates.length === 0) break;
      const victim = candidates[0];
      kept.splice(kept.indexOf(victim), 1);
      dropped.push(victim);
    }
  }

  // A pinned or task node can still exceed the budget on its own. That is a
  // signal, not something to silently truncate: the caller logs `oversized` and
  // the human's own words survive intact. Truncating the human is worse than
  // overrunning a soft budget.
  const oversized = total() > budget;
  return { kept, dropped, oversized };
}

/**
 * Price one node for budget purposes.
 * @param {import('./pricing.js')} pricing - pricing module.
 * @param {MemoryNode} node - node.
 * @returns {number} tokens.
 */
export function nodePricer(pricing, node) {
  return pricing.priceString(`${node.title}: ${node.body}`);
}
