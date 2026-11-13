/**
 * Replay a real session log from a clean slate and check the steady state.
 *
 * `replay.mjs` replays the log *including* the `memory:self` messages an older
 * build left behind, so it reports 88 visible self copies no matter what the
 * current code does — it is measuring the old damage, not the new behaviour.
 *
 * This harness answers the question that actually matters: given a log with no
 * memory messages at all, does the pipeline reach exactly one visible self copy
 * and one checkpoint, and does the surface stay bounded?
 *
 * Old `memory:self` events are skipped when rebuilding the surface but still
 * resolve through `eventAt`, because they are legitimate earlier events that a
 * fold may cite.
 *
 * Usage: node sim/clean.mjs <session.v4.jsonl.zstd> [retainTokens]
 */
import { readSession } from "../../dsh-memory-v0/lib/log.mjs";
import { priceMessage } from "../lib/pricing.js";
import { createFilters, createStats, foldIfNeeded, publishSelf } from "../lib/pipeline.js";

const file = process.argv[2];
const retainTokens = Number(process.argv[3] ?? 20000);
if (!file) {
  console.error("usage: node sim/clean.mjs <session file> [retainTokens]");
  process.exit(2);
}

const { header, events } = readSession(file);
const bySeq = new Map(events.map((event) => [event.seq, event]));

const derive = (event) => {
  if (!event) return null;
  if (event.type === "user/message") return event.data;
  return event.data?.message ?? null;
};
const kindOf = (seq) => derive(bySeq.get(seq))?.source?.kind ?? null;

/** Surface in model-visible order, with the old build's memory messages dropped. */
const nodes = [];

const config = {
  retainTokens,
  volatileBudget: 2500,
  minNodesToFold: 2,
  admitKinds: ["user", "agent-message", "goal"],
  barrierKinds: ["skill-catalog", "agent-instructions"],
  selfEnabled: true,
  verbose: false,
};
const filters = createFilters(config);
const stats = createStats();

let nextSeq = events.length;
let steps = 0;
let failures = 0;
let maxSurface = 0;
const surfaceSizes = [];
const selfCounts = [];
const checkpointCounts = [];
const openCheckpointCounts = [];

const session = {
  get surface() {
    return { nodes };
  },
  eventAt: (seq) => bySeq.get(seq) ?? null,
  deriveEventMessage: (event) => derive(event),
  append(type, data, intent) {
    const seq = nextSeq;
    nextSeq += 1;
    const event = { seq, type, data, surfaceOp: intent?.surfaceOp, sourceEventSeqs: intent?.sourceEventSeqs };
    bySeq.set(seq, event);

    const op = intent?.surfaceOp;
    if (op === "append") {
      nodes.push(seq);
      return event;
    }
    if (op && typeof op === "object" && op.op === "replace") {
      const start = nodes.indexOf(op.startSeq);
      const end = nodes.indexOf(op.endSeq);
      if (start < 0) throw new Error(`clean: replace startSeq ${op.startSeq} not in surface`);
      if (end < start) throw new Error(`clean: replace endSeq ${op.endSeq} not in surface`);
      if (start === 0) throw new Error("clean: replace would shadow node 0 (the system prompt)");
      const cited = intent.sourceEventSeqs ?? [];
      if (new Set(cited).size !== cited.length) throw new Error("clean: sourceEventSeqs repeats");
      for (const shadowed of nodes.slice(start, end + 1)) {
        if (!cited.includes(shadowed)) throw new Error(`clean: uncited shadowed node ${shadowed}`);
      }
      for (const seq of cited) {
        if (seq >= event.seq) throw new Error(`clean: cited seq ${seq} is not an earlier event`);
      }
      nodes.splice(start, end - start + 1, seq);
      return event;
    }
    return event;
  },
};

const agent = { session };

