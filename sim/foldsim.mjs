/**
 * Offline fold simulator: replay recorded sessions through the real planner.
 *
 * The point is not to produce pretty numbers. It is to answer one question unit
 * tests cannot: when this planner meets the surfaces DSH actually builds — 21
 * messages on a median turn, 158 at P95, tool-call runs hundreds long, a
 * 9.5k-token skill catalogue sitting in the middle — does the range it chooses
 * ever violate a session-layer invariant?
 *
 * Every simulated turn runs the same checks the session layer runs, and one
 * violation aborts that session with its id and turn number. A planner that is
 * "usually right" would produce sessions that fail to re-open, so partial
 * correctness is not a useful outcome here.
 *
 * Usage:
 *   node foldsim.mjs [--sessions N] [--retain TOKENS] [--budget TOKENS]
 */

import { findArtifacts, readSession } from "../../dsh-memory-v0/lib/log.mjs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BARRIER_KINDS, makeKindFilter } from "../lib/admit.js";
import { distillTurn, segmentAnchor } from "../lib/distill.js";
import { balanceOf, describeNode, isBarrier, planFold } from "../lib/fold.js";
import { priceMessage, priceString } from "../lib/pricing.js";
import { VOLATILE_BUDGET, mergeNodes, renderZoneTree, trimToBudget } from "../lib/tree.js";

const SESSIONS_ROOT =
  process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), ".dsh", "sessions");
const BARRIERS = new Set(DEFAULT_BARRIER_KINDS);
const ADMIT = makeKindFilter(["user", "agent-message", "goal"]);
const SURFACE_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

/**
 * Parse `--key value` flags.
 * @param {string[]} argv - process args.
 * @returns {Record<string, string|number|boolean>} flags.
 */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = Number.isNaN(Number(value)) ? value : Number(value);
      index += 1;
    }
  }
  return out;
}

/**
 * Build seq-indexed lookups in one pass.
 *
 * Done up front because the naive version — scanning all events per node — is
 * O(events x nodes) and takes minutes on a 20k-event session. Everything below
 * reads from these maps.
 *
 * @param {object[]} events - session events, ascending by seq.
 * @returns {{message: Map<number, object>, type: Map<number, string>, turn: Map<number, number>}} lookups.
 */
function indexEvents(events) {
  const message = new Map();
  const type = new Map();
  const turn = new Map();
  let current = null;
  for (const event of events) {
    if (event.type === "turn/start" && typeof event.data?.turn === "number") current = event.data.turn;
    if (current !== null) turn.set(event.seq, current);
    type.set(event.seq, event.type);
    const derived = event.type === "user/message" ? event.data : event.data?.message;
    if (derived && typeof derived === "object" && derived.role) message.set(event.seq, derived);
  }
  return { message, type, turn };
}

/**
 * Replay one session, folding at each turn boundary.
 * @param {string} file - session artifact path.
 * @param {object} options - simulation options.
 * @returns {object} per-session result.
 */
