/**
 * dsh-memory — v1: fold the surface at step boundaries, replace it with memory.
 *
 * What this plugin does, in one paragraph: at the start of each step it distils the
 * history that is about to fall out of a token window into memory nodes, folds that
 * range out of the model's view, and puts the nodes back as a single `user/message`
 * replacing exactly that range. The model then sees
 * `system prompt + <memory>…</memory> + recent turns` instead of a transcript that
 * grows without bound.
 *
 * Three decisions shape the code and are not obvious from reading it:
 *
 * 1. **The tree lives in the log, not in a store.** Each checkpoint message carries
 *    its own node array in `message.source`. Resuming or forking a session recovers
 *    the memory by reading the surface — no separate persistence, no way for the two
 *    to disagree. Plan D5 (write memory before replacing context) becomes
 *    structurally impossible to violate: the write and the replace are one event. A
 *    storage-backed variant arrives with LTM in v4, where the tree must outlive the
 *    session.
 *
 * 2. **The fold happens in `agent/pre-step`, not in a `turn/end` listener.**
 *    pre-step fires before the request is assembled, which is the last moment a
 *    replace can still affect the request; appending events while the loop is
 *    closing a turn is exactly what the session layer guards against. Compaction
 *    folds at the same point (`dsh-compaction-basic` registers the same hook), so
 *    this is an established seam rather than a workaround.
 *
 * 3. **No new session event types.** The session's known-event set is closed and a
 *    live `append()` cannot set the `ignorable` flag that would let an unknown type
 *    survive a re-open. Everything here is expressed with `user/message` +
 *    `surfaceOp`, which is what compaction itself does.
 *
 * Compatibility: this plugin drives compression through the same surface-replace
 * channel compaction engines use. Running it alongside another memory/compaction
 * plugin (billion-context's gate, for example) can leave both claiming the same
 * lane, in which case one of them silently does not take effect. Nothing is
 * corrupted — the other one just wins — but the effect is invisible unless the logs
 * are read, so treat the two as alternatives rather than layers.
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  captureSelfNodes,
  createFilters,
  createStats,
  currentUserText,
  foldIfNeeded,
  makeRecallMessage,
  publishSelf,
} from "./pipeline.js";
import { createRecallTool } from "./recall-tool.js";
import { createFetchTool } from "./fetch-tool.js";
import { createSaveTool } from "./save-tool.js";
// `recall` is the same pure ranker `memory_recall` uses; the pre-step block now runs it
// over the LTM store directly so a new session can recall across sessions.
import { recall as runRecall } from "./recall.js";
import { runPromotePass, diffForWrite } from "./promote-runner.js";
import { mergeLtm, applyWorkNames, applyWorkSummaries, applyWorkSplit } from "./promote.js";
import { extractWork } from "./work.js";
import {
  renderWorkGroup,
  buildWorkNamingInstruction,
  parseWorkNames,
  renderWorkMembers,
  buildWorkSummaryInstruction,
  parseWorkSummary,
  renderWorkForMerge,
  buildWorkMergeInstruction,
  renderWorkForSplit,
  buildWorkSplitInstruction,
  parseWorkSplit,
  normalizeSplitPlan,
} from "./work-name.js";
import { readAllRecords, readSearchableRecords, applyWriteDiff } from "./ltm-store.js";
import { buildLtmDomainSpecPlain } from "./ltm-domain.js";
import { SELF_SOURCE_KIND } from "./self.js";
import { readSelfState, selfView, resetSelfOverride, writeSelfOverride } from "./self-store.js";
import { startLtmViewServer } from "./ltm-view.js";
import { buildContextDetail } from "./context-detail.js";
import { RECALL_DEFAULTS, buildRecallQuery, fetchCandidates, recallFromCandidates, toCandidate } from "./session-recall.js";

export const name = "dsh-memory";

/**
 * v8-b: cwd-based naming is DEPRECATED. A live test (2026-11-07) proved it unusable:
 * the desktop plugin process's cwd is the app's own directory (`...\desktop`), not the
 * user's workspace, so every record collapsed into `work:desktop` and two unrelated
 * sessions were merged. We no longer take a name from cwd; the hot path uses a per-session
 * temporary work key (below) and a background pass renames it from content (refineWork).
 *
 * Kept as a stub returning "" so the call site reads as "no rule-based name" rather than
 * silently picking the wrong thing. Do NOT restore cwd naming.
 *
 * @returns {string} always "" (deprecated).
 */
function projectNameFromCwd() {
  return "";
}

/**
 * v8: short stable id from a session id, used as the work-key fallback when no project
 * name is available. Prefer the trailing segment (session ids are often `<prefix>-<rand>`).
 * @param {string|undefined} sessionId - session id.
 * @returns {string|undefined} short token, or undefined.
 */
function shortSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  const tail = sessionId.split(/[-_]/).filter((p) => p !== "");
  return tail[tail.length - 1] ?? sessionId;
}

/**
 * Services this plugin reads. All are loaded before `agent` in dsh-base.
 *
 * `sessions` (plural) is the session registry service — `ctx.sessions.fork()`,
 * `ctx.sessions.registerMessageProjection()`. Writing `session` here makes Cordis
 * park the whole entry with `pending (waiting for service: session)` and the
 * plugin silently never activates.
 *
 * `llm` is REQUIRED even though v2 ships disabled. Cordis resolves a service by
 * checking `prop in fiber.inject`, so touching `ctx.llm` without declaring it throws
 * `cannot get property "llm" without inject` — inside `agent/pre-step`, where the
 * plugin's own catch swallowed it. The result was a plugin whose tools registered
 * fine while every fold silently aborted: `folds: 0 / selfPublished: 0` with an
 * empty `skipped`, which looked exactly like "the session was too short". Declaring
 * it is the fix; v2 being off is a config decision, not a reason to leave the
 * dependency undeclared.
 */
export const inject = ["tools", "sessions", "llm"];

export { MEMORY_SOURCE_KIND } from "./pipeline.js";
/** Reasons a fold is declined; mirrored from `fold.js` for logging. */
export { FOLD_SKIP } from "./fold.js";
export { SELF_SOURCE_KIND } from "./self.js";

/**
 * Plugin configuration.
 *
 * Every field is required on purpose: schemastery treats a missing required field
 * as a load failure, which is louder than defaulting an omitted budget to
 * something wrong. The defaults live in `cordis.patch.yml` so a user can see and
 * change them without knowing schemastery.
 *
 * v11: `Config` is {@link ConfigSchema} with {@link LIVE_FIELDS} re-marked
 * `.volatile()`, so the DSH Settings page can edit them live. See
 * {@link unwrapVolatileConfig} for why the plugin body must not see the raw
 * resolved object once that happens.
 */

/** Fields a user may tune from the Settings page without a plugin reload. */
const LIVE_FIELDS = [
  "retainTokens",
  "volatileBudget",
  "recallEnabled",
  "recallTopK",
  "distillPolicy",
  "selfEnabled",
  "verbose",
];

/**
 * Read one config field as a plain value, unwrapping a Loader `Volatile` ref.
 *
 * A cosmokit `Volatile` is a bare object whose only enumerable own key is
 * `get` (its write handle is a Symbol we never touch), so this structural test
 * is exact and needs no extra import: a plain config value for these fields is
 * always a number/boolean/string, never an object with a lone `get` function.
 * @param {any} value raw `config[key]` (a plain value or a `Volatile` wrapper).
 * @returns {any} the underlying value.
 */
function readLive(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "get") return value.get();
  }
  return value;
}

/**
 * Project the resolved config onto a plain object whose live fields read through
 * {@link readLive} and whose other fields are copied as-is.
 *
 * The Loader WRAPS a volatile field's parsed value in a cosmokit `Volatile`
 * reference (`{ get() }`), so without this `config.retainTokens` would be an
 * object and every comparison/arithmetic below would silently misbehave. The
 * getters keep `config` a read-only plain view for the rest of `apply` — the
 * ~100 existing `config.x` reads stay untouched.
 * @param {any} config resolved {@link Config} (possibly holding volatile refs).
 * @returns {any} a read-only view safe for the plugin body.
 */
function unwrapVolatileConfig(config) {
  const view = {};
  for (const key of Object.keys(config ?? {})) {
    if (LIVE_FIELDS.includes(key)) {
      Object.defineProperty(view, key, { get: () => readLive(config[key]), enumerable: true });
    } else {
      view[key] = config[key];
    }
  }
  return view;
}

/** Re-mark {@link LIVE_FIELDS} on a schema so the settings service exposes them. */
function withLiveFields(schema) {
  const dict = schema.dict ?? {};
  const live = {};
  for (const key of LIVE_FIELDS) if (dict[key] !== undefined) live[key] = dict[key].volatile();
  return z.object({ ...dict, ...live });
}

/**
 * This plugin's own Loader row id (the settings form's namespace).
 *
 * DSH 0.1.7 addresses every settings form by the profile entry id, so the page
 * transport must write to that id rather than a package name. Mirrors
 * dsh-better-sidebar's resolver: prefer the row mounted from THIS fiber, and
 * fall back to a unique enabled row of the same package name.
 * @param {any} ctx host plugin context.
 * @returns {string | undefined} the row id, or undefined when none is found.
 */
