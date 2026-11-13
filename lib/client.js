window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/MemoryView.tsx
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
		/** LTM 页面默认地址（插件宿主半自起的服务，端口 7788）。 */
		const LTM_URL = "http://127.0.0.1:7788";
		function fmt(n) {
			return typeof n === "number" && isFinite(n) ? n.toLocaleString("en-US") : "—";
		}
		/** 从 props.useProjection 读一个投影键并校验；读不到返回 null。 */
		function readProjection(props, key) {
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
		function ContextSection(props) {
			const bd = readProjection(props.props, "contextBreakdown");
			const pressureProj = readProjection(props.props, "contextPressure");
			const b = bd?.breakdown ?? bd ?? null;
			const sys = b?.systemTokens ?? null;
			const tools = b?.toolsTokens ?? null;
			const msg = b?.messageTokens ?? null;
			const hasBreakdown = typeof sys === "number" || typeof tools === "number" || typeof msg === "number";
			const total = (sys || 0) + (tools || 0) + (msg || 0);
			let pressure = null;
			let windowTokens = null;
			let usedTokens = null;
			const pp = pressureProj;
			if (pp && typeof pp === "object") {
				const cw = typeof pp.contextWindow === "number" ? pp.contextWindow : null;
				const pt = typeof pp.pressureTokens === "number" ? pp.pressureTokens : null;
				const st = typeof pp.surfaceTokens === "number" ? pp.surfaceTokens : null;
				windowTokens = cw;
				usedTokens = pt ?? st;
				if (cw && cw > 0 && usedTokens != null) pressure = usedTokens / cw;
			}
			const [ctxDetail, setCtxDetail] = react.useState(null);
			const [detailErr, setDetailErr] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [openBuckets, setOpenBuckets] = react.useState({});
			const loadDetail = react.useCallback(() => {
				setLoading(true);
				setDetailErr(null);
				try {
					fetch(`${LTM_URL}/context.json`, { cache: "no-store" }).then((r) => r.json()).then((data) => setCtxDetail(data && typeof data === "object" ? data : { ready: false })).catch((e) => setDetailErr(String(e?.message ?? e))).finally(() => setLoading(false));
				} catch (e) {
					setDetailErr(String(e?.message ?? e));
					setLoading(false);
				}
			}, []);
			const toggleBucket = react.useCallback((key) => {
				setOpenBuckets((prev) => ({
					...prev,
					[key]: !prev[key]
				}));
			}, []);
			const legend = (color, label, val) => react.createElement("span", { style: {
				display: "inline-flex",
				alignItems: "center",
				marginRight: 12,
				fontSize: 11,
				color: "#8a8a8a"
			} }, react.createElement("span", { style: {
				width: 8,
				height: 8,
				borderRadius: 2,
				background: color,
				marginRight: 4,
				display: "inline-block"
			} }), `${label} ${fmt(val)}`);
			const bucketColor = (key) => key === "system" ? "#5b8def" : key === "tools" ? "#e0a64b" : "#6ec07a";
			const renderRow = (row) => react.createElement("div", {
				key: `row-${row.seq}`,
				style: {
					display: "flex",
					alignItems: "baseline",
					gap: 6,
					padding: "3px 0 3px 8px",
					borderLeft: `2px solid ${bucketColor(row.bucket)}`,
					marginBottom: 2,
					fontSize: 11,
					flexWrap: "wrap"
				}
			}, react.createElement("span", { style: {
				color: "#9fb4d8",
				minWidth: 30,
				fontFamily: "monospace"
			} }, `#${row.seq}`), react.createElement("span", { style: {
				color: "#cfcfcf",
				minWidth: 54
			} }, `${row.role}`), row.toolNames && row.toolNames.length > 0 ? react.createElement("span", { style: {
				color: "#e0a64b",
				minWidth: 0
			} }, `🔧${row.toolNames.join(",")}`) : null, react.createElement("span", { style: {
				color: "#8a8a8a",
				marginLeft: "auto",
				whiteSpace: "nowrap"
			} }, `${fmt(row.tokens)} tok · ${fmt(row.chars)} 字`), row.preview ? react.createElement("div", { style: {
				color: "#7a7a7a",
				fontSize: 10,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				maxWidth: "100%",
				flexBasis: "100%"
			} }, row.preview) : null);
			const renderBuckets = () => {
				if (!ctxDetail) return null;
				if (ctxDetail.ready === false) return react.createElement("div", { style: {
					color: "#888",
					fontSize: 11,
					padding: "4px 0"
				} }, "（还没有本步骤快照，发一条消息后重试）");
				const buckets = Array.isArray(ctxDetail.buckets) ? ctxDetail.buckets : [];
				return react.createElement("div", { style: { marginTop: 6 } }, react.createElement("div", { style: {
					fontSize: 10,
					color: "#8a8a8a",
					marginBottom: 4
				} }, `共 ${fmt(ctxDetail.totalRows)} 条 · 合计 ${fmt(ctxDetail.totalTokens)} tok（启发式）`), react.createElement("div", { style: {
					maxHeight: 340,
					overflowY: "auto",
					overflowX: "hidden",
					paddingRight: 4,
					scrollbarWidth: "thin",
					scrollbarColor: "#5a5a5f #26262a"
				} }, buckets.map((bucket) => {
					const isOpen = !!openBuckets[bucket.key];
					const empty = bucket.count === 0;
					return react.createElement("div", {
						key: bucket.key,
						style: {
							marginBottom: 4,
							opacity: empty ? .5 : 1
						}
					}, react.createElement("div", {
						onClick: empty ? void 0 : () => toggleBucket(bucket.key),
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							cursor: empty ? "default" : "pointer",
							padding: "4px 6px",
							borderRadius: 4,
							background: "#2a2a2d"
						}
					}, react.createElement("span", { style: {
						color: bucketColor(bucket.key),
						fontSize: 10
					} }, empty ? "▫" : isOpen ? "▾" : "▸"), react.createElement("span", { style: {
						color: "#d0d0d0",
						fontSize: 12
					} }, bucket.label), react.createElement("span", { style: {
						color: "#8a8a8a",
						fontSize: 10,
						marginLeft: "auto"
					} }, `${bucket.count} 条 · ${fmt(bucket.tokens)} tok`)), isOpen ? react.createElement("div", { style: { marginTop: 2 } }, bucket.rows.map(renderRow)) : null);
				})));
			};
			return react.createElement("div", { style: { marginBottom: 4 } }, !hasBreakdown ? react.createElement("div", { style: {
				color: "#888",
				fontSize: 12,
				padding: "4px 0"
			} }, "（暂无上下文数据）") : react.createElement("div", null, react.createElement("div", { style: {
				display: "flex",
				height: 10,
				borderRadius: 5,
				overflow: "hidden",
				margin: "6px 0"
			} }, react.createElement("div", { style: {
				width: `${total > 0 ? (sys || 0) / total * 100 : 0}%`,
				background: "#5b8def"
			} }), react.createElement("div", { style: {
				width: `${total > 0 ? (tools || 0) / total * 100 : 0}%`,
				background: "#e0a64b"
			} }), react.createElement("div", { style: {
				width: `${total > 0 ? (msg || 0) / total * 100 : 0}%`,
				background: "#6ec07a"
			} })), react.createElement("div", { style: { marginBottom: 4 } }, legend("#5b8def", "system", sys), legend("#e0a64b", "tools", tools), legend("#6ec07a", "message", msg)), react.createElement("div", { style: {
				fontSize: 11,
				color: "#8a8a8a"
			} }, pressure != null && windowTokens ? `窗口占用 ${fmt(usedTokens)} / ${fmt(windowTokens)} · ${Math.round(pressure * 100)}%` : `组成合计 ${fmt(total)} tokens（启发式）`)), react.createElement("div", { style: {
				marginTop: 6,
				display: "flex",
				gap: 8,
				alignItems: "center"
			} }, react.createElement("button", {
				onClick: loadDetail,
				disabled: loading,
				style: {
					font: "inherit",
					fontSize: 11,
					padding: "4px 10px",
					borderRadius: 6,
					border: "1px solid #555",
					background: "#2d2d30",
					color: "#e6e6e6",
					cursor: loading ? "default" : "pointer"
				}
			}, loading ? "加载中…" : ctxDetail ? "刷新明细" : "展开明细 ▸")), detailErr ? react.createElement("div", { style: {
				color: "#e07b7b",
				fontSize: 10,
				marginTop: 4
			} }, `明细加载失败：${detailErr}（需桌面端宿主在 7788 提供服务）`) : null, renderBuckets());
		}
		function MemoryView(props) {
			const open = react.useCallback(() => {
				try {
					globalThis.window?.open?.(LTM_URL, "_blank");
				} catch {}
			}, []);
			const sectionTitle = (text) => react.createElement("div", { style: {
				fontWeight: 600,
				fontSize: 12,
				color: "#9fb4d8",
				margin: "14px 0 4px"
			} }, text);
			return react.createElement("div", { style: {
				padding: "14px 16px",
				fontSize: 13,
				lineHeight: 1.6,
				height: "100%",
				maxHeight: "100%",
				boxSizing: "border-box",
				overflowY: "auto",
				overflowX: "hidden",
				scrollbarWidth: "thin",
				scrollbarColor: "#5a5a5f #26262a"
			} }, sectionTitle("上下文组成"), react.createElement(ContextSection, { props }), sectionTitle("长期记忆"), react.createElement("div", { style: {
				color: "#8a8a8a",
				fontSize: 12,
				marginBottom: 10
			} }, "work 分组、健康指标、召回预览与完整记忆树在独立页面查看（数据源 dsh_memory.json）。"), react.createElement("button", {
				onClick: open,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "8px 16px",
					borderRadius: 8,
					border: "1px solid #555",
					background: "#2d2d30",
					color: "#e6e6e6",
					cursor: "pointer",
					width: "100%"
				},
				onMouseEnter: (e) => {
					if (e?.currentTarget) e.currentTarget.style.background = "#3a3a3d";
				},
				onMouseLeave: (e) => {
					if (e?.currentTarget) e.currentTarget.style.background = "#2d2d30";
				}
			}, "打开 LTM 页面 →"), react.createElement("div", { style: {
				marginTop: 10,
				color: "#8a8a8a",
				fontSize: 11
			} }, "地址：", react.createElement("code", { style: { color: "#9fb4d8" } }, LTM_URL)), react.createElement("div", { style: {
				marginTop: 4,
				color: "#5e5e64",
				fontSize: 10,
				fontFamily: "monospace"
			} }, "client v10.1-scroll"));
		}
		//#endregion
		//#region src/client/SettingsPage.tsx
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
		/** 宿主 7788 服务地址（与 MemoryView 里的 LTM_URL 同一个服务）。 */
		const HOST_URL = "http://127.0.0.1:7788";
		const C = {
			label: "var(--dsw-alias-label-primary, #e6e6e6)",
			sub: "var(--dsw-alias-label-secondary, #a8a8a8)",
			tertiary: "var(--dsw-alias-label-tertiary, #8a8a8a)",
			border: "var(--dsw-alias-border-l2, #3a3a3d)",
			card: "var(--dsw-alias-layer-2, #26262a)",
			accent: "var(--dsw-alias-state-business-primary, #5b8def)",
			danger: "#e07b7b",
			ok: "#6ec07a"
		};
		const NUM_FIELDS = [
			{
				key: "retainTokens",
				label: "保留窗口（tokens）",
				hint: "逐字保留的尾部预算。最该调的一个：太小会频繁折叠，太大则每轮更贵。最小 1000。"
			},
			{
				key: "volatileBudget",
				label: "短期记忆区（tokens）",
				hint: "易变（短期）区预算。实测 2500 与 5000 折叠次数相同，只影响每次折叠的体积。"
			},
			{
				key: "recallTopK",
				label: "召回候选数",
				hint: "预算裁剪前先排序多少个候选。排得比展示的多，裁剪时去掉的是最弱的。"
			}
		];
		const BOOL_FIELDS = [
			{
				key: "recallEnabled",
				label: "启用召回",
				hint: "关闭后同时停用 pre-step 召回块与 memory_recall 工具（一个开关，二者不会打架）。"
			},
			{
				key: "selfEnabled",
				label: "发布自我认知",
				hint: "把 self 树作为一条 memory:self 消息挂在 surface 尾部。"
			},
			{
				key: "verbose",
				label: "详细日志",
				hint: "把每次折叠决策写进插件日志，排查问题用。"
			}
		];
		function row(children, key) {
			return react.createElement("div", {
				key,
				style: {
					display: "flex",
					alignItems: "flex-start",
					justifyContent: "space-between",
					gap: 16,
					padding: "12px 0",
					borderTop: `0.5px solid ${C.border}`
				}
			}, children);
		}
		function textBlock(label, hint) {
			return react.createElement("div", { style: { minWidth: 0 } }, react.createElement("div", { style: {
				color: C.label,
				fontSize: 13,
				fontWeight: 500
			} }, label), react.createElement("div", { style: {
				color: C.tertiary,
				fontSize: 12,
				marginTop: 2,
				lineHeight: 1.5
			} }, hint));
		}
		function numberInput(value, disabled, onChange) {
			return react.createElement("input", {
				type: "number",
				value: value === void 0 ? "" : String(value),
				disabled,
				onChange: (e) => {
					const t = e?.target?.value ?? "";
					const n = Number(t);
					onChange(t.trim() === "" || Number.isNaN(n) ? void 0 : n);
				},
				style: {
					width: 120,
					flex: "0 0 auto",
					textAlign: "right",
					font: "inherit",
					fontSize: 13,
					padding: "6px 8px",
					borderRadius: 6,
					border: `1px solid ${C.border}`,
					background: "#1e1e21",
					color: C.label,
					colorScheme: "dark"
				}
			});
		}
		function switchControl(checked, disabled, onToggle) {
			return react.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				disabled,
				onClick: onToggle,
				style: {
					flex: "0 0 auto",
					width: 40,
					height: 22,
					borderRadius: 11,
					border: 0,
					padding: 0,
					cursor: disabled ? "default" : "pointer",
					position: "relative",
					background: checked ? C.accent : "#4a4a4f",
					opacity: disabled ? .6 : 1,
					transition: "background .15s"
				}
			}, react.createElement("span", { style: {
				position: "absolute",
				top: 2,
				left: checked ? 20 : 2,
				width: 18,
				height: 18,
				borderRadius: 9,
				background: "#fff",
				transition: "left .15s"
			} }));
		}
		function selectControl(value, disabled, onChange) {
			return react.createElement("select", {
				value: value ?? "rules",
				disabled,
				onChange: (e) => onChange(e?.target?.value ?? "rules"),
				style: {
					flex: "0 0 auto",
					width: 140,
					font: "inherit",
					fontSize: 13,
					padding: "6px 8px",
					borderRadius: 6,
					border: `1px solid ${C.border}`,
					background: "#1e1e21",
					color: C.label,
					colorScheme: "dark"
				}
			}, react.createElement("option", { value: "rules" }, "规则（rules）"), react.createElement("option", { value: "llm" }, "模型蒸馏（llm）"));
		}
		/** kind 的展示名。 */
		const KIND_LABELS = {
			identity: "身份",
			preference: "偏好",
			constraint: "约束",
			fact: "事实",
			entity: "实体",
			task: "任务",
			decision: "决定",
			question: "疑问",
			episode: "片段",
			skill: "技能"
		};
		function kindLabel(kind) {
			return kind && KIND_LABELS[kind] || "约束";
		}
		/** 一条自我认知的编辑卡片：标题 / 类别 / 正文 / 删除。 */
		function selfCard(node, index, disabled, onChange, onRemove, canRemove, kinds) {
			const inputStyle = {
				width: "100%",
				boxSizing: "border-box",
				font: "inherit",
				fontSize: 13,
				padding: "7px 9px",
				borderRadius: 6,
				border: `1px solid ${C.border}`,
				background: "#1e1e21",
				color: C.label,
				colorScheme: "dark"
			};
			return react.createElement("div", {
				key: node.id || `new-${index}`,
				style: {
					border: `1px solid ${C.border}`,
					borderRadius: 8,
					padding: "10px 12px",
					marginTop: 10,
					background: "#212124"
				}
			}, react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginBottom: 8
			} }, react.createElement("input", {
				value: node.title ?? "",
				disabled,
				placeholder: "标题（如：身份 / 边界）",
				onChange: (e) => onChange({ title: e?.target?.value ?? "" }),
				style: {
					...inputStyle,
					flex: "1 1 auto",
					fontWeight: 600
				}
			}), react.createElement("select", {
				value: node.kind ?? "constraint",
				disabled,
				onChange: (e) => onChange({ kind: e?.target?.value ?? "constraint" }),
				style: {
					...inputStyle,
					width: 96,
					flex: "0 0 auto"
				}
			}, (kinds.length ? kinds : [
				"identity",
				"preference",
				"constraint"
			]).map((k) => react.createElement("option", {
				key: k,
				value: k
			}, kindLabel(k)))), react.createElement("button", {
				type: "button",
				disabled: disabled || !canRemove,
				title: canRemove ? "删除这一条" : "至少保留一条",
				onClick: onRemove,
				style: {
					flex: "0 0 auto",
					font: "inherit",
					fontSize: 12,
					padding: "6px 10px",
					borderRadius: 6,
					border: `1px solid ${C.border}`,
					background: "transparent",
					color: canRemove ? C.danger : C.tertiary,
					cursor: disabled || !canRemove ? "default" : "pointer",
					opacity: canRemove ? 1 : .5
				}
			}, "删除")), react.createElement("textarea", {
				value: node.body ?? "",
				disabled,
				placeholder: "这一条的具体内容（≤600 字）",
				rows: 2,
				onChange: (e) => onChange({ body: e?.target?.value ?? "" }),
				style: {
					...inputStyle,
					resize: "vertical",
					lineHeight: 1.5
				}
			}));
		}
		/**
		* v12 自我认知编辑区。
		*
		* 单独成组件，状态与「偏好设置」那张卡完全隔离：自我认知走的是另一条存储
		* （~/.dsh/storages/dsh_memory_self.json），改它不该让偏好表单变脏，反之亦然。
		* 保存后宿主把它落盘，`publishSelf` 下一次 pre-step 就用新内容重发——跨会话生效。
		*/
		function SelfEditor() {
			const [loading, setLoading] = react.useState(true);
			const [unavailable, setUnavailable] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [saved, setSaved] = react.useState([]);
			const [exists, setExists] = react.useState(false);
			const [revision, setRevision] = react.useState(void 0);
			const [kinds, setKinds] = react.useState([]);
			const [draft, setDraft] = react.useState([]);
			const [saving, setSaving] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			const apply = react.useCallback((body) => {
				setSaved(body.nodes || []);
				setDraft(body.nodes || []);
				setExists(body.exists === true);
				setRevision(body.revision);
				if (Array.isArray(body.kinds) && body.kinds.length) setKinds(body.kinds);
			}, []);
			const load = react.useCallback(() => {
				setLoading(true);
				setError(null);
				fetch(`${HOST_URL}/self.get`, { cache: "no-store" }).then(async (r) => {
					const body = await r.json().catch(() => ({}));
					if (r.status === 503) {
						setUnavailable(true);
						return;
					}
					if (!r.ok || !body || body.ok !== true) throw new Error(body && body.reason || `HTTP ${r.status}`);
					setUnavailable(false);
					apply(body);
				}).catch((e) => setError(String(e?.message ?? e))).finally(() => setLoading(false));
			}, [apply]);
			react.useEffect(load, [load]);
			const dirty = react.useMemo(() => {
				try {
					return JSON.stringify(saved) !== JSON.stringify(draft);
				} catch {
					return true;
				}
			}, [saved, draft]);
			const editNode = react.useCallback((index, patch) => {
				setDraft((prev) => prev.map((n, i) => i === index ? {
					...n,
					...patch
				} : n));
				setStatus(null);
			}, []);
			const addNode = react.useCallback(() => {
				setDraft((prev) => [...prev, {
					title: "",
					body: "",
					kind: "constraint"
				}]);
				setStatus(null);
			}, []);
			const removeNode = react.useCallback((index) => {
				setDraft((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== index));
				setStatus(null);
			}, []);
			const save = react.useCallback(() => {
				if (saving) return;
				for (let i = 0; i < draft.length; i += 1) {
					if ((draft[i].title ?? "").trim() === "") {
						setStatus({
							kind: "err",
							text: `第 ${i + 1} 条缺少标题。`
						});
						return;
					}
					if ((draft[i].body ?? "").length > 600) {
						setStatus({
							kind: "err",
							text: `第 ${i + 1} 条正文超过 600 字。`
						});
						return;
					}
				}
				setSaving(true);
				setStatus(null);
				fetch(`${HOST_URL}/self.update`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					cache: "no-store",
					body: JSON.stringify({
						nodes: draft,
						expectedRevision: revision
					})
				}).then(async (r) => {
					const body = await r.json().catch(() => ({}));
					if (r.status === 409) throw new Error("自我认知已被别处修改，已为你刷新最新内容，请重新编辑。");
					if (!r.ok || !body || body.ok !== true) throw new Error(body && body.reason || `HTTP ${r.status}`);
					apply(body);
					setStatus({
						kind: "ok",
						text: "已保存，下一步起生效（跨会话保留）。"
					});
				}).catch((e) => {
					setStatus({
						kind: "err",
						text: String(e?.message ?? e)
					});
					load();
				}).finally(() => setSaving(false));
			}, [
				draft,
				revision,
				saving,
				apply,
				load
			]);
			const reset = react.useCallback(() => {
				if (saving) return;
				setSaving(true);
				setStatus(null);
				fetch(`${HOST_URL}/self.reset`, {
					method: "POST",
					cache: "no-store"
				}).then(async (r) => {
					const body = await r.json().catch(() => ({}));
					if (!r.ok || !body || body.ok !== true) throw new Error(body && body.reason || `HTTP ${r.status}`);
					apply(body);
					setStatus({
						kind: "ok",
						text: "已恢复默认四条。"
					});
				}).catch((e) => setStatus({
					kind: "err",
					text: String(e?.message ?? e)
				})).finally(() => setSaving(false));
			}, [saving, apply]);
			const header = react.createElement("div", { style: {
				marginTop: 22,
				marginBottom: 4
			} }, react.createElement("h2", { style: {
				margin: "0 0 4px",
				fontSize: 16,
				fontWeight: 600,
				color: C.label
			} }, "自我认知"), react.createElement("p", { style: {
				margin: 0,
				color: C.tertiary,
				fontSize: 12,
				lineHeight: 1.6
			} }, "这份文本会作为「你是谁、怎么做事」的自我认知附在对话里。保存后写盘，新会话也会沿用；改完可随时恢复默认。"));
			if (loading) return react.createElement("div", { style: {
				padding: "14px 4px",
				color: C.tertiary,
				fontSize: 13
			} }, "正在读取自我认知…");
			if (unavailable) return react.createElement("div", { style: {
				maxWidth: 720,
				padding: "4px 4px 24px"
			} }, header, react.createElement("div", { style: {
				color: C.tertiary,
				fontSize: 13,
				lineHeight: 1.6,
				border: `1px solid ${C.border}`,
				borderRadius: 8,
				padding: "12px 14px",
				background: C.card
			} }, "本机没有可用的记忆服务（7788 未启动或插件未挂载），暂无法编辑自我认知。重启 DSH 桌面端后重试。"));
			if (error && draft.length === 0) return react.createElement("div", { style: {
				maxWidth: 720,
				padding: "4px 4px 24px"
			} }, header, react.createElement("div", { style: {
				color: C.danger,
				fontSize: 13,
				lineHeight: 1.6
			} }, `读取失败：${error}`, react.createElement("button", {
				onClick: load,
				style: {
					marginLeft: 10,
					font: "inherit",
					fontSize: 12,
					padding: "4px 10px",
					borderRadius: 6,
					border: `1px solid ${C.border}`,
					background: C.card,
					color: C.label,
					cursor: "pointer"
				}
			}, "重试")));
			const disabled = saving;
			const footer = react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				marginTop: 14,
				flexWrap: "wrap"
			} }, react.createElement("button", {
				onClick: addNode,
				disabled,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "7px 14px",
					borderRadius: 8,
					border: `1px dashed ${C.border}`,
					background: "transparent",
					color: C.label,
					cursor: disabled ? "default" : "pointer"
				}
			}, "＋ 新增一条"), react.createElement("button", {
				onClick: save,
				disabled: disabled || !dirty,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "8px 18px",
					borderRadius: 8,
					border: 0,
					cursor: disabled || !dirty ? "default" : "pointer",
					background: disabled || !dirty ? "#3a3a3f" : C.accent,
					color: "#fff",
					opacity: disabled || !dirty ? .7 : 1
				}
			}, saving ? "保存中…" : "保存自我认知"), react.createElement("button", {
				onClick: () => {
					setDraft(saved);
					setStatus(null);
				},
				disabled: disabled || !dirty,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "8px 14px",
					borderRadius: 8,
					border: `1px solid ${C.border}`,
					background: "transparent",
					color: C.label,
					cursor: disabled || !dirty ? "default" : "pointer",
					opacity: disabled || !dirty ? .6 : 1
				}
			}, "撤销修改"), react.createElement("button", {
				onClick: reset,
				disabled,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "8px 14px",
					borderRadius: 8,
					border: `1px solid ${C.border}`,
					background: "transparent",
					color: C.tertiary,
					cursor: disabled ? "default" : "pointer"
				}
			}, "恢复默认"), status ? react.createElement("span", { style: {
				color: status.kind === "ok" ? C.ok : C.danger,
				fontSize: 12
			} }, status.text) : null);
			return react.createElement("div", { style: {
				maxWidth: 720,
				padding: "0 4px 24px",
				color: C.label
			} }, header, react.createElement("div", { style: {
				color: C.tertiary,
				fontSize: 11,
				marginTop: 6
			} }, exists ? `当前使用自定义版本（revision ${revision}）。` : "当前是内置默认四条，保存后将替换为你的版本。"), draft.map((node, i) => selfCard(node, i, disabled, (patch) => editNode(i, patch), () => removeNode(i), draft.length > 1, kinds)), footer);
		}
		function SettingsPage(_props) {
			const [loading, setLoading] = react.useState(true);
			const [error, setError] = react.useState(null);
			const [unavailable, setUnavailable] = react.useState(false);
			const [writable, setWritable] = react.useState(false);
			const [revision, setRevision] = react.useState(void 0);
			const [saved, setSaved] = react.useState({});
			const [draft, setDraft] = react.useState({});
			const [saving, setSaving] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			const load = react.useCallback(() => {
				setLoading(true);
				setError(null);
				fetch(`${HOST_URL}/settings.get`, { cache: "no-store" }).then(async (r) => {
					const body = await r.json().catch(() => ({}));
					if (r.status === 503) {
						setUnavailable(true);
						return;
					}
					if (!r.ok || !body || body.ok !== true) throw new Error(body && body.reason || `HTTP ${r.status}`);
					setSaved(body.value || {});
					setDraft(body.value || {});
					setRevision(body.revision);
					setWritable(body.writable === true);
					setUnavailable(false);
				}).catch((e) => setError(String(e?.message ?? e))).finally(() => setLoading(false));
			}, []);
			react.useEffect(load, [load]);
			const dirty = react.useMemo(() => {
				try {
					return JSON.stringify(saved) !== JSON.stringify(draft);
				} catch {
					return true;
				}
			}, [saved, draft]);
			const edit = react.useCallback((key, value) => {
				setDraft((prev) => ({
					...prev,
					[key]: value
				}));
				setStatus(null);
			}, []);
			const save = react.useCallback(() => {
				if (!writable || saving) return;
				if (typeof draft.retainTokens === "number" && draft.retainTokens < 1e3) {
					setStatus({
						kind: "err",
						text: "保留窗口至少 1000 tokens（更小的窗口会让每一步都折叠整段历史）。"
					});
					return;
				}
				setSaving(true);
				setStatus(null);
				fetch(`${HOST_URL}/settings.update`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					cache: "no-store",
					body: JSON.stringify({
						patch: draft,
						expectedRevision: revision
					})
				}).then(async (r) => {
					const body = await r.json().catch(() => ({}));
					if (r.status === 409) throw new Error("设置已被别处修改，已为你刷新最新值，请重新修改。");
					if (!r.ok || !body || body.ok !== true) throw new Error(body && body.reason || `HTTP ${r.status}`);
					setSaved(body.value || {});
					setDraft(body.value || {});
					setRevision(body.revision);
					setStatus({
						kind: "ok",
						text: "已保存，即时生效（无需重启）。"
					});
				}).catch((e) => {
					setStatus({
						kind: "err",
						text: String(e?.message ?? e)
					});
					load();
				}).finally(() => setSaving(false));
			}, [
				draft,
				revision,
				writable,
				saving,
				load
			]);
			const reset = react.useCallback(() => setDraft(saved), [saved]);
			const header = react.createElement("div", { style: { marginBottom: 8 } }, react.createElement("h2", { style: {
				margin: "0 0 4px",
				fontSize: 18,
				fontWeight: 600,
				color: C.label
			} }, "记忆"), react.createElement("p", { style: {
				margin: 0,
				color: C.tertiary,
				fontSize: 13,
				lineHeight: 1.6
			} }, "调整 dsh-memory 的上下文折叠与召回偏好。保存后即时生效，无需重启。"));
			if (loading) return react.createElement("div", { style: {
				padding: "14px 4px",
				color: C.tertiary,
				fontSize: 13
			} }, "正在读取记忆设置…");
			if (unavailable) return react.createElement("div", { style: {
				padding: "14px 4px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			} }, header, react.createElement("div", { style: {
				color: C.tertiary,
				fontSize: 13,
				lineHeight: 1.6,
				border: `1px solid ${C.border}`,
				borderRadius: 8,
				padding: "12px 14px",
				background: C.card
			} }, "本机没有可用的设置服务（7788 未启动或插件未挂载）。记忆仍按配置文件运行；重启 DSH 桌面端后重试即可。"));
			if (error && !saved.retainTokens && !Object.keys(draft).length) return react.createElement("div", { style: {
				padding: "14px 4px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			} }, header, react.createElement("div", { style: {
				color: C.danger,
				fontSize: 13,
				lineHeight: 1.6
			} }, `读取失败：${error}`, react.createElement("button", {
				onClick: load,
				style: {
					marginLeft: 10,
					font: "inherit",
					fontSize: 12,
					padding: "4px 10px",
					borderRadius: 6,
					border: `1px solid ${C.border}`,
					background: C.card,
					color: C.label,
					cursor: "pointer"
				}
			}, "重试")));
			const disabled = !writable || saving;
			const rows = [];
			rows.push(row([textBlock("蒸馏方式", "rules：确定性摘录（便宜、可预测）；llm：让路由模型总结，范围不够大时会退回 rules。"), selectControl(draft.distillPolicy, disabled, (v) => edit("distillPolicy", v))], "distillPolicy"));
			for (const f of NUM_FIELDS) rows.push(row([textBlock(f.label, f.hint), numberInput(draft[f.key], disabled, (v) => edit(f.key, v))], f.key));
			for (const f of BOOL_FIELDS) rows.push(row([textBlock(f.label, f.hint), switchControl(draft[f.key] === true, disabled, () => edit(f.key, !(draft[f.key] === true)))], f.key));
			const footer = react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				marginTop: 18,
				flexWrap: "wrap"
			} }, react.createElement("button", {
				onClick: save,
				disabled: disabled || !dirty,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "8px 18px",
					borderRadius: 8,
					border: 0,
					cursor: disabled || !dirty ? "default" : "pointer",
					background: disabled || !dirty ? "#3a3a3f" : C.accent,
					color: "#fff",
					opacity: disabled || !dirty ? .7 : 1
				}
			}, saving ? "保存中…" : "保存"), react.createElement("button", {
				onClick: reset,
				disabled: disabled || !dirty,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "8px 14px",
					borderRadius: 8,
					border: `1px solid ${C.border}`,
					background: "transparent",
					color: C.label,
					cursor: disabled || !dirty ? "default" : "pointer",
					opacity: disabled || !dirty ? .6 : 1
				}
			}, "撤销修改"), !writable ? react.createElement("span", { style: {
				color: C.tertiary,
				fontSize: 12
			} }, "本部署的设置为只读。") : null, status ? react.createElement("span", { style: {
				color: status.kind === "ok" ? C.ok : C.danger,
				fontSize: 12
			} }, status.text) : null);
			return react.createElement("div", { style: {
				maxWidth: 720,
				padding: "4px 4px 24px",
				color: C.label
			} }, header, react.createElement("div", { style: {
				background: C.card,
				border: `1px solid ${C.border}`,
				borderRadius: 10,
				padding: "2px 16px 4px",
				marginTop: 8
			} }, rows), footer, react.createElement("div", { style: {
				marginTop: 14,
				color: C.tertiary,
				fontSize: 11,
				lineHeight: 1.6
			} }, "其余内部参数（admitKinds / barrierKinds / LTM 容量等）仍通过 profile 的 cordis.patch.yml 调整 —— 它们会改变插件结构，不适合热改。"), react.createElement("div", { style: {
				marginTop: 6,
				color: "#5e5e64",
				fontSize: 10,
				fontFamily: "monospace"
			} }, "dsh-memory settings v12"), react.createElement(SelfEditor, null));
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* v9 P1 记忆面板 — 右侧栏 tab 注册入口（浏览器半）。
		*
		* 照抄 dsh-context 的既有公开路径（client.js L13211 watchSidebarContextTab）：
		*   1. ctx.inject(["sidebarRightTabs"]) → tabs.register({id,kind,title,guide})
		*   2. slots.inject/register("sidebar.right.pane.tab", key→组件)
		*   3. slots.inject/register("sidebar.right.pane.tab.title", key→标题)
		*
		* 只在宿主提供 sidebarRightTabs 时才注册（老 harness 无此服务 → 静默跳过）。
		* P1：组件显示假数据；P2 接投影。
		*/
		/** tab 类型身份（也是 body-seat 的 key）。命名空间化，避免与 dsh-context 撞名。 */
		const PANEL_ID = "dsh-memory";
		/** openTab 用的 kind。与 id 同名，同样命名空间化。 */
		const PANEL_KIND = "dsh-memory";
		/** 引导页入口排序：放在 dsh-context（20）之后。 */
		const GUIDE_ORDER = 30;
		/** 简单图标：一个方形 emoji 占位（P1 不引 primitives，P4 再换正式图标）。 */
		function MemoryIcon() {
			return react.createElement("span", {
				style: { fontSize: 16 },
				"aria-hidden": true
			}, "🧠");
		}
		/** tab chip 的标题组件。 */
		function makeTabTitle() {
			return function TabTitle() {
				return react.createElement("span", null, "记忆");
			};
		}
		/**
		* 注册记忆 tab。返回 disposer。
		* @param ctx client root context（有 slots 与可选 sidebarRightTabs）。
		*/
		function registerMemoryPanel(ctx) {
			const handle = ctx.inject(["sidebarRightTabs"], (injected) => {
				const disposers = [];
				const own = (r) => {
					if (typeof r === "function") disposers.push(r);
					else if (r && typeof r.dispose === "function") disposers.push(() => r.dispose());
				};
				try {
					const tabs = injected.sidebarRightTabs;
					if (tabs === void 0 || typeof tabs.register !== "function") return;
					own(tabs.register({
						id: PANEL_ID,
						kind: PANEL_KIND,
						title: () => "记忆",
						guide: [{
							order: GUIDE_ORDER,
							title: () => "记忆",
							description: () => "上下文组成与长期记忆结构",
							icon: MemoryIcon
						}]
					}));
					own(injected.slots.inject("sidebar.right.pane.tab", () => injected.slots.register({
						name: "sidebar.right.pane.tab",
						key: PANEL_ID
					}, (props) => react.createElement(MemoryView, props))));
					own(injected.slots.inject("sidebar.right.pane.tab.title", () => injected.slots.register({
						name: "sidebar.right.pane.tab.title",
						key: PANEL_ID
					}, makeTabTitle())));
				} catch {
					for (const d of disposers) d();
					return;
				}
				return () => {
					for (const d of disposers) d();
				};
			});
			return () => {
				handle?.dispose?.();
			};
		}
		/**
		* 插件 apply（浏览器半入口）。client 半约定：export { name, inject, apply }。
		* P1：只注册面板；后续可在此接投影订阅。
		*
		* 关键（P1 真机发现）：宿主加载 client 半时，**必须**看到 `name` 和 `inject`，
		* 否则不把它当作具名插件、不满足依赖、根本不 apply —— 表现为侧栏 tab 不出现。
		* 取证：dsh-context/lib/client.js 末尾 `module.exports = { name, inject:["slots","locale"], apply }`；
		* dsh-better-sidebar 末尾 `exports.inject = inject`（slots/sessions/locale/modules…）。
		* 我们注册右侧栏 tab 只需要 `slots`（sidebarRightTabs 由 ctx.inject 运行时拉取）。
		*/
		const name = "dsh-memory";
		const inject = ["slots"];
		function apply(ctx) {
			registerMemoryPanel(ctx);
			registerSettingsSection(ctx);
		}
		/**
		* v11: register the settings page into the DSH Settings shell's
		* `settings.section` slot. The shell lives in another package, so `slots.inject`
		* waits for its declaration and silently no-ops on a deployment without the
		* settings surface. See SettingsPage.tsx for the transport (7788 fenced routes).
		*/
		function registerSettingsSection(ctx) {
			const register = () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-memory",
				order: 60,
				label: () => "记忆",
				inject: () => ({})
			}, (props) => react.createElement(SettingsPage, props));
			ctx.slots.inject("settings.section", register);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.registerMemoryPanel = registerMemoryPanel;
		return module.exports;
	}
});