function simulate(file, options) {
  const { header, events } = readSession(file);
  const sessionId = header?.id ?? file;
  const index = indexEvents(events);
  /**
   * Checkpoint messages created by folds, keyed by the seq they occupy.
   * They are not in the log (this is a simulation), so the lookups miss them and
   * their cost would vanish from every later turn's surface total — the one number
   * the whole design is judged on.
   */
  const virtual = new Map();

  /** Surface node seqs, in order. Rewritten by folds, so later turns see them. */
  let nodes = [];
  let carried = [];
  const turns = [];
  const violations = [];
  let turnNumber = null;

  for (const event of events) {
    if (event.type === "turn/start" && typeof event.data?.turn === "number") turnNumber = event.data.turn;

    if (event.type === "turn/end") {
      foldAtBoundary(event.seq);
      continue;
    }
    if (!SURFACE_TYPES.has(event.type)) continue;
    applySurface(nodes, event);
  }

  /**
   * Price the current surface, plan a fold, and apply it.
   *
   * A closure rather than an inline block because `turn/end` is not a surface
   * type: the loop must dispatch on it before the surface filter, else every turn
   * is silently skipped (which is exactly what the first run did).
   * @param {number} boundarySeq - seq of the `turn/end` event, reused as the
   *   checkpoint's node token so the surface stays a flat list of seqs.
   * @returns {void}
   */
  function foldAtBoundary(boundarySeq) {
    const described = nodes.map((seq, position) => {
      const simulated = virtual.get(seq);
      const message = simulated?.message ?? index.message.get(seq) ?? null;
      return describeNode({
        seq,
        type: simulated?.type ?? index.type.get(seq) ?? "unknown",
        message,
        turn: index.turn.get(seq) ?? null,
        tokens: priceMessage(message),
        index: position,
      });
    });

    const plan = planFold({
      nodes: described,
      barriers: BARRIERS,
      retainTokens: options.retain,
      minNodesToFold: 2,
    });

    if (plan.skip) {
      turns.push({ turn: turnNumber, skip: plan.skip, surface: total(described) });
      return;
    }

    const problems = checkInvariants(described, plan);
    if (problems.length > 0) {
      violations.push({ turn: turnNumber, problems });
      return;
    }

    const segment = `s${plan.startSeq}`;
    const fresh = [];
    if (!carried.some((node) => node.id === segment)) {
      const material = materialForRange(described, plan, index.message);
      const children = distillTurn({ segment, turn: material.turn, ...material });
      if (children.length > 0) {
        const count =
          material.userMessages.length + material.assistantMessages.length + material.toolResults.length;
        fresh.push(segmentAnchor(segment, material.turn, plan.startSeq, count), ...children);
      }
    }

    const merged = mergeNodes(carried, fresh, turnNumber ?? 0);
    const trimmed = trimToBudget(merged, options.budget, (node) =>
      priceString(`${node.title}\n${node.body}`),
    );

    let rendered = "";
    try {
      rendered = renderZoneTree(trimmed.kept, { depth: 3, origin: "memory" });
    } catch (error) {
      violations.push({ turn: turnNumber, problems: [String(error?.message ?? error)] });
      return;
    }

    carried = trimmed.kept;
    const checkpointTokens = rendered === "" ? 0 : priceString(rendered);
    turns.push({
      turn: turnNumber,
      fold: true,
      range: plan.endIndex - plan.startIndex + 1,
      shadowed: plan.shadowedTokens,
      kept: trimmed.kept.length,
      dropped: trimmed.dropped.length,
      checkpoint: checkpointTokens,
      retained: plan.endIndex + 1 < described.length ? total(described.slice(plan.endIndex + 1)) : 0,
    });

    // Fold the surface the way the session layer will: the range collapses into
    // one node holding the checkpoint message. The node's seq is the boundary
    // event's, and the message is registered as virtual so later turns price it.
    virtual.set(boundarySeq, {
      type: "user/message",
      message: { role: "user", content: [{ type: "text", text: rendered }] },
    });
    nodes = [...nodes.slice(0, plan.startIndex), boundarySeq, ...nodes.slice(plan.endIndex + 1)];
  }

  return { sessionId, turns, violations };
}

/**
 * Gather the material of a fold range.
 * @param {object[]} described - described nodes.
 * @param {object} plan - fold plan.
 * @param {Map<number, object>} messageOf - seq to message.
 * @returns {{turn: number, userMessages: object[], assistantMessages: object[], toolResults: object[]}} material.
 */
function materialForRange(described, plan, messageOf) {
  const userMessages = [];
  const assistantMessages = [];
  const toolResults = [];
  let turn = 0;
  for (let position = plan.startIndex; position <= plan.endIndex; position += 1) {
    const node = described[position];
    if (turn === 0 && typeof node.turn === "number") turn = node.turn;
    const message = messageOf.get(node.seq);
    if (!message) continue;
    if (node.type === "user/message") userMessages.push(message);
    else if (node.type === "assistant/message") assistantMessages.push(message);
    else if (node.type === "tool/result") {
      toolResults.push({
        callId: message.toolCallId,
        name: message.toolName ?? "tool",
        ok: message.isError !== true,
        text: textOf(message),
      });
    }
  }
  return { turn, userMessages, assistantMessages, toolResults };
}

/**
 * Session-layer invariants a fold range must satisfy.
 * @param {object[]} described - described nodes.
 * @param {object} plan - fold plan.
 * @returns {string[]} violations, empty when legal.
 */
function checkInvariants(described, plan) {
  const problems = [];
  if (plan.startIndex === 0) problems.push("range starts at node 0");
  for (let position = plan.startIndex; position <= plan.endIndex; position += 1) {
    const node = described[position];
    if (isBarrier(node, BARRIERS)) {
      problems.push(`range covers barrier ${node.sourceKind} at index ${position}`);
      break;
    }
  }
  const balance = balanceOf(described, plan.startIndex, plan.endIndex);
  if (balance !== 0) problems.push(`tool pairing unbalanced by ${balance}`);
  const seqs = described.slice(plan.startIndex, plan.endIndex + 1).map((node) => node.seq);
  if (new Set(seqs).size !== seqs.length) problems.push("shadowed seqs contain duplicates");
  // No ascendancy check on purpose. `assertSourceEventReferences` in
  // dsh-session/lib/types/surface.js:230 verifies that every seq is a safe
  // integer, that none repeat, that all reference earlier events, and that the
  // list covers every shadowed surface node — it never compares neighbours.
  // Surface order stops being seq-monotonic the moment a `replace` lands a fresh
  // checkpoint (highest seq so far) ahead of a retained tail (lower seqs), so an
  // ascendancy invariant would reject the shape v1 itself produces.
  return problems;
}

/**
 * Collect one turn's distillation material.
 * @param {object[]} described - described nodes.
 * @param {number} turn - turn number.
 * @param {Map<number, object>} messageOf - seq to message.
 * @returns {{turn: number, userMessages: object[], assistantMessages: object[], toolResults: object[]}} material.
 */