function ownEntryId(ctx) {
  let fallback;
  try {
    for (const entry of ctx.loader.entries()) {
      const id = entry.options.id;
      if (entry.options.name !== "dsh-memory" || typeof id !== "string" || id === "") continue;
      if (entry.fiber === ctx.fiber) return id;
      if (entry.disabled !== true && fallback === undefined) fallback = id;
    }
  } catch {
    return;
  }
  return fallback;
}

/** Project one settings value onto {@link LIVE_FIELDS} (undefined when absent). */
function pickLive(value) {
  const out = {};
  const src = value !== null && typeof value === "object" ? value : {};
  for (const key of LIVE_FIELDS) out[key] = src[key];
  return out;
}

const ConfigSchema = z.object({
  /** Token budget for the verbatim tail. The single user-facing trade-off. */
  retainTokens: z.number().required(),
  /** Token budget for the volatile (short-term) zone. */
  volatileBudget: z.number().required(),
  /** Refuse to fold fewer nodes than this; avoids churning a big checkpoint. */
  minNodesToFold: z.number().required(),
  /** `source.kind`s admitted into memory. Anything else is dropped. */
  admitKinds: z.array(z.string()).required(),
  /** `source.kind`s that must never be folded. */
  barrierKinds: z.array(z.string()).required(),
  /**
   * How much of a barrier kind to protect.
   *
   * `"newest"` (default) protects only the newest visible copy of each kind, because
   * the surface-aware plugins dedup against exactly that copy; older copies are stale
   * duplicates and stay foldable. `"all"` is the pre-2026-11-02 behaviour and exists
   * as a one-line rollback.
   */
  barrierPolicy: z.union([z.const("newest"), z.const("all")]).default("newest"),
  /**
   * Where memory nodes come from.
   *
   * `"rules"` (default) is v1: deterministic excerpting, no model call.
   * `"llm"` asks the routed model to distil a fold range, but only when the range is
   * at least `llmMinSpan` tokens — folding fires once per step, so asking on every
   * fold would roughly double the request count.
   */
  distillPolicy: z.union([z.const("rules"), z.const("llm")]).default("rules"),
  /** Minimum shadowed tokens before a model is asked. */
  llmMinSpan: z.number().default(4000),
  /** Node ceiling for one model distillation. */
  llmMaxNodes: z.number().default(8),
  /** Input ceiling: a fold bigger than this is summarised head+tail. */
  llmMaxInputTokens: z.number().default(12000),
  /** Wall-clock ceiling for one model distillation, in ms. */
  llmTimeoutMs: z.number().default(20000),
  /**
   * Minimum turns that must pass between two folds.
   *
   * Folding fires once per step, so a single long turn that appends many tool results
   * crosses `retainTokens` on every step: measured live, one turn folded 19 times, each
   * time re-distilling almost the same range (4.4k–5.6k chars, never shrinking). A
   * cooldown of 1 lets a turn fold at most once. `0` restores the per-step behaviour.
   */
  foldMinTurnGap: z.number().default(0),
  /** Publish the self tree as a `memory:self` message. */
  selfEnabled: z.boolean().required(),
  /**
   * v4 recall. `false` disables both the pre-step recall block and the
   * `memory_recall` tool — one switch, so they cannot disagree.
   */
  recallEnabled: z.boolean().required(),
  /** Token ceiling for the rendered recall block. plan D12: recall zone <= 1200. */
  recallBudget: z.number().required(),
  /** Candidates ranked before the budget trim. */
  recallTopK: z.number().required(),
  /** Family-expansion cap; 0 disables expansion. One hop only. */
  recallMaxExtra: z.number().required(),
  /**
   * Page size (chars) for `memory_fetch` (§7.7 ⑤c). Independent of `retainTokens` and
   * `volatileBudget`: a fetch is transient request text, not a surface node, so it does
   * not consume the short-term-memory budget. It DOES consume the request window, so the
   * cap must stay well under a fold's retain budget (a single huge fetch would otherwise
   * become a giant, foldable tool/result node — the §7.7 death loop). Default 6000.
   */
  fetchMaxChars: z.number().default(6000),
  /**
   * Allow the pre-step recall block to search THIS session's event log via
   * `ctx.sessionQuery`. Off by default: the search service only exists when
   * `dsh-session-query-sqlite` is mounted, and this build of cordis has no optional
   * inject, so the capability is discovered at runtime with `ctx.get(..., false)`.
   * When the service is absent the block is silently skipped — recall is an
   * optimisation, never a requirement.
   */
  sessionRecallEnabled: z.boolean().default(false),
  /** Log fold decisions to the plugin logger. */
  verbose: z.boolean().required(),

  // --- v3: long-term memory (LTM). Wired on by default but tolerant: if the host's
  // `storageDomain` service is absent (a profile without the storage stack), LTM is
  // silently disabled and recall falls back to the empty store — exactly the pre-v3
  // behaviour. These are all `.default()` so an existing `cordis.patch.yml` that does
  // not mention them still loads (adding a required key would fail the load).
  /** Enable promote-to-LTM and recall-from-LTM. */
  ltmEnabled: z.boolean().default(true),
  /** Node ceiling for the LTM store (promote-plan §G3). */
  ltmMaxNodes: z.number().default(500),
  /** Token ceiling for the LTM store. */
  ltmMaxTokens: z.number().default(200000),
  /** Minimum decision weight to promote (promote-plan §G2). */
  ltmMinWeight: z.number().default(0.5),
  /**
   * v8: enable work grouping. When on, promoted records get a `work` key (derived from
   * the project / cwd) and a work with ≥2 live records gets a lazy pivot node, so
   * "同一个工作中的几条信息" recall together. `false` restores exact pre-v8 behaviour
   * (no work key, no pivots) — a one-line rollback that needs no store migration.
   */
  workEnabled: z.boolean().default(true),
  /**
   * v8-b: enable the BACKGROUND work-name refinement pass. When on, temporary per-session
   * work keys are renamed from content by a fire-and-forget model call after promote, and
   * keys judged to be the same work are merged. Off ⇒ work keys stay per-session temporary
   * (never merged, but never mis-named either). Independent switch so refinement can be
   * disabled without turning off work grouping altogether.
   */
  workRefineEnabled: z.boolean().default(true),
  /**
   * Expose the `memory_save` tool: a direct, fold-independent way for the model to record
   * a durable fact into LTM. Default on; gated additionally by `ltmEnabled` (no store, no
   * save). Set `false` to keep LTM write-only via folding.
   */
  saveEnabled: z.boolean().default(true),
  /** Weight stamped on a `memory_save`d record when the caller passes none. */
  saveWeight: z.number().default(0.8),
});

/** Plugin config schema as the Loader sees it: {@link ConfigSchema} + live fields. */
export const Config = withLiveFields(ConfigSchema);

/**
 * Plugin entry.
 * @param {object} ctx - Cordis context.
 * @param {object} config - resolved {@link Config}.
 * @returns {void}
 */
