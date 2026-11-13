// Backfill `sources[].seqRange` in the LTM store.
//
// The v10 seqRange writer anchored the span on plan.startSeq, which — whenever a fold
// began at the carried checkpoint — is that checkpoint's seq (a summary, and larger
// than the real content that follows). This rewrites each bad span to the min/max seq
// of the real content nodes, computed from the live session log.
//
// usage: node _backfill_seqrange.mjs [--apply]
import fs from "node:fs";
import zlib from "node:zlib";

const APPLY = process.argv.includes("--apply");
const HOME = process.env.USERPROFILE;
const STORE = `${HOME}\\.dsh\\storages\\dsh_memory.json`;
const LOG = `${HOME}\\.dsh\\sessions\\--D-document-FET-project_data-dsh-temple-deepseek-harness-default-workspace--\\session-9227cac5-ba30-440b-b417-0fa5dd5a2dd0\\session.v4.jsonl.zstd`;

// --- 1. decompress the multi-frame zstd session log ---
const buf = fs.readFileSync(LOG);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let offs = [];
let i = 0;
while (true) {
  const k = buf.indexOf(magic, i);
  if (k < 0) break;
  offs.push(k);
  i = k + 4;
}
offs.push(buf.length);
const parts = [];
for (let f = 0; f < offs.length - 1; f += 1) {
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(offs[f], offs[f + 1])).toString("utf8"));
  } catch {
    /* skip a corrupt frame; the rest still decode */
  }
}
const events = [];
for (const ln of parts.join("").split("\n")) {
  if (ln.length < 6) continue;
  let o;
  try {
    o = JSON.parse(ln);
  } catch {
    continue;
  }
  if (typeof o.seq === "number") events.push(o);
}
const bySeq = new Map(events.map((o) => [o.seq, o]));
const kindOf = (seq) => {
  const o = bySeq.get(seq);
  if (!o) return "(missing)";
  const m = (o.data && (o.data.message || o.data)) || {};
  return (m.source && m.source.kind) || (o.data && o.data.source && o.data.source.kind) || "-";
};
const folds = events.filter((o) => o.surfaceOp && o.surfaceOp.op === "replace");
const findFold = (a, b) =>
  folds.find((o) => {
    const s = o.sourceEventSeqs || [];
    return s.includes(a) && s.includes(b);
  }) || folds.find((o) => o.surfaceOp.startSeq === a && o.surfaceOp.endSeq === b);

// --- 2. walk the store and rewrite bad spans ---
const doc = JSON.parse(fs.readFileSync(STORE, "utf8"));
const records = Object.values(doc.tables.records);
const changes = [];
for (const rec of records) {
  for (const src of rec.sources || []) {
    if (!Array.isArray(src.seqRange) || src.seqRange.length !== 2) continue;
    const [a, b] = src.seqRange;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const fold = findFold(a, b);
    if (!fold) {
      changes.push({ id: rec.id, from: [a, b], to: null, note: "no fold op found — left untouched" });
      continue;
    }
    const content = (fold.sourceEventSeqs || []).filter((s) => kindOf(s) !== "memory");
    if (content.length === 0) continue;
    const lo = Math.min(...content);
    const hi = Math.max(...content);
    if (lo !== a || hi !== b) {
      changes.push({ id: rec.id, from: [a, b], to: [lo, hi], wasCheckpointStart: kindOf(a) === "memory" });
      if (APPLY) {
        src.seqRange = [lo, hi];
        rec.rev = (rec.rev || 1) + 1;
      }
    }
  }
}

console.log(`mode=${APPLY ? "APPLY" : "dryRun"}  records=${records.length}  changes=${changes.length}`);
for (const c of changes) {
  console.log(`  ${c.id}  [${c.from}] -> ${c.to ? "[" + c.to + "]" : "(unchanged)"}  ${c.note ?? ""}`);
}

if (APPLY && changes.some((c) => c.to)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${STORE}.bak-seqrange-${stamp}`;
  fs.copyFileSync(STORE, backup);
  fs.writeFileSync(STORE, JSON.stringify(doc));
  console.log(`\napplied. backup: ${backup}`);
  console.log(`new file size: ${fs.statSync(STORE).size}`);
}
