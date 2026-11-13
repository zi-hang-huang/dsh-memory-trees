/**
 * v11 记忆设置页 — DSH 设置壳里的独立「记忆」一栏（浏览器半）。
 *
 * 为什么是自绘页面而不是自动表单：DSH 设置服务只把 `.volatile()` 字段放进
 * 自动表单，而第三方 namespace 又不对设置 RPC 域开放（better-sidebar 注释亦
 * 如此）。所以本页不走 configForms，而是直连插件宿主半在 127.0.0.1:7788 起的
 * fenced 服务（已在跑，面板的 /context.json 就用它）：
 *   GET  /settings.get     → { ok, value:{7 个字段}, revision, writable }
 *   POST /settings.update  → { ok, value, revision } | 409 冲突 | 400 校验拒绝
 * 宿主把写操作转成 settings.update(ns, …)，落到插件的 volatile 引用上 —— 与
 * 设置服务自己写的是同一份 live 配置，改完即时生效、无需重启。
 *
 * 注册：ctx.slots.inject('settings.section', …) —— 等外壳声明了槽位才注册，
 * 部署没装设置壳时静默不出现。
 */
import * as React from "react";

/** 宿主 7788 服务地址（与 MemoryView 里的 LTM_URL 同一个服务）。 */
const HOST_URL = "http://127.0.0.1:7788";

type LiveValue = {
  retainTokens?: number;
  volatileBudget?: number;
  recallEnabled?: boolean;
  recallTopK?: number;
  distillPolicy?: "rules" | "llm";
  selfEnabled?: boolean;
  verbose?: boolean;
};

/** 顶层命名空间，避免与设置壳或他插件撞 key。 */
export const SETTINGS_NS = "dsh-memory.settings";

const C = {
  label: "var(--dsw-alias-label-primary, #e6e6e6)",
  sub: "var(--dsw-alias-label-secondary, #a8a8a8)",
  tertiary: "var(--dsw-alias-label-tertiary, #8a8a8a)",
  border: "var(--dsw-alias-border-l2, #3a3a3d)",
  card: "var(--dsw-alias-layer-2, #26262a)",
  accent: "var(--dsw-alias-state-business-primary, #5b8def)",
  danger: "#e07b7b",
  ok: "#6ec07a",
};

const NUM_FIELDS: Array<{ key: "retainTokens" | "volatileBudget" | "recallTopK"; label: string; hint: string }> = [
  { key: "retainTokens", label: "保留窗口（tokens）", hint: "逐字保留的尾部预算。最该调的一个：太小会频繁折叠，太大则每轮更贵。最小 1000。" },
  { key: "volatileBudget", label: "短期记忆区（tokens）", hint: "易变（短期）区预算。实测 2500 与 5000 折叠次数相同，只影响每次折叠的体积。" },
  { key: "recallTopK", label: "召回候选数", hint: "预算裁剪前先排序多少个候选。排得比展示的多，裁剪时去掉的是最弱的。" },
];

const BOOL_FIELDS: Array<{ key: "recallEnabled" | "selfEnabled" | "verbose"; label: string; hint: string }> = [
  { key: "recallEnabled", label: "启用召回", hint: "关闭后同时停用 pre-step 召回块与 memory_recall 工具（一个开关，二者不会打架）。" },
  { key: "selfEnabled", label: "发布自我认知", hint: "把 self 树作为一条 memory:self 消息挂在 surface 尾部。" },
  { key: "verbose", label: "详细日志", hint: "把每次折叠决策写进插件日志，排查问题用。" },
];

function row(children: React.ReactNode, key: string) {
  return React.createElement(
    "div",
    {
      key,
      style: {
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
        padding: "12px 0", borderTop: `0.5px solid ${C.border}`,
      },
    },
    children,
  );
}

function textBlock(label: string, hint: string) {
  return React.createElement(
    "div",
    { style: { minWidth: 0 } },
    React.createElement("div", { style: { color: C.label, fontSize: 13, fontWeight: 500 } }, label),
    React.createElement("div", { style: { color: C.tertiary, fontSize: 12, marginTop: 2, lineHeight: 1.5 } }, hint),
  );
}

