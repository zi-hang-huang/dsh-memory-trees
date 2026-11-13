/**
 * Why did a fold get skipped? Replays a session and dumps the planner's view at
 * every `turn/end`, so a `too-few-nodes` result can be attributed to a concrete
 * cause (a barrier at the wrong place, a zero-priced surface, a tail that already
 * covers everything) instead of being guessed at.
 *
 * Usage: node sim/diag.mjs <session.v4.jsonl.zstd> [retainTokens]
 */
import { readSession } from "../../dsh-memory-v0/lib/log.mjs";
import { describeNode, firstFoldableIndex, planFold, retainedTailStart } from "../lib/fold.js";
import { priceMessage } from "../lib/pricing.js";

const file = process.argv[2];
const retainTokens = Number(process.argv[3] ?? 20000);
const { events } = readSession(file);
const bySeq = new Map(events.map((event) => [event.seq, event]));

const derive = (event) => {
  if (!event) return null;
  if (event.type === "user/message") return event.data;
  return event.data?.message ?? null;
};

const BARRIERS = new Set(["skill-catalog", "agent-instructions"]);
const nodes = [];
let step = 0;

for (const event of events) {
  const op = event.surfaceOp;
  if (op === "append") nodes.push(event.seq);
  else if (op && typeof op === "object" && op.op === "replace") {
    const start = nodes.indexOf(op.startSeq);
    const end = nodes.indexOf(op.endSeq);
    if (start >= 0 && end >= start) nodes.splice(start, end - start + 1, event.seq);
  }
  if (event.type !== "turn/end") continue;

  step += 1;
  const described = nodes.map((seq, index) =>
    describeNode({
      seq,
      type: bySeq.get(seq)?.type ?? "unknown",
      message: derive(bySeq.get(seq)),
      tokens: priceMessage(derive(bySeq.get(seq))),
      index,
    }),
  );

  const total = described.reduce((sum, node) => sum + node.tokens, 0);
  const first = firstFoldableIndex(described, BARRIERS);
  const tailStart = first === -1 ? -1 : retainedTailStart(described, retainTokens, first);
  const plan = planFold({ nodes: described, barriers: BARRIERS, retainTokens, minNodesToFold: 2 });

  const zero = described.filter((node) => node.tokens === 0).length;
  const barrierAt = [];
  for (let index = 0; index < described.length; index += 1) {
    if (described[index].sourceKind && BARRIERS.has(described[index].sourceKind)) barrierAt.push(index);
  }

  console.log(
    `step ${String(step).padStart(2)}  nodes ${String(described.length).padStart(5)}  tok ${String(Math.round(total)).padStart(7)}  ` +
      `zero ${String(zero).padStart(5)}  first ${String(first).padStart(5)}  tailStart ${String(tailStart).padStart(5)}  ` +
      `barriers@[${barrierAt.slice(0, 6).join(",")}]  => ${plan.skip ?? `fold ${plan.startIndex}..${plan.endIndex} (${Math.round(plan.shadowedTokens)} tok)`}`,
  );

  if (step === 2 && plan.skip) {
    console.log("\n  nodes around `first`:");
    for (let index = Math.max(0, first - 2); index < Math.min(described.length, first + 8); index += 1) {
      const node = described[index];
      console.log(
        `    [${index}] seq ${node.seq} ${node.type} kind=${node.sourceKind} tok=${node.tokens} delta=${node.toolCallDelta}`,
      );
    }
    console.log("\n  last 6 nodes (tail):");
    for (let index = Math.max(0, described.length - 6); index < described.length; index += 1) {
      const node = described[index];
      console.log(
        `    [${index}] seq ${node.seq} ${node.type} kind=${node.sourceKind} tok=${node.tokens} delta=${node.toolCallDelta}`,
      );
    }
  }
}