function materialFor(described, turn, messageOf) {
  const userMessages = [];
  const assistantMessages = [];
  const toolResults = [];
  for (const node of described) {
    if (node.turn !== turn) continue;
    const message = messageOf.get(node.seq);
    if (!message) continue;
    if (node.type === "user/message") userMessages.push(message);
    else if (node.type === "assistant/message") assistantMessages.push(message);
    else if (node.type === "tool/result") {
      toolResults.push({
        callId: message.toolCallId,
        name: message.toolName ?? "tool",
        ok: message.isError !== true,
        text: textOf(message),
      });
    }
  }
  return { turn, userMessages, assistantMessages, toolResults };
}

/**
 * Apply one surface event to the node list.
 * @param {number[]} nodes - node seqs, mutated in place.
 * @param {object} event - session event.
 */
function applySurface(nodes, event) {
  const op = event.surfaceOp;
  if (!op || op === "append" || op?.op !== "replace") {
    nodes.push(event.seq);
    return;
  }
  const start = nodes.indexOf(op.startSeq);
  const end = nodes.indexOf(op.endSeq);
  if (start === -1 || end === -1) {
    // A stale replace is a session-layer error, not a planner one; record it by
    // appending so the simulation keeps going and the invariant check reports it.
    nodes.push(event.seq);
    return;
  }
  nodes.splice(start, end - start + 1, event.seq);
}

/**
 * Concatenate a message's text blocks.
 * @param {object} message - model message.
 * @returns {string} text.
 */
function textOf(message) {
  let text = "";
  for (const block of message?.content ?? []) if (block?.type === "text") text += block.text;
  return text;
}

/**
 * Sum tokens over described nodes.
 * @param {object[]} described - described nodes.
 * @returns {number} tokens.
 */
function total(described) {
  return described.reduce((sum, node) => sum + (node.tokens ?? 0), 0);
}

/**
 * Percentile of an ascending array.
 * @param {number[]} sorted - values.
 * @param {number} q - quantile in [0,1].
 * @returns {number} value.
 */
function pct(sorted, q) {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[position];
}

const options = {
  retain: Number(process.argv.includes("--retain") ? process.argv[process.argv.indexOf("--retain") + 1] : 20000),
  budget: Number(process.argv.includes("--budget") ? process.argv[process.argv.indexOf("--budget") + 1] : VOLATILE_BUDGET),
};
const sessionLimit = process.argv.includes("--sessions")
  ? Number(process.argv[process.argv.indexOf("--sessions") + 1])
  : Infinity;

const files = findArtifacts(SESSIONS_ROOT).slice(0, sessionLimit);
const results = [];
for (const file of files) {
  try {
    results.push(simulate(file, options));
  } catch (error) {
    results.push({ sessionId: file, turns: [], violations: [String(error?.message ?? error)] });
  }
}

const bad = results.filter((result) => result.violations.length > 0);
const foldTurns = results.flatMap((result) => result.turns.filter((turn) => turn.fold));
const skips = {};
for (const result of results) {
  for (const turn of result.turns) if (turn.skip) skips[turn.skip] = (skips[turn.skip] ?? 0) + 1;
}

console.log(`sessions        ${results.length}`);
console.log(`retainTokens    ${options.retain}`);
console.log(`volatileBudget  ${options.budget}`);
console.log(`sessions folded ${results.filter((r) => r.turns.some((t) => t.fold)).length}`);
console.log(`fold turns      ${foldTurns.length}`);
console.log(`skips           ${JSON.stringify(skips)}`);
console.log(`violations      ${bad.length}`);

for (const result of bad.slice(0, 10)) {
  console.log(`  ${result.sessionId}: ${result.violations.slice(0, 3).map((v) => JSON.stringify(v)).join(" | ")}`);
}

if (foldTurns.length > 0) {
  const shadowed = foldTurns.map((turn) => turn.shadowed).sort((a, b) => a - b);
  const checkpoint = foldTurns.map((turn) => turn.checkpoint).sort((a, b) => a - b);
  const range = foldTurns.map((turn) => turn.range).sort((a, b) => a - b);
  const kept = foldTurns.map((turn) => turn.kept).sort((a, b) => a - b);
  console.log(`shadowed tok    P50 ${pct(shadowed, 0.5)}  P95 ${pct(shadowed, 0.95)}  max ${shadowed.at(-1)}`);
  console.log(`checkpoint tok  P50 ${pct(checkpoint, 0.5)}  P95 ${pct(checkpoint, 0.95)}  max ${checkpoint.at(-1)}`);
  console.log(`nodes folded    P50 ${pct(range, 0.5)}  P95 ${pct(range, 0.95)}  max ${range.at(-1)}`);
  console.log(`nodes kept      P50 ${pct(kept, 0.5)}  P95 ${pct(kept, 0.95)}  max ${kept.at(-1)}`);
}

process.exit(bad.length > 0 ? 1 : 0);
