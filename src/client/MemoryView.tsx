/**
 * v9 记忆面板组件 — 上下文 + LTM 双区。
 *
 * 上半「上下文组成」：读官方 dsh-token-meter 投影（contextBreakdown / contextPressure），
 *   显示 system/tools/message token 条 + 占用率。真数据，不依赖 dsh-context（同一份官方投影）。
 *   投影在浏览器运行时由宿主提供，通过 panel/tab 组件 props 的 useProjection(key) 读取。
 * 下半「长期记忆」：LTM 是跨会话全局存储（dsh_memory.json），不在会话事件投影里，
 *   故只放一个「打开 LTM 页面」按钮 → 本地 7788 服务（见 lib/ltm-view.js）。
 *
 * 注意：本文件是浏览器半（client bundle）源码，由 tsdown 打包成
 * window.__ModuleLoader__.load({ factory }) 形态。React 由宿主提供，走 require。
 */
import * as React from "react";

/** LTM 页面默认地址（插件宿主半自起的服务，端口 7788）。 */
const LTM_URL = "http://127.0.0.1:7788";

function fmt(n: number) {
  return typeof n === "number" && isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/** 从 props.useProjection 读一个投影键并校验；读不到返回 null。 */
function readProjection(props: any, key: string): any {
  try {
    const up = props?.useProjection;
    if (typeof up !== "function") return null;
    const v = up(key);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** 上下文组成条 + 占用率。 */
function ContextSection(props: { props: any }) {
  const bd = readProjection(props.props, "contextBreakdown");
  const pressureProj = readProjection(props.props, "contextPressure");

  // contextBreakdown 形状（官方）：breakdown.systemTokens/toolsTokens/messageTokens
  const b = bd?.breakdown ?? bd ?? null;
  const sys = b?.systemTokens ?? null;
  const tools = b?.toolsTokens ?? null;
  const msg = b?.messageTokens ?? null;
  const hasBreakdown = typeof sys === "number" || typeof tools === "number" || typeof msg === "number";
  const total = (sys || 0) + (tools || 0) + (msg || 0);

  // contextPressure 形状（官方取证，token-meter usage-projection.js）：
  //   { contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }
  // 真实占用率 = (pressureTokens ?? surfaceTokens) / contextWindow。
  let pressure: number | null = null;
  let windowTokens: number | null = null;
  let usedTokens: number | null = null;
  const pp = pressureProj as any;
  if (pp && typeof pp === "object") {
    const cw = typeof pp.contextWindow === "number" ? pp.contextWindow : null;
    const pt = typeof pp.pressureTokens === "number" ? pp.pressureTokens : null;
    const st = typeof pp.surfaceTokens === "number" ? pp.surfaceTokens : null;
    windowTokens = cw;
    usedTokens = pt ?? st;
    if (cw && cw > 0 && usedTokens != null) pressure = usedTokens / cw;
  }

  // v10: per-message detail from the host view server (7788 /context.json).
  const [ctxDetail, setCtxDetail] = React.useState<any>(null);
  const [detailErr, setDetailErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [openBuckets, setOpenBuckets] = React.useState<Record<string, boolean>>({});

  const loadDetail = React.useCallback(() => {
    setLoading(true);
    setDetailErr(null);
    try {
      fetch(`${LTM_URL}/context.json`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => setCtxDetail(data && typeof data === "object" ? data : { ready: false }))
        .catch((e: any) => setDetailErr(String(e?.message ?? e)))
        .finally(() => setLoading(false));
    } catch (e: any) {
      setDetailErr(String(e?.message ?? e));
      setLoading(false);
    }
  }, []);

  const toggleBucket = React.useCallback((key: string) => {
    setOpenBuckets((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const legend = (color: string, label: string, val: number | null) =>
    React.createElement(
      "span",
      { style: { display: "inline-flex", alignItems: "center", marginRight: 12, fontSize: 11, color: "#8a8a8a" } },
      React.createElement("span", { style: { width: 8, height: 8, borderRadius: 2, background: color, marginRight: 4, display: "inline-block" } }),
      `${label} ${fmt(val as any)}`,
    );

  // Bucket colour, matching the top bar: system blue, tools amber, assistant/user green.
  const bucketColor = (key: string) => (key === "system" ? "#5b8def" : key === "tools" ? "#e0a64b" : "#6ec07a");

  const renderRow = (row: any) =>
    React.createElement(
      "div",
      {
        key: `row-${row.seq}`,
        style: {
          display: "flex", alignItems: "baseline", gap: 6, padding: "3px 0 3px 8px",
          borderLeft: `2px solid ${bucketColor(row.bucket)}`, marginBottom: 2, fontSize: 11, flexWrap: "wrap",
        },
      },
      React.createElement("span", { style: { color: "#9fb4d8", minWidth: 30, fontFamily: "monospace" } }, `#${row.seq}`),
      React.createElement("span", { style: { color: "#cfcfcf", minWidth: 54 } }, `${row.role}`),
      row.toolNames && row.toolNames.length > 0
        ? React.createElement("span", { style: { color: "#e0a64b", minWidth: 0 } }, `🔧${row.toolNames.join(",")}`)
        : null,
      React.createElement("span", { style: { color: "#8a8a8a", marginLeft: "auto", whiteSpace: "nowrap" } }, `${fmt(row.tokens)} tok · ${fmt(row.chars)} 字`),
      row.preview
        ? React.createElement("div", { style: { color: "#7a7a7a", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%", flexBasis: "100%" } }, row.preview)
        : null,
    );

  const renderBuckets = () => {
    if (!ctxDetail) return null;
    if (ctxDetail.ready === false) {
      return React.createElement("div", { style: { color: "#888", fontSize: 11, padding: "4px 0" } }, "（还没有本步骤快照，发一条消息后重试）");
    }
    const buckets = Array.isArray(ctxDetail.buckets) ? ctxDetail.buckets : [];
    return React.createElement(
      "div",
      { style: { marginTop: 6 } },
      // 汇总行固定在滚动区之外，滚动明细时「共 N 条」不会跟着滚走。
      React.createElement("div", { style: { fontSize: 10, color: "#8a8a8a", marginBottom: 4 } }, `共 ${fmt(ctxDetail.totalRows)} 条 · 合计 ${fmt(ctxDetail.totalTokens)} tok（启发式）`),
      // v10-fix: 展开后行数可达上百条，容器原来既无高度上限也无 overflow ——
      // 内容超出可视区就被面板直接裁掉，看不见也够不着。改为限高 + 内部竖向滚动。
      React.createElement(
        "div",
        {
          style: {
            // 纯数字：React 会转成 340px，不依赖 vh / min() 的解析。
            maxHeight: 340,
            overflowY: "auto",
            overflowX: "hidden",
            paddingRight: 4,
            scrollbarWidth: "thin" as any,
            scrollbarColor: "#5a5a5f #26262a" as any,
          },
        },
        buckets.map((bucket: any) => {
        const isOpen = !!openBuckets[bucket.key];
        const empty = bucket.count === 0;
        return React.createElement(
          "div",
          { key: bucket.key, style: { marginBottom: 4, opacity: empty ? 0.5 : 1 } },
          React.createElement(
            "div",
            {
              onClick: empty ? undefined : () => toggleBucket(bucket.key),
              style: { display: "flex", alignItems: "center", gap: 6, cursor: empty ? "default" : "pointer", padding: "4px 6px", borderRadius: 4, background: "#2a2a2d" },
            },
            React.createElement("span", { style: { color: bucketColor(bucket.key), fontSize: 10 } }, empty ? "▫" : isOpen ? "▾" : "▸"),
            React.createElement("span", { style: { color: "#d0d0d0", fontSize: 12 } }, bucket.label),
            React.createElement("span", { style: { color: "#8a8a8a", fontSize: 10, marginLeft: "auto" } }, `${bucket.count} 条 · ${fmt(bucket.tokens)} tok`),
          ),
          isOpen ? React.createElement("div", { style: { marginTop: 2 } }, bucket.rows.map(renderRow)) : null,
        );
        }),
      ),
    );
  };

  return React.createElement(
    "div",
    { style: { marginBottom: 4 } },
    !hasBreakdown
      ? React.createElement("div", { style: { color: "#888", fontSize: 12, padding: "4px 0" } }, "（暂无上下文数据）")
      : React.createElement(
          "div",
          null,
          React.createElement(
            "div",
            { style: { display: "flex", height: 10, borderRadius: 5, overflow: "hidden", margin: "6px 0" } },
            React.createElement("div", { style: { width: `${total > 0 ? (sys || 0) / total * 100 : 0}%`, background: "#5b8def" } }),
            React.createElement("div", { style: { width: `${total > 0 ? (tools || 0) / total * 100 : 0}%`, background: "#e0a64b" } }),
            React.createElement("div", { style: { width: `${total > 0 ? (msg || 0) / total * 100 : 0}%`, background: "#6ec07a" } }),
          ),
          React.createElement(
            "div",
            { style: { marginBottom: 4 } },
            legend("#5b8def", "system", sys),
            legend("#e0a64b", "tools", tools),
            legend("#6ec07a", "message", msg),
          ),
          React.createElement(
            "div",
            { style: { fontSize: 11, color: "#8a8a8a" } },
            // 优先展示 contextPressure 的真实窗口占用（更可信）；无则退回 breakdown 启发式合计。
            pressure != null && windowTokens
              ? `窗口占用 ${fmt(usedTokens as any)} / ${fmt(windowTokens)} · ${Math.round(pressure * 100)}%`
              : `组成合计 ${fmt(total)} tokens（启发式）`,
          ),
        ),
    // 明细展开按钮 + 明细区
    React.createElement(
      "div",
      { style: { marginTop: 6, display: "flex", gap: 8, alignItems: "center" } },
      React.createElement(
        "button",
        {
          onClick: loadDetail,
          disabled: loading,
          style: {
            font: "inherit", fontSize: 11, padding: "4px 10px", borderRadius: 6,
            border: "1px solid #555", background: "#2d2d30", color: "#e6e6e6",
            cursor: loading ? "default" : "pointer",
          },
        },
        loading ? "加载中…" : ctxDetail ? "刷新明细" : "展开明细 ▸",
      ),
    ),
    detailErr
      ? React.createElement("div", { style: { color: "#e07b7b", fontSize: 10, marginTop: 4 } }, `明细加载失败：${detailErr}（需桌面端宿主在 7788 提供服务）`)
      : null,
    renderBuckets(),
  );
}

export function MemoryView(props: any) {
  const open = React.useCallback(() => {
    try {
      (globalThis as any).window?.open?.(LTM_URL, "_blank");
    } catch {
      /* 忽略 */
    }
  }, []);

  const sectionTitle = (text: string) =>
    React.createElement("div", { style: { fontWeight: 600, fontSize: 12, color: "#9fb4d8", margin: "14px 0 4px" } }, text);

  return React.createElement(
    "div",
    {
      style: {
        padding: "14px 16px", fontSize: 13, lineHeight: 1.6,
        // v10.1: 面板整体兜底滚动。明细区内部已单独滚动；这里再给根容器
        // 一个可滚动出口 —— 父级若给了确定高度（右侧栏通常如此），
        // 所有超长内容（明细 + 长期记忆 + 按钮）都能滚到；
        // 父级若高度 auto，这两条为空操作，不会更糟。
        height: "100%",
        maxHeight: "100%",
        boxSizing: "border-box",
        overflowY: "auto",
        overflowX: "hidden",
        scrollbarWidth: "thin" as any,
        scrollbarColor: "#5a5a5f #26262a" as any,
      },
    },
    // --- 上下文组成 ---
    sectionTitle("上下文组成"),
    React.createElement(ContextSection, { props }),
    // --- 长期记忆 ---
    sectionTitle("长期记忆"),
    React.createElement(
      "div",
      { style: { color: "#8a8a8a", fontSize: 12, marginBottom: 10 } },
      "work 分组、健康指标、召回预览与完整记忆树在独立页面查看（数据源 dsh_memory.json）。",
    ),
    React.createElement(
      "button",
      {
        onClick: open,
        style: {
          font: "inherit", fontSize: 13, padding: "8px 16px", borderRadius: 8,
          border: "1px solid #555", background: "#2d2d30", color: "#e6e6e6",
          cursor: "pointer", width: "100%",
        },
        onMouseEnter: (e: any) => { if (e?.currentTarget) e.currentTarget.style.background = "#3a3a3d"; },
        onMouseLeave: (e: any) => { if (e?.currentTarget) e.currentTarget.style.background = "#2d2d30"; },
      },
      "打开 LTM 页面 →",
    ),
    React.createElement(
      "div",
      { style: { marginTop: 10, color: "#8a8a8a", fontSize: 11 } },
      "地址：",
      React.createElement("code", { style: { color: "#9fb4d8" } }, LTM_URL),
    ),
    // 版本探针：改了 client bundle 后，肉眼就能确认页面是否真的加载了新代码。
    React.createElement(
      "div",
      { style: { marginTop: 4, color: "#5e5e64", fontSize: 10, fontFamily: "monospace" } },
      "client v10.1-scroll",
    ),
  );
}