function numberInput(value: number | undefined, disabled: boolean, onChange: (v: number | undefined) => void) {
  return React.createElement("input", {
    type: "number",
    value: value === undefined ? "" : String(value),
    disabled,
    onChange: (e: any) => {
      const t = e?.target?.value ?? "";
      const n = Number(t);
      onChange(t.trim() === "" || Number.isNaN(n) ? undefined : n);
    },
    style: {
      width: 120, flex: "0 0 auto", textAlign: "right",
      font: "inherit", fontSize: 13, padding: "6px 8px", borderRadius: 6,
      border: `1px solid ${C.border}`, background: "#1e1e21", color: C.label,
      colorScheme: "dark" as any,
    },
  });
}

function switchControl(checked: boolean, disabled: boolean, onToggle: () => void) {
  return React.createElement(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": checked,
      disabled,
      onClick: onToggle,
      style: {
        flex: "0 0 auto", width: 40, height: 22, borderRadius: 11, border: 0, padding: 0,
        cursor: disabled ? "default" : "pointer", position: "relative",
        background: checked ? C.accent : "#4a4a4f", opacity: disabled ? 0.6 : 1,
        transition: "background .15s",
      },
    },
    React.createElement("span", {
      style: {
        position: "absolute", top: 2, left: checked ? 20 : 2, width: 18, height: 18, borderRadius: 9,
        background: "#fff", transition: "left .15s",
      },
    }),
  );
}

function selectControl(value: string | undefined, disabled: boolean, onChange: (v: string) => void) {
  return React.createElement(
    "select",
    {
      value: value ?? "rules",
      disabled,
      onChange: (e: any) => onChange(e?.target?.value ?? "rules"),
      style: {
        flex: "0 0 auto", width: 140, font: "inherit", fontSize: 13, padding: "6px 8px",
        borderRadius: 6, border: `1px solid ${C.border}`, background: "#1e1e21", color: C.label,
        colorScheme: "dark" as any,
      },
    },
    React.createElement("option", { value: "rules" }, "规则（rules）"),
    React.createElement("option", { value: "llm" }, "模型蒸馏（llm）"),
  );
}

/** 自我认知节点（与宿主 /self.* 传输一致）。 */
type SelfNode = { id?: string; kind?: string; order?: number; title: string; body: string };
type SelfView = { nodes: SelfNode[]; revision: number; exists: boolean; kinds?: string[] };

/** kind 的展示名。 */
const KIND_LABELS: Record<string, string> = {
  identity: "身份",
  preference: "偏好",
  constraint: "约束",
  fact: "事实",
  entity: "实体",
  task: "任务",
  decision: "决定",
  question: "疑问",
  episode: "片段",
  skill: "技能",
};

function kindLabel(kind: string | undefined): string {
  return (kind && KIND_LABELS[kind]) || "约束";
}