export function apply(ctx, config) {
  // v11: the Loader hands over `Volatile` wrappers for the seven live fields
  // (see {@link unwrapVolatileConfig}); unwrap ONCE here so every `config.x`
  // read below keeps returning a plain value.
  config = unwrapVolatileConfig(config);
  // A window smaller than one self commit (~250 tokens) makes every step fold the
  // whole history and then republish the tree, which looks like churn and quietly
  // pays a full re-encode per step. Refusing to load is louder and cheaper to
  // diagnose than a log line nobody reads.
  if (config.retainTokens < 1_000) {
    throw new Error(
      `dsh-memory: retainTokens must be at least 1000 (got ${config.retainTokens}); ` +
        "a window smaller than a self commit folds the entire history every step",
    );
  }
  // `memory:self` must NOT be a barrier. A fold puts its checkpoint where the folded
  // range began, so a barrier sitting after that point makes every later range
  // un-replaceable (replace must be contiguous) and the planner falls back to
  // `too-few-nodes` forever — memory freezes on turn 1 while the transcript grows.
  // The plugin republishes its own message instead (see pipeline.publishSelf), so
  // listing it here is always a mistake; catching it at load beats a silent stall.
  if (Array.isArray(config.barrierKinds) && config.barrierKinds.includes(SELF_SOURCE_KIND)) {
    throw new Error(
      `dsh-memory: barrierKinds must not contain "${SELF_SOURCE_KIND}"; it is the plugin's own ` +
        "republished message, and treating it as a barrier makes folding stall permanently",
    );
  }
  // An empty barrier list is not a user preference, it is the protection switched off.
  if (Array.isArray(config.barrierKinds) && config.barrierKinds.length === 0) {
    throw new Error(
      "dsh-memory: barrierKinds must not be empty; that silently disables the " +
        "surface-aware injection protection",
    );
  }
  const filters = createFilters(config);
  const logger = ctx.logger?.("dsh-memory");
  const stats = createStats();

  // --- v3: open the LTM domain (long-term memory store).
  //
  // The store is a `@deepseek-ai/dsh-storage-domain` KV domain over the host's JSON
  // backend → `~/.dsh/storages/dsh_memory.json`. We open it inside a `ctx.effect` so the
  // handle is closed with the plugin. `storageDomain` is probed at runtime with
  // `ctx.get(name, false)` and NOT declared in `inject`: this cordis build treats every
  // inject key as required, so a profile without the storage stack would leave the whole
  // plugin pending — LTM is an enhancement, folding/recall must still work without it.
  //
  // Opening is async; the effect body runs synchronously at apply time, so we kick off the
  // open and expose the table through a mutable holder. Until it resolves, `getRecords`
  // and promote see an empty/absent table (safe: recall returns nothing, promote is a
  // no-op). A failed open logs once and leaves `ltmTable` null — silently degraded.
  let ltmTable = null;
  let ltmClosed = false;
  // The most recent agent seen by the pre-step listener. `memory_save` records provenance
  // (sessionId / turn) and, unlike the recall/fetch tools, has no per-call agent context
  // in `execute`, so it reads this holder. `currentAgent()` is what `save-tool.js` gets;
  // a null holder just yields "unknown"/undefined provenance, never an error.
  let lastAgent = null;
  const currentAgent = () => lastAgent;

  // v10: latest per-message context detail, snapshotted in `agent/pre-step` and served
  // to the memory panel over `GET /context.json`. Rebuilt every step so it always
  // reflects the current window. Null until the first step runs.
  let lastContextDetail = null;

  /**
   * Reduce the session's visible surface into a per-message breakdown for the panel.
   * Best-effort: any error leaves the previous snapshot in place rather than clearing it.
   * @param {object} agent - the agent owning this step.
   */
  function snapshotContextDetail(agent) {
    try {
      const session = agent?.session;
      const surface = session?.surface?.nodes ?? [];
      if (!Array.isArray(surface) || surface.length === 0) return;
      lastContextDetail = buildContextDetail(
        surface,
        (seq) => {
          const event = session.eventAt?.(seq);
          if (!event) return null;
          return session.deriveEventMessage?.(event) ?? null;
        },
      );
      lastContextDetail.ready = true;
    } catch (error) {
      logger?.warn?.(`context detail snapshot failed: ${error?.message ?? error}`);
    }
  }

  // v8-b concurrency gate for the background work-name refinement. `refineWorkNames` is
  // fire-and-forget and fires after every promote; without a gate a fast sequence of
  // turns would stack concurrent model requests (and each would re-query the same store).
  // `refining` is true while one pass is in flight; a promote that arrives meanwhile is
  // DROPPED, not queued — the in-flight pass will read the latest store when it queries,
  // and the next promote re-triggers anyway. One in flight, newest-wins-on-rescan.
  let refining = false;
  ctx.effect(() => {
    if (config.ltmEnabled !== true) return () => {};
    const storageDomain = ctx.get?.("storageDomain", false);
    if (!storageDomain || typeof storageDomain.open !== "function") {
      logger?.debug?.("LTM disabled: storageDomain service not present in this profile");
      return () => {};
    }
    // zod is resolved from the host's copy at runtime (it is present in the profile's
    // node_modules and on the module-resolution path, unlike @deepseek-ai/* which needs
    // the host's interception). We deliberately do NOT import `@deepseek-ai/dsh-storage-domain`
    // here: `defineDomain`/`domainTable` are validation + object-literal sugar, so we build
    // the spec by hand in `buildLtmDomainSpecPlain` and avoid the riskiest runtime import.
    (async () => {
      try {
        const { z } = await import("zod");
        const spec = buildLtmDomainSpecPlain(z);
        const domain = await storageDomain.open(spec);
        if (ltmClosed) {
          // Raced with unload; close immediately so we do not leak the handle.
          await domain.close?.();
          return;
        }
        ltmTable = domain.table("records");
        logger?.info?.("LTM store opened");
      } catch (error) {
        logger?.warn?.(`LTM store unavailable, recall stays empty: ${error?.message ?? error}`);
      }
    })();
    return () => {
      ltmClosed = true;
      // The open handle is closed by the domain's own disposal when the facility unmounts;
      // we only stop using it. (Closing here would double-close a handle we may not own.)
    };
  }, "dsh-memory LTM domain");

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    if (!agent?.session) return next();
    // Remember the agent so `memory_save` (which has no per-call context) can stamp
    // provenance. Best-effort: only the most recent step's agent is retained.
    lastAgent = agent;
    // v10: refresh the panel's per-message context detail before the fold shifts the
    // surface — capture it up front so `GET /context.json` reflects this step's window.
    snapshotContextDetail(agent);
    // `next()` runs the rest of the waterfall and returns the step decision. Doing the
    // fold first, then reading the decision, keeps this a single entry point instead of
    // two `pre-step` listeners racing over the same surface.
    let decision;
    try {
      // Capture, fold, then publish — and the order is load-bearing.
      //
      // The fold puts its checkpoint where the folded range began, near the system
      // prompt, so anything published before it gets pushed behind the checkpoint,
      // inside every later fold range. `memory:self` is therefore not a barrier (see
      // `publishSelf`); instead its nodes are captured here, before the fold is
      // allowed to remove the message, and republished afterwards. Reading them
      // after the fold would lose anything the human had confirmed.
      const selfNodes = config.selfEnabled ? captureSelfNodes(agent) : null;
      // `llm` is declared in `inject`. Reading it here without that declaration
      // throws `cannot get property "llm" without inject`, which used to abort every
      // fold silently — see the note on the `inject` export.
      await foldIfNeeded(agent, signal, { ...filters, config, logger, stats, llm: ctx.llm });
      if (config.selfEnabled) publishSelf(agent, stats, selfNodes);
      // v3: after the fold, the session tree is freshly merged — the best moment to
      // promote newly-stable decisions into long-term memory. Awaited so a slow store
      // does not race the next step, but non-fatal: promote swallows its own errors.
      await promoteIfNeeded(agent);
    } catch (error) {
      // A failed fold must never fail the turn: the model can always continue on an
      // unfolded transcript, just more expensively. Compaction makes the same choice
      // for the same reason.
      logger?.warn?.(`fold failed, continuing turn: ${error?.message ?? error}`);
    }
    decision = await next();
    return appendRecall(decision, { ctx, agent, config, logger, stats });
  });

  /**
   * Collect the memory-tree nodes currently visible in this session — the input to a
   * promote pass.
   *
   * The tree lives in the log: every `memory` checkpoint message carries the nodes that
   * survived that fold in `source.nodes` (pipeline §11, `makeMessage` L494). So the union
   * of every checkpoint's `nodes` is the session's current memory. Reading from the surface
   * (not from a store) keeps promote consistent with folding — same source of truth.
   *
   * Deduplication is by node id, newest wins, so a node revised across folds is promoted
   * in its latest form. Nodes without an id or a promotable shape are left to
   * `selectPromotable` to filter; this only gathers.
   *
   * @param {object} agent - the agent owning this step.
   * @returns {object[]} memory nodes, de-duplicated by id (insertion order preserved).
   */
  function collectSessionNodes(agent) {
    const session = agent?.session;
    const surface = session?.surface?.nodes ?? [];
    const byId = new Map();
    for (const seq of surface) {
      const event = session.eventAt?.(seq);
      if (!event) continue;
      let message;
      try {
        message = session.deriveEventMessage?.(event) ?? null;
      } catch {
        continue;
      }
      const source = message?.source;
      if (!source || source.kind !== "memory" || !Array.isArray(source.nodes)) continue;
      for (const node of source.nodes) {
        if (node && typeof node.id === "string") byId.set(node.id, node);
      }
    }
    return [...byId.values()];
  }

  /**
   * Run one promote pass: gather session memory nodes, fold them into LTM, write the diff.
   *
   * Runs after the fold in `agent/pre-step`, so the tree it reads is the freshly-updated
   * one. Best-effort and non-blocking to the turn: every failure is logged and swallowed —
   * a failed promote must never fail a turn (the same rule folding follows). LTM is an
   * enhancement; the transcript is unaffected if it is down.
   *
   * `now` is the wall clock in ms; turned into the record's `promotedAt`. Passing a real
   * clock here is fine (unlike pure functions) because this is a real side effect, not a
   * reproducible computation.
   *
   * @param {object} agent - the agent owning this step.
   * @returns {Promise<void>}
   */
  async function promoteIfNeeded(agent) {
    if (config.ltmEnabled !== true || ltmTable === null) return;
    try {
      const nodes = collectSessionNodes(agent);
      if (nodes.length === 0) return;
      const existing = readAllRecords(ltmTable);
      const now = Date.now();

      // v8-b: the hot path uses a PER-SESSION temporary work key (sessionId short hash).
      // It deliberately does NOT try to name the work here — cwd naming was proven wrong
      // (see projectNameFromCwd) and a model call must not sit on the write hot path.
      // The temporary key keeps unrelated sessions separate (never merged); a background
      // pass (refineWorkNames) later renames each key from its content and merges keys
      // that turn out to be the same work.
      let work = null;
      if (config.workEnabled !== false) {
        work = extractWork({
          name: "", // no rule-based name
          fallback: shortSessionId(agent?.session?.id),
        });
      }

      const { records } = runPromotePass({
        nodes,
        existing,
        sessionId: agent?.session?.id ?? "unknown",
        now,
        work,
        limits: {
          minWeight: config.ltmMinWeight,
          maxNodes: config.ltmMaxNodes,
          maxTokens: config.ltmMaxTokens,
        },
      });
      const diff = diffForWrite(existing, records);
      if (diff.put.length === 0 && diff.deletedIds.length === 0) return;
      const res = await applyWriteDiff(ltmTable, diff);
      if (res.errors.length > 0) {
        logger?.warn?.(`LTM promote wrote ${res.written}, ${res.errors.length} errors: ${res.errors[0]}`);
      } else if (res.written > 0) {
        logger?.debug?.(`LTM promote wrote ${res.written} record(s)`);
      }
      // v8-b: kick off background work-name refinement. Fire-and-forget: NOT awaited, so
      // a slow/failed model call never delays or fails this turn. It self-gates (only runs
      // when there are temporary work keys) and swallows its own errors.
      if (config.workEnabled !== false && config.workRefineEnabled !== false) {
        refineWorkNames(agent).catch((error) =>
          logger?.debug?.(`work refine skipped: ${error?.message ?? error}`),
        );
      }
    } catch (error) {
      logger?.warn?.(`LTM promote skipped: ${error?.message ?? error}`);
    }
  }

  /** Is this work key still a temporary (per-session) key that needs refining? */
  function isTemporaryWorkKey(work) {
    if (typeof work !== "string") return false;
    // Temporary keys are `work:<sessionShortHash>`. A refined key is a human name. We
    // cannot perfectly tell them apart, but a temporary key never contains CJK and looks
    // like a short alnum/hash tail. Treat any work key whose body is short and ASCII
    // alnum-hash as temporary; a refined (usually CJK, descriptive) name is not.
    if (!work.startsWith("work:")) return false;
    const body = work.slice(5);
    return /^[a-z0-9]{4,24}$/.test(body);
  }

  /**
   * v8-b background pass: refine temporary per-session work keys into human work names,
   * merging keys that are the same work.
   *
   * NOT on the hot path: called fire-and-forget after promote. Picks the live records
   * whose `work` is still a temporary key, groups them, asks the model for one name per
   * key (same name ⇒ same work), and writes the mapping back via `applyWorkNames`.
   *
   * Safety: no model service ⇒ return; no temporary groups ⇒ return; model failure,
   * timeout, or junk ⇒ log at debug and leave the temporary keys in place (next pass
   * retries). It never changes `title`/`body`, only `work`/`parentId`/pivot linkage.
   *
   * @param {object} agent - owning agent (for provider/model routing).
   * @returns {Promise<void>}
   */
  async function refineWorkNames(agent) {
    if (ltmTable === null) return;
    // Concurrency gate: a pass is already running → drop this trigger. The in-flight pass
    // reads the store fresh (below), so it sees whatever this promote just wrote; the next
    // promote re-triggers if more work is left. This bounds model requests to one at a time.
    if (refining) return;
    const llm = ctx.get?.("llm", false);
    if (typeof llm?.stream !== "function") return;
    refining = true;
    try {
      // Naming pass (only does work when temporary keys exist). Safe to short-circuit.
      await runWorkRefine(agent, llm);
      // v8-c-1: summary pass runs regardless of whether naming had anything to do —
      // real LTM data is mostly already-named work, so runWorkRefine returns early and
      // the pivots still need real bodies. Own try so a summary failure never blocks
      // the (already-completed) naming write-back.
      try {
        await runWorkSummaries(agent, llm);
      } catch (error) {
        logger?.debug?.(`work summaries skipped: ${error?.message ?? error}`);
      }
    } finally {
      // Always release, even on throw/timeout, or refinement would wedge off permanently.
      refining = false;
    }
  }

  /**
   * The body of one refinement pass. Split out so `refineWorkNames` can own the
   * `refining` gate with a try/finally and this stays linear.
   * @param {object} agent - owning agent.
   * @param {object} llm - resolved llm service (guaranteed to have .stream).
   * @returns {Promise<void>}
   */
  async function runWorkRefine(agent, llm) {
    const all = readAllRecords(ltmTable);
    // Group live member records by their temporary work key.
    /** @type {Map<string, object[]>} */
    const groups = new Map();
    for (const record of all) {
      if (record.archived === true || record.supersededAt != null) continue;
      if (record.kind === "work-summary") continue;
      if (!isTemporaryWorkKey(record.work)) continue;
      const list = groups.get(record.work) ?? [];
      list.push(record);
      groups.set(record.work, list);
    }
    if (groups.size === 0) return;

    const keys = [...groups.keys()];
    const rendered = keys
      .map((key) => renderWorkGroup({ key, samples: groups.get(key) }))
      .join("\n\n");
    const instruction = buildWorkNamingInstruction({ keys, mode: "conservative" });
    const prompt = `${rendered}\n\n---\n\n${instruction}`;

    const session = agent?.session;
    const routed = session?.requestHeader?.()?.config ?? null;
    const provider = routed?.provider ?? agent?.options?.provider;
    const model = routed?.model ?? agent?.options?.model;
    if (typeof provider !== "string" || typeof model !== "string") return;

    const raw = await collectStreamTextSafe(llm, {
      provider,
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      toolHistory: [],
      maxTokens: 800,
      ...(session?.id === undefined ? {} : { sessionId: session.id }),
    });
    const mapping = parseWorkNames(raw, keys);
    if (mapping.size === 0) return;

    const now = Date.now();
    const applied = applyWorkNames(all, mapping, {
      maxNodes: config.ltmMaxNodes,
      maxTokens: config.ltmMaxTokens,
      now,
    });
    if (applied.stats.renamed === 0 && applied.stats.pivotsRetired === 0) return;

    const diff = diffForWrite(all, applied.records);
    if (diff.put.length === 0 && diff.deletedIds.length === 0) return;
    const res = await applyWriteDiff(ltmTable, diff);
    logger?.debug?.(
      `work refine: ${applied.stats.renamed} renamed, ${applied.stats.pivotsCreated} pivots, ${res.written} written`,
    );
  }

  /**
   * v8-c-1: replace each work pivot's mechanical body (a join of member titles built by
   * applyWorkPivots) with a model-written 1-2 sentence summary of the work.
   *
   * Bounded + safe: processes at most MAX_SUMMARIES_PER_PASS pivots, one model call each,
   * sequentially, all under the same `refining` gate as naming. Any failure (timeout,
   * empty parse) simply leaves that pivot's mechanical body in place. Never throws out.
   *
   * @param {object} agent - owning agent (for provider/model routing).
   * @param {object} llm - resolved llm service (has .stream).
   * @returns {Promise<void>}
   */
  async function runWorkSummaries(agent, llm) {
    const MAX_SUMMARIES_PER_PASS = 4;
    const all = readAllRecords(ltmTable);
    // Live member records per work key (exclude pivots + archived/superseded).
    const membersByWork = new Map();
    for (const r of all) {
      if (r.archived === true || r.supersededAt != null) continue;
      if (r.kind === "work-summary") continue;
      if (typeof r.work !== "string" || r.work === "") continue;
      const list = membersByWork.get(r.work);
      if (list) list.push(r);
      else membersByWork.set(r.work, [r]);
    }
    // Candidate pivots: live work-summary with >=2 members. Process a bounded batch.
    const targets = [];
    for (const r of all) {
      if (r.kind !== "work-summary" || r.archived === true) continue;
      if (typeof r.work !== "string") continue;
      const members = membersByWork.get(r.work);
      if (!members || members.length < 2) continue;
      targets.push({ pivot: r, members });
      if (targets.length >= MAX_SUMMARIES_PER_PASS) break;
    }
    if (targets.length === 0) return;

    const session = agent?.session;
    const routed = session?.requestHeader?.()?.config ?? null;
    const provider = routed?.provider ?? agent?.options?.provider;
    const model = routed?.model ?? agent?.options?.model;
    if (typeof provider !== "string" || typeof model !== "string") return;

    const summaries = new Map();
    for (const { pivot, members } of targets) {
      const rendered = renderWorkMembers(members);
      const instruction = buildWorkSummaryInstruction({ work: pivot.work });
      const prompt = `${rendered}\n\n---\n\n${instruction}`;
      const raw = await collectStreamTextSafe(llm, {
        provider,
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        toolHistory: [],
        maxTokens: 400,
        ...(session?.id === undefined ? {} : { sessionId: session.id }),
      });
      const summary = parseWorkSummary(raw);
      if (summary !== "") summaries.set(pivot.work, summary);
    }
    if (summaries.size === 0) return;

    // Re-read (a concurrent write may have landed) then apply summaries by work key.
    const fresh = readAllRecords(ltmTable);
    const applied = applyWorkSummaries(fresh, summaries);
    if (applied.stats.updated === 0) return;
    const sdiff = diffForWrite(fresh, applied.records);
    if (sdiff.put.length === 0 && sdiff.deletedIds.length === 0) return;
    const sres = await applyWriteDiff(ltmTable, sdiff);
    logger?.debug?.(`work summaries: ${applied.stats.updated} updated, ${sres.written} written`);
  }

  /**
   * v8-c-2: whole-store work reorganisation. Looks at ALL live work names at once and
   * asks the model which are the same job, then merges via applyWorkNames.
   *
   * This is the "manual / on-demand" counterpart to the automatic naming pass: it can
   * also merge work the automatic pass has ALREADY named (the automatic pass only sees
   * temporary keys). Called by the `memory_organize` tool and the LTM-page button.
   *
   * Safe: no work / no llm / unparseable answer → returns a no-op result. Never throws
   * out to the caller (tool/HTTP endpoint wraps too). Bounded: caps works sent and the
   * per-work sample budget so a large store does not blow the prompt.
   *
   * @param {object} agent - owning agent (provider/model routing).
   * @param {object} llm - resolved llm service.
   * @param {{maxWorks?: number, mode?: 'conservative'|'balanced', dryRun?: boolean,
   *          mapping?: Map<string,string>|Record<string,string>}} [opts]
   *   - mode: merge tightness (default conservative).
   *   - dryRun: when true, compute the proposed merge plan but DO NOT write (档3 preview).
   *   - mapping: when provided (e.g. an approved plan), skip the model call and apply it.
   * @returns {Promise<{ok:boolean, works:number, merged:number, renamed:number, pivotsCreated:number,
   *   reason?:string, dryRun?:boolean, plan?: Array<{from:string[], to:string}>}>}
   */
  async function organizeAllWorks(agent, llm, opts = {}) {
    const MAX_WORKS = Number.isFinite(opts.maxWorks) ? opts.maxWorks : 40;
    const mode = opts.mode === "balanced" ? "balanced" : "conservative";
    const dryRun = opts.dryRun === true;
    const empty = { ok: false, works: 0, merged: 0, renamed: 0, pivotsCreated: 0 };
    if (ltmTable === null) return { ...empty, reason: "LTM store unavailable" };

    const all = readAllRecords(ltmTable);
    // Group live members by work; keep only works with >=1 member (a lone record still
    // matters — merging two lone works into one is exactly a case we want to catch).
    const byWork = new Map();
    for (const r of all) {
      if (r.archived === true || r.supersededAt != null) continue;
      if (r.kind === "work-summary") continue;
      if (typeof r.work !== "string" || r.work === "") continue;
      const list = byWork.get(r.work);
      if (list) list.push(r);
      else byWork.set(r.work, [r]);
    }
    const works = [...byWork.keys()];
    if (works.length < 2) return { ...empty, works: works.length, reason: "fewer than 2 works" };

    let mapping;
    if (opts.mapping !== undefined && opts.mapping !== null) {
      // Apply an already-approved plan (档3 apply step). Only accept keys that still exist.
      const given = opts.mapping instanceof Map ? [...opts.mapping.entries()] : Object.entries(opts.mapping);
      mapping = new Map();
      const known = new Set(works);
      for (const [k, v] of given) {
        if (known.has(k) && typeof v === "string" && v.trim() !== "") {
          // normalise a user/model-supplied work name: trim, collapse space, clip.
          mapping.set(k, String(v).replace(/\s+/g, " ").trim().slice(0, 48));
        }
      }
      if (mapping.size === 0) return { ...empty, works: works.length, reason: "no valid mapping to apply" };
    } else {
      if (typeof llm?.stream !== "function") return { ...empty, reason: "no llm service" };
      const session = agent?.session;
      const routed = session?.requestHeader?.()?.config ?? null;
      const provider = routed?.provider ?? agent?.options?.provider;
      const model = routed?.model ?? agent?.options?.model;
      if (typeof provider !== "string" || typeof model !== "string") {
        return { ...empty, reason: "no model route" };
      }
      // Cap the batch (largest-first so the most material groups are considered).
      const capped = works
        .sort((a, b) => byWork.get(b).length - byWork.get(a).length)
        .slice(0, MAX_WORKS);
      const rendered = capped
        .map((key) => renderWorkForMerge({ work: key, samples: byWork.get(key) }))
        .join("\n\n");
      const instruction = buildWorkMergeInstruction({ works: capped, mode });
      const prompt = `${rendered}\n\n---\n\n${instruction}`;
      const raw = await collectStreamTextSafe(llm, {
        provider,
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        toolHistory: [],
        maxTokens: 1200,
        ...(session?.id === undefined ? {} : { sessionId: session.id }),
      });
      mapping = parseWorkNames(raw, capped);
      if (mapping.size === 0) return { ...empty, works: works.length, reason: "model returned no usable mapping" };
    }

    // Build the merge plan: group source work keys by their proposed target name.
    const planByTarget = new Map();
    let merged = 0;
    for (const [srcKey, name] of mapping) {
      const curBody = srcKey.replace(/^work:/, "");
      const changed = name.trim().toLowerCase() !== curBody.trim().toLowerCase();
      if (changed) merged += 1;
      const list = planByTarget.get(name) ?? [];
      list.push(srcKey);
      planByTarget.set(name, list);
    }
    // Only surface plan rows that actually merge >=2 works or rename one (skip no-ops).
    const plan = [];
    for (const [to, from] of planByTarget) {
      const isMerge = from.length >= 2;
      const isRename = from.length === 1 && from[0].replace(/^work:/, "").trim().toLowerCase() !== to.trim().toLowerCase();
      if (isMerge || isRename) plan.push({ from: [...from], to });
    }

    if (dryRun) {
      // 档3 preview: report the proposed plan without touching the store.
      return { ok: true, dryRun: true, works: works.length, merged, renamed: 0, pivotsCreated: 0, plan };
    }

    if (merged === 0) {
      return { ok: true, works: works.length, merged: 0, renamed: 0, pivotsCreated: 0, plan };
    }

    const now = Date.now();
    const applied = applyWorkNames(all, mapping, {
      maxNodes: config.ltmMaxNodes,
      maxTokens: config.ltmMaxTokens,
      now,
    });
    if (applied.stats.renamed === 0 && applied.stats.pivotsRetired === 0) {
      return { ok: true, works: works.length, merged: 0, renamed: 0, pivotsCreated: 0, plan };
    }
    const diff = diffForWrite(all, applied.records);
    if (diff.put.length === 0 && diff.deletedIds.length === 0) {
      return { ok: true, works: works.length, merged: 0, renamed: 0, pivotsCreated: 0, plan };
    }
    const res = await applyWriteDiff(ltmTable, diff);
    logger?.debug?.(
      `organize: ${applied.stats.renamed} renamed (${merged} toward a merge target), ${res.written} written`,
    );
    return {
      ok: true,
      works: works.length,
      merged,
      renamed: applied.stats.renamed,
      pivotsCreated: applied.stats.pivotsCreated,
      plan,
    };
  }


  /**
   * v10: split ONE over-merged work into sub-groups (the inverse of organizeAllWorks).
   *
   * Merge's blind spot is that it only ever *joins*: once automatic naming (or a whole-store
   * merge) folds two different jobs into one `work` key, nothing can pull them apart. This
   * is the manual counterpart. Two-step like organize (档3): call with dryRun=true to get the
   * proposed partition (nothing written), show it, then call again with `plan` to apply.
   *
   * Safety mirrors organize: no store / unknown work / <2 live members / no llm / unparseable
   * answer → no-op result with a `reason`. Never throws. The member ordering used to build
   * the prompt (m0..mN) is the SAME order handed to applyWorkSplit, so indices line up.
   *
   * @param {object} agent - owning agent (provider/model routing).
   * @param {object} llm - resolved llm service.
   * @param {string} work - the work key to split (e.g. `work:acs`).
   * @param {{mode?: 'conservative'|'balanced', dryRun?: boolean,
   *          plan?: Array<{name:string, members:number[]}>}} [opts]
   *   - dryRun: true = preview only.
   *   - plan: an approved partition (sub-group name + member indices) to APPLY.
   * @returns {Promise<{ok:boolean, work:string, members:number, groups:number, moved:number,
   *   pivotsCreated:number, reason?:string, dryRun?:boolean,
   *   plan?: Array<{name:string, members:number[]}>}>}
   */
  async function splitWork(agent, llm, work, opts = {}) {
    const mode = opts.mode === "balanced" ? "balanced" : "conservative";
    const dryRun = opts.dryRun === true;
    const sourceWork = typeof work === "string" ? work.trim() : "";
    const empty = { ok: false, work: sourceWork, members: 0, groups: 0, moved: 0, pivotsCreated: 0 };
    if (ltmTable === null) return { ...empty, reason: "LTM store unavailable" };
    if (sourceWork === "") return { ...empty, reason: "no work key given" };

    // Live, non-pivot members of the source work, in store order. This exact array's order
    // is what the prompt enumerates as m0..mN and what applyWorkSplit indexes into.
    const all = readAllRecords(ltmTable);
    const members = all.filter(
      (r) =>
        r &&
        r.kind !== "work-summary" &&
        r.archived !== true &&
        r.supersededAt == null &&
        r.work === sourceWork,
    );
    if (members.length < 2) {
      return { ...empty, members: members.length, reason: "fewer than 2 live members" };
    }

    let plan;
    if (Array.isArray(opts.plan) && opts.plan.length > 0) {
      // Apply an approved partition (档3 apply step). normalizeSplitPlan accepts both
      // `memberIds` (what dryRun/parseWorkSplit emit) and `members`, so a plan round-tripped
      // verbatim from the preview is not silently emptied here (the old bug).
      plan = normalizeSplitPlan(opts.plan, members.length);
      if (plan.length === 0) return { ...empty, members: members.length, reason: "no valid partition to apply" };
    } else {
      if (typeof llm?.stream !== "function") return { ...empty, members: members.length, reason: "no llm service" };
      const session = agent?.session;
      const routed = session?.requestHeader?.()?.config ?? null;
      const provider = routed?.provider ?? agent?.options?.provider;
      const model = routed?.model ?? agent?.options?.model;
      if (typeof provider !== "string" || typeof model !== "string") {
        return { ...empty, members: members.length, reason: "no model route" };
      }
      const rendered = renderWorkForSplit({ work: sourceWork, members });
      const instruction = buildWorkSplitInstruction({ work: sourceWork, memberCount: members.length, mode });
      const prompt = `${rendered}\n\n---\n\n${instruction}`;
      const raw = await collectStreamTextSafe(llm, {
        provider,
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        toolHistory: [],
        maxTokens: 1200,
        ...(session?.id === undefined ? {} : { sessionId: session.id }),
      });
      plan = parseWorkSplit(raw, members.length);
      if (plan.length === 0) {
        return { ...empty, members: members.length, reason: "model returned no usable partition" };
      }
    }

    // A partition that keeps everything under the source name is a no-op (no split needed).
    const srcBody = sourceWork.replace(/^work:/, "").trim().toLowerCase();
    const splitsAtAll = plan.some((g) => g.name.trim().toLowerCase() !== srcBody);

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        work: sourceWork,
        members: members.length,
        groups: plan.length,
        moved: 0,
        pivotsCreated: 0,
        plan,
      };
    }

    if (!splitsAtAll) {
      return { ok: true, work: sourceWork, members: members.length, groups: plan.length, moved: 0, pivotsCreated: 0, plan };
    }

    const now = Date.now();
    const applied = applyWorkSplit(all, sourceWork, plan, {
      maxNodes: config.ltmMaxNodes,
      maxTokens: config.ltmMaxTokens,
      now,
    });
    const diff = diffForWrite(all, applied.records);
    if (diff.put.length > 0 || diff.deletedIds.length > 0) {
      await applyWriteDiff(ltmTable, diff);
    }
    logger?.debug?.(
      `split: ${applied.stats.moved} member(s) moved out of ${sourceWork}, ${applied.stats.pivotsCreated} pivot(s)`,
    );
    return {
      ok: true,
      work: sourceWork,
      members: members.length,
      groups: plan.length,
      moved: applied.stats.moved,
      pivotsCreated: applied.stats.pivotsCreated,
      plan,
    };
  }


  /**
   * Collect assistant text from `llm.stream`, bounded by a wall-clock timeout. A thin
   * wrapper so the background refine never hangs a step; returns "" on timeout.
   * @param {object} llm - llm service.
   * @param {object} options - stream options.
   * @returns {Promise<string>} assistant text ("" on timeout/empty).
   */
  async function collectStreamTextSafe(llm, options) {
    const timeoutMs = Number.isFinite(config.llmTimeoutMs) ? config.llmTimeoutMs : 20000;
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    let text = "";
    try {
      const stream = llm.stream(signal === undefined ? options : { ...options, signal });
      for await (const chunk of stream) {
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
        else if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
          text += chunk.block.text;
        }
      }
    } catch {
      return text; // a thrown/aborted stream yields whatever we got
    }
    return text;
  }

  /**
   * Append a recall block to this step's request only.
   *
   * Two independent sources feed one block:
   *   1. **Long-term memory (LTM)** — `runRecall(readSearchableRecords(ltmTable))`. This
   *      is what makes a *new* session remember across sessions: the LTM store is global,
   *      so a fact promoted in an earlier session is recallable here even though this
   *      session's own event log is empty. Gated by `recallEnabled && ltmEnabled && table`.
   *   2. **This session's event log** — `ctx.sessionQuery` over `filterEvents`. Gated by
   *      `sessionRecallEnabled` (a separate, narrower switch — the backend only exists when
   *      `dsh-session-query-sqlite` is mounted).
   *
   * The rendered text goes in as a transient `user/message` in `decision.messages` — the
   * same mechanism `dsh-agent`'s `modelSwitchNotice` uses — never appended to the surface.
   * So it cannot be folded (not a surface node) and is not persisted; it is re-derived each
   * turn. Silent on every failure path: an error, no hits, no query all return the decision
   * unchanged. Recall is an optimisation, and a turn must never fail because a search did.
   *
   * @param {object} decision - the `agent/pre-step` decision from `next()`.
   * @param {object} deps - collaborators.
   * @returns {Promise<object>} the (possibly augmented) decision.
   */
  async function appendRecall(decision, { ctx: c, agent, config: cfg, logger: log, stats: st }) {
    if (cfg.recallEnabled !== true) return decision;
    if (!decision || decision.kind === "reject" || !Array.isArray(decision.messages)) return decision;
    try {
      const query = buildRecallQuery(currentUserText(agent, new Set(cfg.admitKinds)));
      if (query === "") return decision;

      const blocks = [];
      let hitCount = 0;

      // --- (1) Long-term memory. Independent of `sessionQuery`: LTM is a local KV table,
      // so this works in a brand-new session with an empty event log. This is the fix for
      // "a new session cannot read LTM" — the old code only ever searched the session log.
      if (cfg.ltmEnabled === true && ltmTable !== null) {
        const records = readSearchableRecords(ltmTable);
        if (records.length > 0) {
          const ltmResult = runRecall(records, query, {
            enabled: true,
            budget: Math.min(cfg.recallBudget ?? RECALL_DEFAULTS.budget, RECALL_DEFAULTS.budget),
            topK: cfg.recallTopK ?? RECALL_DEFAULTS.topK,
            maxExtra: cfg.recallMaxExtra ?? RECALL_DEFAULTS.maxExtra,
          });
          if (ltmResult.block !== "") {
            blocks.push(ltmResult.block);
            hitCount += Array.isArray(ltmResult.hits) ? ltmResult.hits.length : 0;
          }
        }
      }

      // --- (2) This session's event log (narrower switch; service may be absent).
      if (cfg.sessionRecallEnabled === true) {
        const source = c.get?.("sessionQuery", false);
        // `filterEvents` (base engine) is the chosen path: it scans THIS session directly,
        // no FTS index. `searchEvents` exists only as a fallback — see session-recall.js.
        if (source && (typeof source.filterEvents === "function" || typeof source.searchEvents === "function")) {
          st.recallAttempts += 1;
          const hits = await fetchCandidates(
            source,
            {
              sessionId: agent.session?.id ?? "",
              query,
              limit: cfg.recallTopK ?? RECALL_DEFAULTS.searchLimit,
            },
            agent.session?.signal ?? undefined,
          );
          const candidates = hits.map(toCandidate).filter(Boolean);
          const { block, selected } = recallFromCandidates(candidates, {
            enabled: true,
            budget: Math.min(cfg.recallBudget ?? RECALL_DEFAULTS.budget, RECALL_DEFAULTS.budget),
            eventChars: RECALL_DEFAULTS.eventChars,
          });
          if (block !== "") {
            blocks.push(block);
            hitCount += selected.length;
          }
        }
      }

      if (blocks.length === 0) {
        st.recallEmpty += 1;
        log?.debug?.(`recall: no match for query ${JSON.stringify(query.slice(0, 60))}`);
        return decision;
      }
      st.recallPublished += 1;
      st.recallEvents += hitCount;
      return { ...decision, messages: [...decision.messages, makeRecallMessage(blocks.join("\n\n"))] };
    } catch (error) {
      log?.warn?.(`recall skipped: ${error?.message ?? error}`);
      return decision;
    }
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(
      defineTool({
        name: "memory_stats",
        description:
          "Report what the memory plugin has folded in this session: fold count, skipped reasons, shadowed tokens, kept/dropped nodes, and the current budgets.",
        parameters: {},
        // `output.schema` is the tool registry's own value-schema dialect — a raw
        // JSON Schema object with a per-property `required: true` flag, NOT a
        // schemastery type. Passing `z.any()` here fails the whole plugin load with
        // `JsonSchemaError: unsupported JSON schema: schema must be a value schema
        // object`, which surfaces only as "1 entry did not activate".
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              folds: { type: "integer", required: true },
              selfPublished: { type: "integer", required: true },
              selfReplaced: { type: "integer", required: true },
              shadowedTokens: { type: "integer", required: true },
              droppedNodes: { type: "integer", required: true },
              oversized: { type: "integer", required: true },
              retainTokens: { type: "integer", required: true },
              volatileBudget: { type: "integer", required: true },
              // v2: the fallback rate is the number that matters. A silent fallback on
              // every fold is indistinguishable from "v2 never ran" without it.
              llmRequested: { type: "integer", required: true },
              llmUsed: { type: "integer", required: true },
              llmFailed: { type: "integer", required: true },
              llmRejected: { type: "integer", required: true },
              recallPublished: { type: "integer", required: true },
              recallEvents: { type: "integer", required: true },
              recallAttempts: { type: "integer", required: true },
              recallEmpty: { type: "integer", required: true },
              skipped: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    reason: { type: "string", required: true },
                    count: { type: "integer", required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value ?? {}, null, 2) }],
        },
        async execute() {
          return {
            folds: stats.folds,
            selfPublished: stats.selfPublished,
            selfReplaced: stats.selfReplaced,
            // `node.tokens` is a float (the harness estimates, it does not count), and
            // `sumTokens` adds them raw, so this counter is fractional. The output
            // schema says integer and the registry validates it — returning the float
            // fails the whole tool call with "must be an integer" instead of a number
            // a human can read. Round at the boundary, not in the accumulator: the
            // fold planner compares budgets against the real value.
            shadowedTokens: Math.round(stats.shadowedTokens),
            droppedNodes: stats.droppedNodes,
            oversized: stats.oversized,
            retainTokens: config.retainTokens,
            volatileBudget: config.volatileBudget,
            llmRequested: stats.llmRequested,
            llmUsed: stats.llmUsed,
            llmFailed: stats.llmFailed,
            llmRejected: stats.llmRejected,
            recallPublished: stats.recallPublished,
            recallEvents: stats.recallEvents,
            recallAttempts: stats.recallAttempts,
            recallEmpty: stats.recallEmpty,
            // The registry wants a plain array; `stats.skipped` is a reason→count map
            // because that is the shape a log line wants.
            skipped: Object.entries(stats.skipped ?? {}).map(([reason, count]) => ({ reason, count })),
          };
        },
      }),
    );
    return () => dispose?.();
  }, "dsh-memory tool");

  // --- v4: `memory_recall`.
  //
  // The definition lives in `recall-tool.js` so it can be tested without the host
  // packages (see that file's header: nothing in this file is importable by a test).
  // `getRecords` is a placeholder until v3 is wired: LTM will come from
  // `storage-domain` at session end (promote-plan §10 step 6), and until then this
  // returns an empty store, so the tool answers "nothing recalled" instead of throwing.
  ctx.effect(() => {
    const dispose = ctx.tools.register(
      defineTool(
        createRecallTool({
          // Read the live LTM records from the domain table. When LTM is disabled or the
          // open failed, `ltmTable` is null → empty array → the tool answers "nothing
          // recalled" (the exact pre-v3 behaviour) rather than throwing.
          getRecords: () => (ltmTable ? readSearchableRecords(ltmTable) : []),
          config: {
            recallEnabled: config.recallEnabled,
            recallBudget: config.recallBudget,
            recallTopK: config.recallTopK,
            recallMaxExtra: config.recallMaxExtra,
          },
        }),
      ),
    );
    return () => dispose?.();
  }, "dsh-memory recall tool");

  // --- v5: `memory_fetch` (§7.7 ⑤c).
  //
  // Reads a session event's full text by seq — the pointer a folded oversized tool result
  // carries ("完整原文 seq=617"). Without it that pointer is a dead end. Wiring mirrors
  // `memory_recall`: the definition is in its own module (host packages are not importable
  // by tests). `readEvent` is looked up at call time with `ctx.get(..., false)`, never
  // declared in `inject` — this build treats every inject key as required, and a profile
  // without the session-query backend must still load the plugin.
  ctx.effect(() => {
    const dispose = ctx.tools.register(
      defineTool(
        createFetchTool({
          readEvent: async (sessionId, seq) => {
            const source = ctx.get?.("sessionQuery", false);
            if (!source || typeof source.readEvent !== "function") return null;
            // `readEvent({sessionId, seq})` returns `{target, events, …}`; the caller wants
            // the target event only. A missing event throws SESSION_QUERY_EVENT_NOT_FOUND —
            // caught by the tool, which reports "no such seq" rather than failing the turn.
            const result = await source.readEvent({ sessionId, seq });
            return result?.target ?? null;
          },
          config: { maxChars: config.fetchMaxChars },
        }),
      ),
    );
    return () => dispose?.();
  }, "dsh-memory fetch tool");

  // --- v6: `memory_save` — a direct, fold-independent write into LTM.
  //
  // The promote path only writes after a fold; a model that learns a durable fact mid-turn
  // had no way to record it. This tool closes that gap. The write goes through `mergeLtm`
  // (so supersede + budget still apply) and then `diffForWrite`/`applyWriteDiff`, exactly
  // like a promote pass — one shared write path, not a second bespoke one. `id` is the
  // content hash, so a manual save and a later automatic promote of the same text converge
  // on one record instead of duplicating.
  if (config.ltmEnabled === true && config.saveEnabled === true) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(
        defineTool(
          createSaveTool({
            saveRecord: async ({ record }) => {
              if (ltmTable === null) {
                return { written: 0, errors: ["LTM store unavailable"] };
              }
              const existing = readAllRecords(ltmTable);
              const merged = mergeLtm(existing, [record], {
                maxNodes: config.ltmMaxNodes,
                maxTokens: config.ltmMaxTokens,
                now: Date.now(),
              });
              const diff = diffForWrite(existing, merged.records);
              if (diff.put.length === 0 && diff.deletedIds.length === 0) {
                return { written: 0, errors: [] };
              }
              const res = await applyWriteDiff(ltmTable, diff);
              return { written: res.written, errors: res.errors };
            },
            config: { saveEnabled: config.saveEnabled, saveWeight: config.saveWeight },
            sessionId: () => currentAgent?.()?.session?.id ?? "unknown",
            turn: () => currentAgent?.()?.session?.turn,
          }),
        ),
      );
      return () => dispose?.();
    }, "dsh-memory save tool");
  }

  // --- v8-c-2: `memory_organize` — merge-same-job works across the whole LTM store.
  //
  // Two-step by design (档3): call with dryRun=true first to GET a proposed merge plan
  // (nothing written), show it to the user, then call again with `plan` = the approved
  // mapping to APPLY it. A one-shot (dryRun=false, no plan) also works for "just do it".
  // The automatic naming pass only sees temporary keys; this pass can merge already-named
  // work too. `mode` tunes tightness (conservative default).
  ctx.effect(() => {
    // Fail-soft: if the tool registry rejects this tool's schema on some host version,
    // we must not take the whole plugin down (that would disable memory_stats etc. too).
    let dispose = null;
    try {
      dispose = ctx.tools.register(
        defineTool({
          name: "memory_organize",
          description:
          "Reorganise long-term memory by merging works that are actually the same job. " +
          "TWO-STEP: call with dryRun=true to get a proposed merge plan (nothing changes), " +
          "show it to the user; if the user approves, call again with plan=<the approved " +
          "[{from:[...],to:\"...\"}] JSON> to apply. A single dryRun=false call merges at once. " +
          "Use when the user asks to 整理记忆 / 合并重复的工作 / clean up memory organisation.",
        // NOTE: this registry's `parameters` dialect lists each parameter DIRECTLY
        // (name → {type, required?, description?}). Wrapping in {type:"object",
        // properties:{...}} throws "parameters.type must be a value schema object" from
        // defineTool and aborts the WHOLE plugin apply. `required:false` must be omitted.
        parameters: {
          dryRun: {
            type: "boolean",
            description: "true = only return the proposed merge plan, do not modify memory.",
          },
          mode: {
            type: "string",
            description: "Merge tightness: 'conservative' (default) or 'balanced'.",
          },
          planJson: {
            type: "string",
            description:
              "An approved merge plan as a JSON string, e.g. '[{\"from\":[\"work:a\",\"work:b\"],\"to\":\"合并名\"}]'. " +
              "Pass this to APPLY a plan previously returned by a dryRun.",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              dryRun: { type: "boolean" },
              works: { type: "integer", required: true },
              merged: { type: "integer", required: true },
              renamed: { type: "integer", required: true },
              pivotsCreated: { type: "integer", required: true },
              reason: { type: "string" },
              planJson: { type: "string" },
            },
          },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value ?? {}, null, 2) }],
        },
        async execute(args) {
          const a = args ?? {};
          try {
            // Build a mapping from an approved plan (JSON string) if one was supplied.
            let mapping;
            if (typeof a.planJson === "string" && a.planJson.trim() !== "") {
              let rows = [];
              try {
                rows = JSON.parse(a.planJson);
              } catch {
                return { ok: false, works: 0, merged: 0, renamed: 0, pivotsCreated: 0, reason: "planJson is not valid JSON" };
              }
              if (Array.isArray(rows) && rows.length > 0) {
                mapping = {};
                for (const row of rows) {
                  const to = typeof row?.to === "string" ? row.to : "";
                  if (to === "") continue;
                  for (const k of Array.isArray(row?.from) ? row.from : []) {
                    if (typeof k === "string" && k !== "") mapping[k] = to;
                  }
                }
              }
            }
            const res = await organizeAllWorks(currentAgent?.(), ctx.get?.("llm", false), {
              dryRun: a.dryRun === true,
              mode: a.mode === "balanced" ? "balanced" : "conservative",
              ...(mapping && Object.keys(mapping).length > 0 ? { mapping } : {}),
            });
            // The tool's output schema is closed (additionalProperties:false) and cannot
            // carry the array-of-object `plan`. Return ONLY the declared fields, with the
            // plan serialised to a JSON string the model can hand back via planJson.
            const planJson =
              Array.isArray(res?.plan) && res.plan.length > 0 ? JSON.stringify(res.plan) : undefined;
            return {
              ok: res?.ok === true,
              dryRun: res?.dryRun === true,
              works: Number(res?.works) || 0,
              merged: Number(res?.merged) || 0,
              renamed: Number(res?.renamed) || 0,
              pivotsCreated: Number(res?.pivotsCreated) || 0,
              ...(typeof res?.reason === "string" ? { reason: res.reason } : {}),
              ...(planJson ? { planJson } : {}),
            };
          } catch (error) {
            return {
              ok: false, works: 0, merged: 0, renamed: 0, pivotsCreated: 0,
              reason: String(error?.message ?? error),
            };
          }
        },
      }),
      );
    } catch (error) {
      // Schema rejected: keep the rest of the plugin alive. memory_organize just won't exist.
      // Write the real error to a diagnosable file (host process has fs; logs may not persist).
      try {
        const p = pathJoin(homedir(), ".dsh", "storages", "memory-organize-register-error.txt");
        writeFileSync(p, `${new Date().toISOString()}\n${error?.stack ?? error?.message ?? error}\n`);
      } catch {
        /* ignore */
      }
      logger?.warn?.(`memory_organize tool registration skipped: ${error?.message ?? error}`);
      return () => {};
    }
    return () => dispose?.();
  }, "dsh-memory organize tool");

  // --- v10: `memory_split` — split ONE over-merged work into sub-groups (inverse of merge).
  //
  // Merge can only join; this pulls an over-merged work apart. Two-step (档3): dryRun first
  // to preview the proposed partition, then re-call with planJson to apply. `work` names the
  // group to split (use memory_organize dryRun / the LTM page to see existing work keys).
  ctx.effect(() => {
    let dispose = null;
    try {
      dispose = ctx.tools.register(
        defineTool({
          name: "memory_split",
          description:
            "Split ONE over-merged long-term-memory work into sub-groups (the inverse of " +
            "merging). Use when a work in LTM has clearly been over-merged and mixes several " +
            "different jobs. TWO-STEP: call with work=<key> and dryRun=true to get the proposed " +
            "partition (nothing changes), show it to the user; if approved, call again with the " +
            "same work and planJson=<the returned plan JSON> to apply. A single dryRun=false call " +
            "splits at once. Find work keys via memory_organize dryRun or the LTM page.",
          parameters: {
            work: {
              type: "string",
              required: true,
              description: "The work key to split, e.g. 'work:acs'.",
            },
            dryRun: {
              type: "boolean",
              description: "true = only return the proposed partition, do not modify memory.",
            },
            mode: {
              type: "string",
              description: "Split tightness: 'conservative' (default) or 'balanced'.",
            },
            planJson: {
              type: "string",
              description:
                "An approved partition as a JSON string, e.g. " +
                "'[{\"name\":\"子组A\",\"members\":[0,2]},{\"name\":\"子组B\",\"members\":[1,3]}]'. " +
                "Members are the m<index> numbers from the dryRun preview. Pass to APPLY.",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                ok: { type: "boolean", required: true },
                dryRun: { type: "boolean" },
                work: { type: "string", required: true },
                members: { type: "integer", required: true },
                groups: { type: "integer", required: true },
                moved: { type: "integer", required: true },
                pivotsCreated: { type: "integer", required: true },
                reason: { type: "string" },
                planJson: { type: "string" },
              },
            },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value ?? {}, null, 2) }],
          },
          async execute(args) {
            const a = args ?? {};
            try {
              let plan;
              if (typeof a.planJson === "string" && a.planJson.trim() !== "") {
                let rows = [];
                try {
                  rows = JSON.parse(a.planJson);
                } catch {
                  return { ok: false, work: String(a.work ?? ""), members: 0, groups: 0, moved: 0, pivotsCreated: 0, reason: "planJson is not valid JSON" };
                }
                if (Array.isArray(rows) && rows.length > 0) {
                  plan = rows;
                }
              }
              const res = await splitWork(currentAgent?.(), ctx.get?.("llm", false), a.work, {
                dryRun: a.dryRun === true,
                mode: a.mode === "balanced" ? "balanced" : "conservative",
                ...(plan ? { plan } : {}),
              });
              const planJson =
                Array.isArray(res?.plan) && res.plan.length > 0 ? JSON.stringify(res.plan) : undefined;
              return {
                ok: res?.ok === true,
                dryRun: res?.dryRun === true,
                work: String(res?.work ?? a.work ?? ""),
                members: Number(res?.members) || 0,
                groups: Number(res?.groups) || 0,
                moved: Number(res?.moved) || 0,
                pivotsCreated: Number(res?.pivotsCreated) || 0,
                ...(typeof res?.reason === "string" ? { reason: res.reason } : {}),
                ...(planJson ? { planJson } : {}),
              };
            } catch (error) {
              return {
                ok: false, work: String(a.work ?? ""), members: 0, groups: 0, moved: 0, pivotsCreated: 0,
                reason: String(error?.message ?? error),
              };
            }
          },
        }),
      );
    } catch (error) {
      try {
        const p = pathJoin(homedir(), ".dsh", "storages", "memory-split-register-error.txt");
        writeFileSync(p, `${new Date().toISOString()}\n${error?.stack ?? error?.message ?? error}\n`);
      } catch {
        /* ignore */
      }
      logger?.warn?.(`memory_split tool registration skipped: ${error?.message ?? error}`);
      return () => {};
    }
    return () => dispose?.();
  }, "dsh-memory split tool");

  // --- v11: Settings-page transport (live, no-reload edits).
  //
  // The DSH settings service only exposes `.volatile()` fields (see `Config`),
  // and third-party namespaces are NOT served to the settings RPC domain — so,
  // exactly like dsh-better-sidebar, this plugin serves its own fenced read/write
  // face over the 7788 view server. The face resolves the plugin ROW id and calls
  // `describe`/`update`, so a value written here is the SAME live config the
  // settings service would write, folded straight into this fiber's volatile refs.
  let settingsFace;
  ctx.inject(["settings"], (sctx) => {
    const ns = ownEntryId(ctx);
    if (ns === undefined) {
      logger?.warn?.("dsh-memory: no loader row found; the Settings page will report 'unavailable'");
      return;
    }
    const viewOf = () => {
      const row = sctx.settings.describe({ redactSecrets: true }).find((c) => c.ns === ns);
      return row === undefined
        ? { value: undefined, revision: undefined, writable: false }
        : { value: pickLive(row.value), revision: row.revision, writable: true };
    };
    settingsFace = {
      get: () => viewOf(),
      update: async (patch, expectedRevision) => {
        const live = {};
        for (const [key, value] of Object.entries(patch ?? {})) {
          if (LIVE_FIELDS.includes(key)) live[key] = value;
        }
        if (Object.keys(live).length === 0) throw new Error("no live fields in patch");
        await sctx.settings.update(ns, live, expectedRevision);
        return viewOf();
      },
    };
  });

  // --- v9: LTM 记忆视图本地服务（侧栏「记忆」tab 的「打开 LTM 页面」按钮指向它）。
  //
  // 为什么在宿主半起服务而不是客户端：浏览器（客户端半）没有起进程的权限，而宿主 Node
  // 半有。插件加载时在 127.0.0.1:7788 起一个只读 http 服务，退出桌面端/卸载插件即停。
  // 纯只读、不轮询、不写盘；端口被占则静默放弃（返回 null），绝不拖垮折叠/召回等核心功能。
  // 用 ctx.effect 包裹，卸载时自动 close。
  ctx.effect(() => {
    let handle = null;
    try {
      // onOrganize: the LTM page's "整理全部记忆" button POSTs /organize with an optional
      // body { dryRun?:true, plan?:[{from,to}] }. Step 1 (dryRun) returns the proposed
      // plan without writing; step 2 (plan) applies the approved mapping. Two-step keeps
      // the whole-store merge human-confirmed (档3).
      handle = startLtmViewServer({
        port: 7788,
        getContext: () => lastContextDetail,
        getSettings: () => settingsFace,
        updateSettings: async (patch, expectedRevision) => {
          if (settingsFace === undefined) throw new Error("settings service not mounted in this host");
          return settingsFace.update(patch, expectedRevision);
        },
        // v12: self-tree (自我认知) read/write. The store file is the durable source
        // of truth `publishSelf` prefers, so an edit here persists across sessions.
        getSelf: () => selfView(readSelfState()),
        updateSelf: (nodes, expectedRevision) => selfView(writeSelfOverride(nodes, expectedRevision)),
        resetSelf: () => selfView(resetSelfOverride()),
        onOrganize: (payload) => {
          const p = payload ?? {};
          let mapping;
          if (Array.isArray(p.plan) && p.plan.length > 0) {
            mapping = {};
            for (const row of p.plan) {
              const to = typeof row?.to === "string" ? row.to : "";
              if (to === "") continue;
              for (const k of Array.isArray(row?.from) ? row.from : []) {
                if (typeof k === "string" && k !== "") mapping[k] = to;
              }
            }
          }
          return organizeAllWorks(currentAgent?.(), ctx.get?.("llm", false), {
            dryRun: p.dryRun === true,
            mode: p.mode === "balanced" ? "balanced" : "conservative",
            ...(mapping && Object.keys(mapping).length > 0 ? { mapping } : {}),
          });
        },
        // onSplit: the LTM page's "✂️ 拆分组" button POSTs /split with
        // { work: "work:xxx", dryRun?:true, plan?:[{name,members:[...]}] }. Same two-step
        // shape as organize: dryRun previews the partition, plan applies it (档3).
        onSplit: (payload) => {
          const p = payload ?? {};
          const work = typeof p.work === "string" ? p.work : "";
          const plan = Array.isArray(p.plan) && p.plan.length > 0 ? p.plan : undefined;
          return splitWork(currentAgent?.(), ctx.get?.("llm", false), work, {
            dryRun: p.dryRun === true,
            mode: p.mode === "balanced" ? "balanced" : "conservative",
            ...(plan ? { plan } : {}),
          });
        },
      });
      if (handle && !handle.failed) {
        logger?.info?.(`LTM 记忆视图服务已启动: http://127.0.0.1:${handle.port}`);
      }
    } catch (e) {
      logger?.warn?.(`LTM 记忆视图服务启动失败（忽略）: ${e?.message ?? e}`);
    }
    return () => {
      try {
        handle?.close?.();
      } catch {
        /* ignore */
      }
    };
  }, "dsh-memory ltm view server");
}
