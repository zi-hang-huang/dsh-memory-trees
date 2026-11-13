/**
 * Replay a real session log through the *pipeline* (not just the planner).
 *
 * The offline simulator drives `fold.js` directly, so it never exercises
 * `pipeline.js`. That gap is exactly what let a surface-shape bug reach a live
 * session: the simulator stores bare seqs, the planner accepts whatever it is
 * given, and only the pipeline read `.seq`/`.type` off them. This harness closes
 * it by giving the pipeline a session double backed by a real log.
 *
 * The double is deliberately strict: it rejects a replace that would shadow node 0
 * or leave a shadowed node uncited, which are the two rules `dsh-session` enforces
 * on every append. A plugin that violates either one has its step refused in
 * production, so it must fail here too.
 *
 * Usage: node sim/replay.mjs <session.v4.jsonl.zstd> [retainTokens]
 */
import { readSession } from "../../dsh-memory-v0/lib/log.mjs";
import { priceMessage } from "../lib/pricing.js";
import { createFilters, createStats, foldIfNeeded, publishSelf } from "../lib/pipeline.js";

const file = process.argv[2];
const retainTokens = Number(process.argv[3] ?? 20000);
if (!file) {
  console.error("usage: node sim/replay.mjs <session file> [retainTokens]");
  process.exit(2);
}

const { header, events } = readSession(file);
const bySeq = new Map(events.map((event) => [event.seq, event]));

const derive = (event) => {
  if (!event) return null;
  if (event.type === "user/message") return event.data;
  return event.data?.message ?? null;
};

/** Surface in model-visible order, exactly as `dsh-session` maintains it. */
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

const appended = [];
let nextSeq = events.length;

const session = {
  get surface() {
    return { nodes };
  },
  // Only surface seqs are ever queried, and every surface seq is either a log
  // event already walked or an append, so there is no lookahead to leak.
  eventAt: (seq) => bySeq.get(seq) ?? null,
  deriveEventMessage: (event) => derive(event),
  append(type, data, intent) {
    const seq = nextSeq;
    nextSeq += 1;
    const event = { seq, type, data, surfaceOp: intent?.surfaceOp, sourceEventSeqs: intent?.sourceEventSeqs };
    appended.push(event);
    bySeq.set(seq, event);

    const op = intent?.surfaceOp;
    if (op === "append") {
      nodes.push(seq);
      return event;
    }
    if (op && typeof op === "object" && op.op === "replace") {
      const start = nodes.indexOf(op.startSeq);
      const end = nodes.indexOf(op.endSeq);
      if (start < 0) throw new Error(`replay: replace startSeq ${op.startSeq} not in surface`);
      if (end < start) throw new Error(`replay: replace endSeq ${op.endSeq} not in surface`);
      if (start === 0) throw new Error("replay: replace would shadow node 0 (the system prompt)");
      const cited = intent.sourceEventSeqs ?? [];
      if (new Set(cited).size !== cited.length) throw new Error("replay: sourceEventSeqs repeats");
      for (const shadowed of nodes.slice(start, end + 1)) {
        if (!cited.includes(shadowed)) throw new Error(`replay: uncited shadowed node ${shadowed}`);
      }
      for (const seq of cited) {
        if (seq >= event.seq) throw new Error(`replay: cited seq ${seq} is not an earlier event`);
      }
      nodes.splice(start, end - start + 1, seq);
      return event;
    }
    return event;
  },
};

const agent = { session };
let steps = 0;
let failures = 0;
let maxSurface = 0;
const surfaceSizes = [];

for (const event of events) {
  const op = event.surfaceOp;
  if (op === "append") nodes.push(event.seq);
  else if (op && typeof op === "object" && op.op === "replace") {
    const start = nodes.indexOf(op.startSeq);
    const end = nodes.indexOf(op.endSeq);
    if (start >= 0 && end >= start) nodes.splice(start, end - start + 1, event.seq);
  }
  if (event.type !== "turn/end") continue;

  try {
    await foldIfNeeded(agent, undefined, { ...filters, config, stats });
    publishSelf(agent, stats, null);
    steps += 1;
  } catch (error) {
    failures += 1;
    console.error(`  ! step after turn/end seq ${event.seq} threw: ${error.message}`);
  }

  const tokens = nodes.reduce((sum, seq) => sum + priceMessage(derive(bySeq.get(seq))), 0);
  surfaceSizes.push(tokens);
  maxSurface = Math.max(maxSurface, tokens);
}

const selfs = nodes.filter((seq) => derive(bySeq.get(seq))?.source?.kind === "memory:self");
const checkpoints = nodes.filter((seq) => derive(bySeq.get(seq))?.source?.kind === "memory");

const pct = (xs, p) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

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
console.log(`self copies      ${selfs.length}   checkpoints ${checkpoints.length}`);