/** 一条自我认知的编辑卡片：标题 / 类别 / 正文 / 删除。 */
function selfCard(
  node: SelfNode,
  index: number,
  disabled: boolean,
  onChange: (patch: Partial<SelfNode>) => void,
  onRemove: () => void,
  canRemove: boolean,
  kinds: string[],
) {
  const inputStyle: any = {
    width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13,
    padding: "7px 9px", borderRadius: 6, border: `1px solid ${C.border}`,
    background: "#1e1e21", color: C.label, colorScheme: "dark",
  };
  return React.createElement(
    "div",
    {
      key: node.id || `new-${index}`,
      style: { border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", marginTop: 10, background: "#212124" },
    },
    React.createElement(
      "div",
      { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } },
      React.createElement("input", {
        value: node.title ?? "",
        disabled,
        placeholder: "标题（如：身份 / 边界）",
        onChange: (e: any) => onChange({ title: e?.target?.value ?? "" }),
        style: { ...inputStyle, flex: "1 1 auto", fontWeight: 600 },
      }),
      React.createElement(
        "select",
        {
          value: node.kind ?? "constraint",
          disabled,
          onChange: (e: any) => onChange({ kind: e?.target?.value ?? "constraint" }),
          style: { ...inputStyle, width: 96, flex: "0 0 auto" },
        },
        (kinds.length ? kinds : ["identity", "preference", "constraint"]).map((k) =>
          React.createElement("option", { key: k, value: k }, kindLabel(k)),
        ),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          disabled: disabled || !canRemove,
          title: canRemove ? "删除这一条" : "至少保留一条",
          onClick: onRemove,
          style: {
            flex: "0 0 auto", font: "inherit", fontSize: 12, padding: "6px 10px", borderRadius: 6,
            border: `1px solid ${C.border}`, background: "transparent",
            color: canRemove ? C.danger : C.tertiary,
            cursor: disabled || !canRemove ? "default" : "pointer", opacity: canRemove ? 1 : 0.5,
          },
        },
        "删除",
      ),
    ),
    React.createElement("textarea", {
      value: node.body ?? "",
      disabled,
      placeholder: "这一条的具体内容（≤600 字）",
      rows: 2,
      onChange: (e: any) => onChange({ body: e?.target?.value ?? "" }),
      style: { ...inputStyle, resize: "vertical", lineHeight: 1.5 },
    }),
  );
}

/**
 * v12 自我认知编辑区。
 *
 * 单独成组件，状态与「偏好设置」那张卡完全隔离：自我认知走的是另一条存储
 * （~/.dsh/storages/dsh_memory_self.json），改它不该让偏好表单变脏，反之亦然。
 * 保存后宿主把它落盘，`publishSelf` 下一次 pre-step 就用新内容重发——跨会话生效。
 */