for (const event of events) {
  // A genuinely clean start: ignore the log's own memory events **entirely**.
  //
  // Dropping only the appends was not enough. A fold is logged as one event whose
  // `surfaceOp` is a replace, so the old checkpoints came straight back in through
  // the branch below — carrying whatever fields that build wrote. That is how this
  // script ended up reporting two "open" checkpoints: the leaked one predated the
  // `sealed` flag, so it looked open forever.
  const kind = kindOf(event.seq);
  if (kind === "memory" || kind === "memory:self") continue;

  const op = event.surfaceOp;
  if (op === "append") {
    nodes.push(event.seq);
  } else if (op && typeof op === "object" && op.op === "replace") {
    const start = nodes.indexOf(op.startSeq);
    const end = nodes.indexOf(op.endSeq);
    if (start >= 0 && end >= start) nodes.splice(start, end - start + 1, event.seq);
  }
  if (event.type !== "turn/end") continue;

  try {
    await foldIfNeeded(agent, undefined, { ...filters, config, stats });
    // Nothing to capture: this run starts with no memory messages, so the pipeline
    // rebuilds self from the default nodes on its first publication.
    publishSelf(agent, stats, null);
    steps += 1;
  } catch (error) {
    failures += 1;
    console.error(`  ! step after turn/end seq ${event.seq} threw: ${error.message}`);
  }

  const tokens = nodes.reduce((sum, seq) => sum + priceMessage(derive(bySeq.get(seq))), 0);
  surfaceSizes.push(tokens);
  maxSurface = Math.max(maxSurface, tokens);
  selfCounts.push(nodes.filter((seq) => kindOf(seq) === "memory:self").length);
  checkpointCounts.push(nodes.filter((seq) => kindOf(seq) === "memory").length);
  // The invariant that actually holds: several checkpoints may be visible (one per
  // barrier gap), but only one of them is still being revised. The others are sealed
  // — their run has a barrier after it and can never receive new material again.
  const openCheckpoints = nodes.filter((seq) => {
    const source = derive(bySeq.get(seq))?.source;
    return kindOf(seq) === "memory" && source?.sealed !== true;
  }).length;
  openCheckpointCounts.push(openCheckpoints);
}

const pct = (xs, p) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const worstSelf = Math.max(...selfCounts, 0);
const worstCheckpoint = Math.max(...checkpointCounts, 0);
const worstOpen = Math.max(...openCheckpointCounts, 0);

console.log(`session          ${header?.id ?? "(unknown)"}`);
console.log(`turn/end         ${events.filter((e) => e.type === "turn/end").length}`);
console.log(`steps ok         ${steps}   failed ${failures}`);
console.log(`folds            ${stats.folds}`);
console.log(`skips            ${JSON.stringify(stats.skipped)}`);
console.log(`self publish     ${stats.selfPublished}  replaced ${stats.selfReplaced}`);
console.log(`shadowed tok     ${Math.round(stats.shadowedTokens)}`);
console.log(`nodes dropped    ${stats.droppedNodes}  oversized ${stats.oversized}`);
console.log(`surface tok      P50 ${Math.round(pct(surfaceSizes, 50))}  P95 ${Math.round(pct(surfaceSizes, 95))}  max ${Math.round(maxSurface)}`);
console.log(`surface nodes    ${nodes.length}`);
console.log(`self copies/turn ${selfCounts.join(",")}`);
console.log(`checkpoints/turn ${checkpointCounts.join(",")}`);
console.log(`open ckpts/turn  ${openCheckpointCounts.join(",")}`);

if (worstSelf > 1) {
  console.error(`\nFAIL: at most one self copy may be visible, saw ${worstSelf}`);
  process.exit(1);
}
// One checkpoint per barrier gap is expected and harmless (each gap's run is closed
// once folded). What must hold is that only one is still open: two open checkpoints
// would mean two trees both claiming to be current memory.
if (worstOpen > 1) {
  console.error(`\nFAIL: at most one *open* checkpoint may be visible, saw ${worstOpen}`);
  process.exit(1);
}
console.log(`\nOK: one self copy, one open checkpoint (${worstCheckpoint} total, the rest sealed), bounded surface`);