function SelfEditor() {
  const [loading, setLoading] = React.useState(true);
  const [unavailable, setUnavailable] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<SelfNode[]>([]);
  const [exists, setExists] = React.useState(false);
  const [revision, setRevision] = React.useState<number | undefined>(undefined);
  const [kinds, setKinds] = React.useState<string[]>([]);
  const [draft, setDraft] = React.useState<SelfNode[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = React.useCallback((body: any) => {
    setSaved(body.nodes || []);
    setDraft(body.nodes || []);
    setExists(body.exists === true);
    setRevision(body.revision);
    if (Array.isArray(body.kinds) && body.kinds.length) setKinds(body.kinds);
  }, []);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${HOST_URL}/self.get`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.status === 503) { setUnavailable(true); return; }
        if (!r.ok || !body || body.ok !== true) throw new Error((body && body.reason) || `HTTP ${r.status}`);
        setUnavailable(false);
        apply(body);
      })
      .catch((e: any) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [apply]);

  React.useEffect(load, [load]);

  const dirty = React.useMemo(() => {
    try { return JSON.stringify(saved) !== JSON.stringify(draft); } catch { return true; }
  }, [saved, draft]);

  const editNode = React.useCallback((index: number, patch: Partial<SelfNode>) => {
    setDraft((prev) => prev.map((n, i) => (i === index ? { ...n, ...patch } : n)));
    setStatus(null);
  }, []);

  const addNode = React.useCallback(() => {
    setDraft((prev) => [...prev, { title: "", body: "", kind: "constraint" }]);
    setStatus(null);
  }, []);

  const removeNode = React.useCallback((index: number) => {
    setDraft((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
    setStatus(null);
  }, []);

  const save = React.useCallback(() => {
    if (saving) return;
    // Client-side mirror of the host validation, so the common mistakes get an
    // inline message instead of a round-trip.
    for (let i = 0; i < draft.length; i += 1) {
      if ((draft[i].title ?? "").trim() === "") {
        setStatus({ kind: "err", text: `第 ${i + 1} 条缺少标题。` });
        return;
      }
      if ((draft[i].body ?? "").length > 600) {
        setStatus({ kind: "err", text: `第 ${i + 1} 条正文超过 600 字。` });
        return;
      }
    }
    setSaving(true);
    setStatus(null);
    fetch(`${HOST_URL}/self.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ nodes: draft, expectedRevision: revision }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.status === 409) throw new Error("自我认知已被别处修改，已为你刷新最新内容，请重新编辑。");
        if (!r.ok || !body || body.ok !== true) throw new Error((body && body.reason) || `HTTP ${r.status}`);
        apply(body);
        setStatus({ kind: "ok", text: "已保存，下一步起生效（跨会话保留）。" });
      })
      .catch((e: any) => {
        setStatus({ kind: "err", text: String(e?.message ?? e) });
        load();
      })
      .finally(() => setSaving(false));
  }, [draft, revision, saving, apply, load]);

  const reset = React.useCallback(() => {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    fetch(`${HOST_URL}/self.reset`, { method: "POST", cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body || body.ok !== true) throw new Error((body && body.reason) || `HTTP ${r.status}`);
        apply(body);
        setStatus({ kind: "ok", text: "已恢复默认四条。" });
      })
      .catch((e: any) => setStatus({ kind: "err", text: String(e?.message ?? e) }))
      .finally(() => setSaving(false));
  }, [saving, apply]);

  const header = React.createElement(
    "div",
    { style: { marginTop: 22, marginBottom: 4 } },
    React.createElement("h2", { style: { margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: C.label } }, "自我认知"),
    React.createElement(
      "p",
      { style: { margin: 0, color: C.tertiary, fontSize: 12, lineHeight: 1.6 } },
      "这份文本会作为「你是谁、怎么做事」的自我认知附在对话里。保存后写盘，新会话也会沿用；改完可随时恢复默认。",
    ),
  );

  if (loading) {
    return React.createElement("div", { style: { padding: "14px 4px", color: C.tertiary, fontSize: 13 } }, "正在读取自我认知…");
  }
  if (unavailable) {
    return React.createElement(
      "div",
      { style: { maxWidth: 720, padding: "4px 4px 24px" } },
      header,
      React.createElement(
        "div",
        { style: { color: C.tertiary, fontSize: 13, lineHeight: 1.6, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", background: C.card } },
        "本机没有可用的记忆服务（7788 未启动或插件未挂载），暂无法编辑自我认知。重启 DSH 桌面端后重试。",
      ),
    );
  }
  if (error && draft.length === 0) {
    return React.createElement(
      "div",
      { style: { maxWidth: 720, padding: "4px 4px 24px" } },
      header,
      React.createElement(
        "div",
        { style: { color: C.danger, fontSize: 13, lineHeight: 1.6 } },
        `读取失败：${error}`,
        React.createElement("button", {
          onClick: load,
          style: { marginLeft: 10, font: "inherit", fontSize: 12, padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.label, cursor: "pointer" },
        }, "重试"),
      ),
    );
  }

  const disabled = saving;
  const footer = React.createElement(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" } },
    React.createElement("button", {
      onClick: addNode,
      disabled: disabled,
      style: {
        font: "inherit", fontSize: 13, padding: "7px 14px", borderRadius: 8,
        border: `1px dashed ${C.border}`, background: "transparent", color: C.label,
        cursor: disabled ? "default" : "pointer",
      },
    }, "＋ 新增一条"),
    React.createElement("button", {
      onClick: save,
      disabled: disabled || !dirty,
      style: {
        font: "inherit", fontSize: 13, padding: "8px 18px", borderRadius: 8, border: 0,
        cursor: disabled || !dirty ? "default" : "pointer",
        background: disabled || !dirty ? "#3a3a3f" : C.accent, color: "#fff", opacity: disabled || !dirty ? 0.7 : 1,
      },
    }, saving ? "保存中…" : "保存自我认知"),
    React.createElement("button", {
      onClick: () => { setDraft(saved); setStatus(null); },
      disabled: disabled || !dirty,
      style: {
        font: "inherit", fontSize: 13, padding: "8px 14px", borderRadius: 8,
        border: `1px solid ${C.border}`, background: "transparent", color: C.label,
        cursor: disabled || !dirty ? "default" : "pointer", opacity: disabled || !dirty ? 0.6 : 1,
      },
    }, "撤销修改"),
    React.createElement("button", {
      onClick: reset,
      disabled: disabled,
      style: {
        font: "inherit", fontSize: 13, padding: "8px 14px", borderRadius: 8,
        border: `1px solid ${C.border}`, background: "transparent", color: C.tertiary,
        cursor: disabled ? "default" : "pointer",
      },
    }, "恢复默认"),
    status
      ? React.createElement("span", { style: { color: status.kind === "ok" ? C.ok : C.danger, fontSize: 12 } }, status.text)
      : null,
  );

  return React.createElement(
    "div",
    { style: { maxWidth: 720, padding: "0 4px 24px", color: C.label } },
    header,
    React.createElement(
      "div",
      { style: { color: C.tertiary, fontSize: 11, marginTop: 6 } },
      exists ? `当前使用自定义版本（revision ${revision}）。` : "当前是内置默认四条，保存后将替换为你的版本。",
    ),
    draft.map((node, i) =>
      selfCard(
        node, i, disabled,
        (patch) => editNode(i, patch),
        () => removeNode(i),
        draft.length > 1,
        kinds,
      ),
    ),
    footer,
  );
}

export function SettingsPage(_props: any) {  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [writable, setWritable] = React.useState(false);
  const [revision, setRevision] = React.useState<number | undefined>(undefined);
  const [saved, setSaved] = React.useState<LiveValue>({});        // last accepted (server truth)
  const [draft, setDraft] = React.useState<LiveValue>({});        // editing buffer
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${HOST_URL}/settings.get`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.status === 503) { setUnavailable(true); return; }
        if (!r.ok || !body || body.ok !== true) throw new Error((body && body.reason) || `HTTP ${r.status}`);
        setSaved(body.value || {});
        setDraft(body.value || {});
        setRevision(body.revision);
        setWritable(body.writable === true);
        setUnavailable(false);
      })
      .catch((e: any) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  const dirty = React.useMemo(() => {
    try { return JSON.stringify(saved) !== JSON.stringify(draft); } catch { return true; }
  }, [saved, draft]);

  const edit = React.useCallback((key: keyof LiveValue, value: any) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  }, []);

  const save = React.useCallback(() => {
    if (!writable || saving) return;
    // Client-side guard mirrors the host's own schema: retainTokens >= 1000.
    if (typeof draft.retainTokens === "number" && draft.retainTokens < 1000) {
      setStatus({ kind: "err", text: "保留窗口至少 1000 tokens（更小的窗口会让每一步都折叠整段历史）。" });
      return;
    }
    setSaving(true);
    setStatus(null);
    fetch(`${HOST_URL}/settings.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ patch: draft, expectedRevision: revision }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.status === 409) throw new Error("设置已被别处修改，已为你刷新最新值，请重新修改。");
        if (!r.ok || !body || body.ok !== true) throw new Error((body && body.reason) || `HTTP ${r.status}`);
        setSaved(body.value || {});
        setDraft(body.value || {});
        setRevision(body.revision);
        setStatus({ kind: "ok", text: "已保存，即时生效（无需重启）。" });
      })
      .catch((e: any) => {
        setStatus({ kind: "err", text: String(e?.message ?? e) });
        // A conflict/refusal means our draft is stale — pull the host truth.
        load();
      })
      .finally(() => setSaving(false));
  }, [draft, revision, writable, saving, load]);

  const reset = React.useCallback(() => setDraft(saved), [saved]);

  const header = React.createElement(
    "div",
    { style: { marginBottom: 8 } },
    React.createElement("h2", { style: { margin: "0 0 4px", fontSize: 18, fontWeight: 600, color: C.label } }, "记忆"),
    React.createElement(
      "p",
      { style: { margin: 0, color: C.tertiary, fontSize: 13, lineHeight: 1.6 } },
      "调整 dsh-memory 的上下文折叠与召回偏好。保存后即时生效，无需重启。",
    ),
  );

  if (loading) {
    return React.createElement("div", { style: { padding: "14px 4px", color: C.tertiary, fontSize: 13 } }, "正在读取记忆设置…");
  }
  if (unavailable) {
    return React.createElement(
      "div",
      { style: { padding: "14px 4px", display: "flex", flexDirection: "column", gap: 8 } },
      header,
      React.createElement(
        "div",
        { style: { color: C.tertiary, fontSize: 13, lineHeight: 1.6, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", background: C.card } },
        "本机没有可用的设置服务（7788 未启动或插件未挂载）。记忆仍按配置文件运行；重启 DSH 桌面端后重试即可。",
      ),
    );
  }
  if (error && !saved.retainTokens && !Object.keys(draft).length) {
    return React.createElement(
      "div",
      { style: { padding: "14px 4px", display: "flex", flexDirection: "column", gap: 8 } },
      header,
      React.createElement(
        "div",
        { style: { color: C.danger, fontSize: 13, lineHeight: 1.6 } },
        `读取失败：${error}`,
        React.createElement("button", {
          onClick: load,
          style: { marginLeft: 10, font: "inherit", fontSize: 12, padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.label, cursor: "pointer" },
        }, "重试"),
      ),
    );
  }

  const disabled = !writable || saving;

  const rows: React.ReactNode[] = [];

  // Distillation policy first (most conceptual).
  rows.push(
    row([
      textBlock("蒸馏方式", "rules：确定性摘录（便宜、可预测）；llm：让路由模型总结，范围不够大时会退回 rules。"),
      selectControl(draft.distillPolicy, disabled, (v) => edit("distillPolicy", v)),
    ], "distillPolicy"),
  );
  for (const f of NUM_FIELDS) {
    rows.push(row([textBlock(f.label, f.hint), numberInput(draft[f.key], disabled, (v) => edit(f.key, v))], f.key));
  }
  for (const f of BOOL_FIELDS) {
    rows.push(row([textBlock(f.label, f.hint), switchControl(draft[f.key] === true, disabled, () => edit(f.key, !(draft[f.key] === true)))], f.key));
  }

  const footer = React.createElement(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 18, flexWrap: "wrap" } },
    React.createElement("button", {
      onClick: save,
      disabled: disabled || !dirty,
      style: {
        font: "inherit", fontSize: 13, padding: "8px 18px", borderRadius: 8, border: 0,
        cursor: disabled || !dirty ? "default" : "pointer",
        background: disabled || !dirty ? "#3a3a3f" : C.accent, color: "#fff", opacity: disabled || !dirty ? 0.7 : 1,
      },
    }, saving ? "保存中…" : "保存"),
    React.createElement("button", {
      onClick: reset,
      disabled: disabled || !dirty,
      style: {
        font: "inherit", fontSize: 13, padding: "8px 14px", borderRadius: 8,
        border: `1px solid ${C.border}`, background: "transparent", color: C.label,
        cursor: disabled || !dirty ? "default" : "pointer", opacity: disabled || !dirty ? 0.6 : 1,
      },
    }, "撤销修改"),
    !writable
      ? React.createElement("span", { style: { color: C.tertiary, fontSize: 12 } }, "本部署的设置为只读。")
      : null,
    status
      ? React.createElement("span", { style: { color: status.kind === "ok" ? C.ok : C.danger, fontSize: 12 } }, status.text)
      : null,
  );

  return React.createElement(
    "div",
    { style: { maxWidth: 720, padding: "4px 4px 24px", color: C.label } },
    header,
    React.createElement("div", { style: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "2px 16px 4px", marginTop: 8 } }, rows),
    footer,
    React.createElement("div", { style: { marginTop: 14, color: C.tertiary, fontSize: 11, lineHeight: 1.6 } },
      "其余内部参数（admitKinds / barrierKinds / LTM 容量等）仍通过 profile 的 cordis.patch.yml 调整 —— 它们会改变插件结构，不适合热改。"),
    React.createElement("div", { style: { marginTop: 6, color: "#5e5e64", fontSize: 10, fontFamily: "monospace" } }, "dsh-memory settings v12"),
    React.createElement(SelfEditor, null),
  );
}
