# CHANGELOG

本文件记录 dsh-memory 的功能变更与修复。格式参考 Keep a Changelog，日期为本地时间。

## [Unreleased]

### Changed — 发布工程收尾（不发版，仅整备）

- **发布包剔除备份文件**：`files` 白名单含 `lib/`，npm 规定白名单内无法用 `.npmignore` 排除，故 `lib/` 下三个 `.bak-v11`（`client.js.bak-v11` / `index.js.bak-v11` / `ltm-view.js.bak-v11`，合计 120KB）会被打进 tarball。已移出 `lib/` 至仓库根 `_archive/`（代码无任何引用）。`npm pack --dry-run`：**32 文件 / 193KB → 29 文件 / 156KB**，包内 0 个备份文件。
- **补发布卫生文件**：新增 `.npmignore`（排除 `*.bak*`/`src/`/`test/`/配置等，仅保留 `README.md`、`CHANGELOG.md`）与 `.gitignore`（排除 `node_modules/`、备份、构建缓存）。
- **版本号对齐**：`package.json` `0.2.0` → `0.3.0`，与本轮 v11→v12 的功能增量对应（此前版本号长期滞后于实际能力）。

## [0.3.0] - 2026-11-13

> 本段收口此前积压在 `[Unreleased]` 的全部 v11 / v12 功能与修复；详细条目见下方各小节。

### Fixed — 单元测试误读真实自我认知文件（测试隔离缺失，非产品缺陷）

- **现象**：全量 `npm test` 429 项里恒有 1 项失败——`test/plugin.test.js`「a changed self tree replaces its own copy instead of appending」。断言 `notDeepEqual` 比对「改前 vs 改后」的 self 文本，实测两边**逐字相同**，失败信息里 actual 与 expected 一模一样。
- **根因（两层，都在测试侧）**：
  1. 测试辅助 `step(session, stats, overrides, deps)` 只把 `deps` 透传给了 `foldIfNeeded`，**没有透传 `publishSelf`**——而 `publishSelf` 的可注入参数 `options.loadOverride` 正是要靠 `deps` 送进去。于是它永远走默认分支 `defaultLoadSelfOverride()`，去读真实的 `~/.dsh/storages/dsh_memory_self.json`。
  2. 该用例用「把编辑 append 到 surface」来模拟一次改动，但 `publishSelf` 的取值顺序是 **store → surface → 默认**，真实 store 存在时 store 恒赢，直接盖掉用例伪造的编辑 → 前后文本相同 → 断言落空。
- **为何以前是绿的**：真实 store 文件是 v12 新增的覆盖层，且内容恰为此前默认值。只有当用户真的在设置页改过、存过盘（本例首条 title 曾为「身份」，与默认同字）时才不冲突；一旦 store 与用例伪造值不再巧合一致，或环境里压根没有该文件，结果就随机化——**测试静默依赖开发者本机状态**，是典型的隔离缺陷。
- **修复**（仅改 `test/plugin.test.js` 的 `step` 辅助，`lib/` 生产代码零改动）：
  - `step()` 现把 `deps` 一并传给 `publishSelf(agent, stats, selfNodes, selfDeps)`；
  - 并给 `selfDeps` 设**隔离默认值** `{ loadOverride: () => null, ...deps }`——除非用例显式注入 reader，否则 `publishSelf` 一律不读真实文件，退回 surface/默认值。显式 `deps.loadOverride` 仍最高优先。
- **验证（proof, not hope）**：
  - 单文件 `node --test test/plugin.test.js`：**31/31 通过**（原 1 失败消失）。
  - **敌意 HOME 反证**：把一个临时 `USERPROFILE` 下 `.dsh/storages/dsh_memory_self.json` 的 title 改成用例里那句「改过的身份」（若测试仍读真实文件，断言必然翻车），在该 HOME 下跑同一文件仍 **31/31**——证明它确实不再触碰真实文件。
  - 全量 `npm test`：**429 项 / 428 通过 / 0 失败 / 1 跳过**，回到全绿基线。

### Added — v12 设置页可直接编辑自我认知（4 条可改 + 增删 + 恢复默认）

- **背景**：v11 的「发布自我认知」只是个开关，改不了正文。用户要「直接改自我认知」。取证发现一个结构性事实：**自我认知原本根本没有持久化存储**——它只是挂在本会话 surface 那条 `memory:self` 消息的 `source.nodes` 上（`pipeline.js` `publishSelf`），每次从日志重建；新会话没有历史，就退回 `self.js` `defaultSelfNodes()` 的 4 条默认值。所以只改界面上的字没用：开新会话立刻丢。
- **做法**：新增独立覆盖层 `~/.dsh/storages/dsh_memory_self.json`，`publishSelf` 取值顺序改为 **store → surface → 默认**（`override ?? nodes ?? readSelfNodes(...) ?? defaultSelfNodes()`）。
  - `lib/self-store.js`（新）：`readSelfState` / `readSelfOverride` / `writeSelfOverride` / `resetSelfOverride` / `normalizeSelfNodes` / `selfView`。只持久化用户可见字段（id/kind/order/title/body），其余结构字段（zone/parentId/weight/pinned/rev/archived）读出时**重新推导**，手改文件也注入不了非法节点。校验**拒绝而非截断**（超 600 字直接报错）。读失败一律回默认、绝不抛异常（折叠每步都跑，坏覆盖文件不能拖垮插件）。
  - `lib/pipeline.js`：`publishSelf(agent, stats, nodes, options)` 增可选 `options.loadOverride`（测试/嵌入方可注入），默认读真实覆盖文件；无文件返回 null，行为与改动前**逐字节一致**。
  - `lib/index.js`：7788 服务注入 `getSelf / updateSelf / resetSelf`。
  - `lib/ltm-view.js`：新增 `GET /self.get`、`POST /self.update`（409 版本冲突 / 400 校验拒绝 / 503 无服务）、`POST /self.reset`。
  - `src/client/SettingsPage.tsx`：新增独立 `SelfEditor` 组件（标题 + 类别下拉 + 正文 textarea + 删除；「＋ 新增一条」「保存自我认知」「撤销修改」「恢复默认」），与偏好设置那张卡状态隔离。
- **「恢复默认」写默认值、不删文件**：只删文件的话，当前会话 surface 仍挂着改过的节点，下一次 `publishSelf` 会读回来——用户点了恢复却看到旧内容。写默认值让覆盖文件始终是权威源。
- **验证**：新增 `test/self-store.test.js`（19 项）+ `test/ltm-view.test.js` 增 6 项 self 路由。全量 `npm test`：**429 项 / 428 通过 / 0 失败 / 1 跳过**。
- **实机演练**：对 profile 副本起临时服务实测 get→update(200,rev+1)→get 反映→空数组(400)→reset(200,回 4 条)，全过；`selfStorePath` = `~/.dsh/storages/dsh_memory_self.json`。
- **注意**：运行中的 7788 是旧代码，`/self.get` 现在 404，**需重启桌面端**新路由才生效。

### Added — v11 图形化设置页（DSH 设置壳里的独立「记忆」一栏）

- **背景**：DSH 设置壳（`settings.section` 槽）是插件可注册的，但 dsh-memory 一直只能改 `cordis.patch.yml`。取证过三个卡点：① `dsh-settings` 的 `volatileForm()` 只把 `.volatile()` 字段放进表单、写入亦按 `isVolatilePath` 校验，非 volatile 直接抛错；② `.volatile()` 会把字段包成 cosmokit `Volatile`（`config.x` 变对象，需 `.get()`），而 `apply` 里全是直接读 `config.x`，硬加会全错；③ 第三方 namespace 不对设置 RPC 域开放，需插件自带 fenced 路由。
- **做法（照 better-sidebar 的路子，不硬刚）**：
  - `lib/index.js`：`Config = withLiveFields(ConfigSchema)` —— 把 7 个字段（`retainTokens` / `volatileBudget` / `recallEnabled` / `recallTopK` / `distillPolicy` / `selfEnabled` / `verbose`）`.volatile()`；`apply` 开头 `config = unwrapVolatileConfig(config)` 一次性解包成只读普通视图，**其余 ~100 处 `config.x` 读取一行未改**。
  - `lib/index.js`：在 `ctx.inject(['settings'])` 里用 `ownEntryId()` 解析本插件行 id，暴露 `getSettings/updateSettings` face（内部调 `describe`/`update`），接到 7788 服务。
  - `lib/ltm-view.js`：新增 `GET /settings.get`、`POST /settings.update`（沿用同一套 CORS + 本机 127.0.0.1 策略；409 = 版本冲突、400 = 校验拒绝、503 = 无设置服务）。
  - `src/client/SettingsPage.tsx` + `index.tsx`：新页注册进 `settings.section`（id `dsh-memory`，order 60，label「记忆」），自绘 7 个控件、脏检查和保存/撤销，直连 7788。
- **验证**：全量 `npm test` **404 项 / 403 通过 / 0 失败 / 1 跳过**（与改动前一致）。`Config` 取证：7 字段 `meta.volatile=true`、默认值保留、raw parse 确实包成对象、解包后全为普通值、`toJSON→重建` 后 volatile 仍在。7788 路由临时实例（port 0）实测 8 项全过：preflight 204 / GET 200+ACAO / 合法写 200 且 revision+1 / 陈旧 revision 409 / `retainTokens<1000` 400 / 坏 JSON 400 / GET 打 update 405 / 无 face 503。
- **注意**：正在运行的 7788 是启动时 listen 的旧代码，改文件不热重载，**需重启桌面端**新页才出现。

### Fixed — 归档的 work 枢轴不会被复活 → 工作组永久变孤儿

- **现象**：`work:acs论文获取` 一个组有 36 条活跃成员，却对应一个 `archived:true` 的枢轴 `ltm-e0b009f94b306868`——面板里该组没有卡片、召回时丢 work 卡。全库扫描：这是**唯一**一组「成员活着、枢轴却被归档」的真孤儿（其余 9 个无枢轴组都是 ≤2 条的新小组，属正常待提炼）。
- **根因**：`applyWorkPivots`（`lib/promote.js`）用内容无关的稳定 id `pivotIdFor(work)` 取枢轴，`let pivot = byId.get(pid)` 取到后**从不检查它是否 `archived`**。一次预算淘汰把枢轴归档后，之后每轮整并都直接复用这个归档枢轴、还把成员 `parentId/pivotId` 往回挂——形成「36 成员 ↔ 归档枢轴」的死结，永不恢复。这与之前那次「恢复被误封枢轴」是同一类问题的不同入口：那次是手动改数据治标，这次治本。
- **为何现在暴露**：当前实际并未超预算（212 节点 / 27303 tokens，上限 500 / 200000）。说明该枢轴是在**早前某个超预算时刻**被淘汰归档的，之后预算回落，但归档状态再没人恢复。
- **修复**（`lib/promote.js` `applyWorkPivots`）：分组循环里，若 `pivot && pivot.archived === true` 且该组仍有 **≥2 条活跃成员**，则复活（`archived:false`）并计入新统计 `stats.pivotsRevived`。安全性：
  - 只复活「成员确实活着且够 ≥2」的枢轴——成员解散到 <2 的组根本进不到这一分支；
  - 复活后若总量被顶超预算，紧随的淘汰 pass 会按权重/生日重新淘汰最小者，不会造成预算失控；
  - 只有 `archived true→false` 是真实变更，其余 idempotent，diff 稳定。
- **验证**：新增 2 条回归测试（`test/work.test.js`）：①「work 仍有 ≥2 活跃成员时归档枢轴被复活、成员重新挂载」；②「组解散到 <2 时归档枢轴保持归档、不复活」。全量 `npm test`：**404 项 / 403 通过 / 0 失败 / 1 跳过**。
- **真实台账预演与自愈路径**：用新 `applyWorkPivots` 在真实台账（264 条）上干跑，差异**精确命中 1 条**——`ltm-e0b009f94b306868` 的 `archived true→false`，`pivotsCreated:0 / pivotsLinked:0 / evicted:0`，其余 263 条一字不动。已把 `lib/promote.js` 同步 profile 副本（hash 一致 + `node --check`）。
  - **不直接手改盘上文件**：本轮对话期间该台账被运行中的宿主进程（`DeepSeek Harness.exe`）实时改写（335278 → 271741 字节），内存副本会在下次写回时覆盖外部修改。正确路径是**重启后由新代码在第一轮整并自动复活**（`runPromotePass` 每轮都会调 `applyWorkPivots`；`archived true→false` 是真实变更，会写回）。另存了备份 `dsh_memory.json.bak-20261113-135250`。
- **文档**：README 基线更新为 `25 个 *.test.js / 404 项 / 403 通过 / 1 跳过`。

### Fixed — seqRange 起点锚错（锚到记忆检查点，且会倒挂）

- **现象**：`sources[].seqRange` 已写入，但值不对。真实台账 258 条里 8 条带该字段，**8 条全部**的起点都是「记忆检查点」那条 user/message 的 seq，而非真实内容；其中 1 条（`ltm-1495ce75`）因此出现 `[26822, 26812]` **起点>终点**。`memory_fetch(seq, sessionId)` 会把起点解析成检查点（一段摘要）而非原始事件——跨会话取回「拿回的是摘要，不是原文」。
- **根因**：折叠总从 run 的第一个 surface 节点开始，而在稳态下那个位置正好是上一次折叠留下的检查点；它的 seq 是「折叠当时的最大号」，比其后的真实节点都大（`26356 → 26467 → 26822 → 26852 → 26905` 一路如此）。`fold.js` 的 `startSeq = nodes[run.start].seq` 因此取到检查点。这是 fold.js 一直存在的语义问题，v10 新增的 `seqRange` 只是把它暴露出来。
  - **不能改 fold.js**：`surfaceOp.startSeq` 供生产端 `indexOf(startSeq)` 定位并替换旧检查点，必须保留「从检查点开始」，否则检查点会越积越多。
- **修复**（`lib/pipeline.js`，仅改导出侧）：
  1. `materialForRange()` 的 `seqRange` 改为「被 shadow 的节点里、**排除检查点**之后的真实内容 min/max」。既修倒挂，也修「指向摘要」。
  2. 同函数遍历时**跳过 `sourceKind === "memory"` 的检查点**，不再把上一块的摘要当原料再喂给蒸馏器（此前记忆在吃自己的尾巴）。
- **验证**：
  - 新增回归测试 `test/plugin.test.js`「a second fold anchors seqRange on real content, never on the carried checkpoint」；已用「临时回退修复」证明该测试在坏代码下**必红**（`seqRange start must not be the carried checkpoint`），修复后**必绿**。
  - 全量 `node --test`：**402 项 / 401 通过 / 0 失败 / 1 跳过**。
  - 真实台账回填：8 条全部改到正确跨度，复查 **0 条倒挂**（`[26467,26764]→[26429,26764]`；`[26822,26812]→[26766,26812]`；`[26852,26874]→[26813,26874]`；`[26905,27089]→[26875,27089]`）。回填脚本 `scripts/backfill-seqrange.mjs`（默认 dryRun，`--apply` 落盘并先备份）。
- **部署**：`lib/pipeline.js` 已同步 profile 副本（hash 一致 + `node --check`）；**代码与台账回填都需重启桌面端才生效**（LTM 表在内存中打开，外部改文件在下次写回时会被覆盖）。
- **重启后实机复验（2026-11-13 13:34，进程 13:32 启动）**：
  - 应用已回写 `dsh_memory.json`（13:34:43），**8 条回填值全部保住、0 条被内存旧版覆盖**——说明回填与新代码对齐正确，写回无损。
  - 重启后新代码自产 **2 条新记录**（`ltm-1b6f745c`、`ltm-8ba78266`，同源 `session-9227cac5`，`seqRange:[27092,27527]`），未倒挂。
  - 关键判据：对本会话直接 `memory_fetch(27092)` 返回的是**一条 3801 字的真实内容事件（recall 注入消息），而非折叠检查点**——证明新锚起点指向真实内容，端到端修复成立。

### Added — 跨会话取回 + LTM 记录带事件锚（seqRange）

- **动机**：`memory_fetch(seq)` 原先只认当前会话；LTM 记录里的指针一旦跨会话就失效。而 `sources[].seqRange` 在 schema 里**早就存在**（`ltm-domain.js:48`），只是从未被写入——数据模型一直缺一个生产者。
- **改动 1（取回侧）**：`lib/fetch-tool.js`
  - `parameters` 增加可选 `sessionId`。**不能写 `required: false`**——本 build 的 `compilePropertyMap` 会以 `parameters.X.required must be true when present` 拒掉整个插件加载，可选参数只能省略 `required` 键。
  - `execute` 取值优先级：`args.sessionId`（trim 后非空）→ `exec.agent.session.id`。空串/纯空白/非字符串一律回落当前会话，所有既有指针行为不变。
  - **重启后真·跨会话实机演练（2026-11-13）**：用 `memory_fetch(seq=14, sessionId="session-61eedb43-…")`（memory-3 旧项目、5 天前）跨会话取回，拿到 9915 字原文，内含 `MCP servers: [easyeda,keil,numen]`（旧项目配置）；对照组本会话同 seq=14 为 9976 字、模型串与 MCP 列表均不同——证明 `sessionId` 确实切换到目标会话读取，而非落到当前会话。分页续读 `offset=6000` 返回 `[6000,9915)`、`nextOffset=-1`，跨会话分页亦正常。
- **改动 2（记录侧）**：
  - `lib/pipeline.js`：`materialForRange()` 增加返回 `seqRange`。**（早期实现直接取 `[plan.startSeq, plan.endSeq]`；后经查证起点会锚到记忆检查点、并能倒挂，已在下方「Fixed — seqRange 起点锚错」修正为真实内容 min/max。）** 附 `Number.isFinite` 守卫——缺任一边时**不产出该字段**，否则 `[undefined, undefined]` 长度仍为 2，会骗过下游所有数组长度检查、把空锚写进台账。
  - `lib/distill.js`：`distillTurn()` 把该 span 铺到**每一个**产出节点（task/decision/episode）上；缺省或形状不合法时不加字段（老调用方原样工作）。
  - `lib/promote-runner.js`：晋升时把节点的 `seqRange` 透传 `toLtmRecord`，落成 `sources[].seqRange`。
- **验证**：
  - 全量 `node --test`：**401 项 / 400 通过 / 0 失败 / 1 跳过**（新增 7 条测试：fetch 2 条、distill 2 条、promote-runner 3 条）。
  - 真实台账（`~/.dsh/storages/dsh_memory.json`，247 条 / 220 live）基线 `seqRange` 记录 = **0**；用真实代码跑一次 fold→distill→promote，新记录带 `seqRange:[22480,22507]`，而同场对比的 turn 302/304 旧记录仍无该字段——**新旧共存、向后兼容**。
  - `plan.startSeq`/`plan.endSeq` 已核对确为真实字段（`fold.js` typedef 第 70–71 行，赋值处取 `nodes[...].seq`），不是猜测。
- **部署**：4 个文件已同步 profile 副本（MD5 一致 + `node --check` 通过）。同步前做了全量比对：25 个 lib 文件里只有这 4 个不同，说明副本此前一直同步，不是长期脱节——**凡改 `lib/` 下非 client 文件，也必须同步 profile 副本**（此前只记录了 `client.js` 的坑）。

### Fixed — 面板「展开明细」超长内容被裁掉、看不见也够不着
- **现象**：明细展开后条目多（几十上百条），超出的部分直接消失，没有滚动条，无法查看。
- **根因**：`src/client/MemoryView.tsx` 的 `renderBuckets()` 明细容器只有 `marginTop: 6`，**既无高度上限也无 `overflow`**。展开的桶把容器越撑越高，超出面板可视区的部分被直接裁掉，浏览器也没有机会生成滚动条。
- **第一版修复（未根治）**：给明细容器加 `maxHeight: min(46vh, 360px)` + `overflowY: auto`。重启后用户反馈**仍无滚动条**——说明只给明细区加限高不够：面板根容器本身没有滚动出口，明细区连同它自己的滚动条一起被父级裁掉了。
- **第二版修复（v10.1，双保险）**：
  1. 明细区 `maxHeight` 改为**纯数字 340**（React 转 `340px`），不再依赖 `vh`/`min()` 解析；
  2. 给 `MemoryView` 根容器加 `height:100%` + `maxHeight:100%` + `boxSizing:border-box` + `overflowY:auto`，作为整个面板的滚动兜底——父级给了确定高度（右侧栏通常如此）时所有超长内容都能滚到；父级高度 auto 时这两条是空操作，不会更糟。
  3. 加版本探针 `client v10.1-scroll`（显示在面板最底部地址行下方），用于肉眼确认页面是否真的加载了新 bundle——若看不到它，就是 bundle 没刷新，而非样式无效。
- **验证**：`npx tsdown` 打包成功；产物校验 `v10.1-scroll`/`maxHeight: 340`/`height: "100%"` 各 1 处，旧 `min(46vh` 为 0；`node --test` 394 项 393 pass / 0 fail。
- **待确认**：本次为推断性修复，尚需在真实面板里验证滚动是否出现（见版本探针）。
- **部署陷阱（两次「重启没变化」的真正原因）**：桌面端加载的**不是** workspace 源码目录里的 `lib/client.js`，而是 profile 副本
  `C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-memory\lib\client.js`。该副本是**独立文件拷贝，不是 symlink/junction**。
  因此改完 `src/client/*.tsx` 并 `npx tsdown` 打包之后，**必须额外拷一次**，否则界面永远停在旧版本——典型症状就是「代码改了、打包过了、重启了，却一点变化都没有」。
  ```powershell
  Copy-Item <workspace>\dsh-memory\lib\client.js "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-memory\lib\client.js" -Force
  ```
  校验：`Select-String -Path <profile>\lib\client.js -Pattern 'v10.1-scroll'` 应命中 1 处。凡改客户端渲染，一律按「改源码 → tsdown → 同步 profile 副本 → 重启」四步走。


### Fixed — 面板「展开明细」报 `Failed to fetch`（7788 跨源被浏览器拦截）
- **现象**：点开「展开明细」按钮，面板显示 `Failed to fetch (需桌面端宿主在 7788 提供服务)`，而 `curl http://127.0.0.1:7788/context.json` 明明是 200、数据齐全。
- **根因**：面板 UI 加载自 DSH Web GUI（`:64907`），fetch 到 `:7788` 属**跨源**；7788 服务未发 `Access-Control-Allow-Origin` 头，浏览器在 CORS 校验阶段直接 reject，报 `Failed to fetch`。`curl`/PowerShell 不走 CORS，所以能通——这正是「命令行正常、浏览器失败」的典型症状。
- **修复**：`lib/ltm-view.js` 的 `http.createServer` 请求入口统一 `setHeader` 三个 CORS 头（`Access-Control-Allow-Origin: *` / `-Methods: GET,POST,OPTIONS` / `-Headers: Content-Type`），并在任何路由前处理 `OPTIONS` 预检（204）。一处覆盖所有端点，对同源请求无影响。
- **验证**：临时服务（port 0）实测 `GET /context.json` 返回 `ACAO:*`、`OPTIONS /split` 返回 204 + 方法列表；全量测试 393 pass / 0 fail。**注意**：正在运行的 7788 是启动时 listen 的旧代码，改文件不热重载，需重启桌面端后生效。

### Added — 面板「展开明细」：看得到当前窗口逐条内容
- 面板上半「上下文组成」原来只有 system/tools/message 三个聚合数与一条比例条，看不到**具体是哪几条消息**。新增「展开明细」按钮：
  - `lib/context-detail.js`（新文件）：纯函数 `buildContextDetail(seqs, derive, tokensOf)`——把会话可见节点归约成逐条行 `{ seq, role, kind, bucket, tokens, chars, toolNames, preview }`，再按四个桶（系统/工具/助手/用户）汇总。中文 token 用 bigram-ish 估计（CJK≈1/字、ascii≈1/4），纯函数、可单测。
  - `lib/index.js`：`agent/pre-step` 里调用 `snapshotContextDetail(agent)`，把当前 surface 的逐条明细快照到模块级 `lastContextDetail`（每步重建，best-effort，出错保留旧值）。经 `startLtmViewServer({ getContext })` 暴露。
  - `lib/ltm-view.js`：新增 `GET /context.json`——返回最近一次快照（`{ ready:false }` 表示尚无快照）。
  - `src/client/MemoryView.tsx` → 重新打包 `lib/client.js`：`ContextSection` 加「展开明细 ▸ / 刷新明细」按钮，fetch `/context.json`，四个桶默认折叠、点击展开列出每条（#seq、role、🔧工具名、tokens·字数、文本预览）。数据源是宿主 7788 服务，不碰官方 pak 包。

### Added — 拆分组（split work）
- 新增「✂️ 拆分组」能力：把单个 `work:*` 分组按内容拆成 N 个子组。
  - `lib/work-name.js`：新增纯函数 `parseWorkSplit`（把 LLM 产出的分组方案正规化成 `{ name, memberIds:[...] }` 列表）。
  - `lib/promote.js`：新增 `applyWorkSplit`（与 `applyWorkNames` 对称）——为每条成员改写 `work` 键、重建子组枢轴、退役源枢轴。
  - `lib/ltm-view.js`：记忆看板新增拆分入口——选组 → `POST /split {work, dryRun:true}` 拿预览方案（不写盘）→ 确认后 `POST /split {work, plan}` 落库。
  - 两步式流程遵循「dryRun 预览不写盘」原则，与整理/改名一致。

### Added — 单一主题组禁拆（拆分入口的前置守门）
- `lib/work-name.js`：新增纯函数 `isLikelySingleTopic(titles, {threshold=0.5, minMembers=2})`——用字符 bigram 的成对 Jaccard 均值近似判断一组标题是否「单一主题」（中文无需分词）。
- `lib/ltm-view.js`：`GET /data.json` 的每个 `work` 组附带 `singleTopic` / `topicScore`；看板拆分弹窗里，`singleTopic=true` 的组按钮灰化禁用（`disabled` + 提示「单一主题，禁拆」），并在全部组都被标记时给出整段说明。
- **动机**：成员内容高度相似的组（如多条寒暄）拆开只会制造碎片，历史上正是这类操作触发了「源枢轴拆丢」的 bug；从入口挡住比事后修更划算。
- 实测真实数据：15 个 ≥2 条的活跃组里 0 个被误标（阈值偏保守，只拦真·同质组）。


### Fixed — 记忆看板输入框深色下文字不可读
- **现象**：记忆看板（LTM 视图）里搜索/输入框在深色模式下，输入的文字与背景几乎同色，看不清（placeholder 也几乎不可见）。
- **根因**：输入框内联样式写了深色底 `background:#2d2d30`，文字却用 `color:inherit`。深色模式下 `<input>` 的 UA 默认前景色会盖掉继承值，渲染成深色字压深底。
- **修复**：显式给输入文字设浅色 `color:#e8e8e8` 并同步 `caret-color`；placeholder 设 `#8a8a8a`（原来几乎不可见）；浅色模式用媒体查询覆盖为白底深字，跟随系统；补 `color-scheme` 让控件在深色下渲染一致。
- 纯样式改动，不动逻辑；已同步到 profile 内置副本，重启桌面端后生效。

### Fixed — 拆分把源枢轴拆丢（孤儿枢轴 / 记录"消失"）- **现象**：对某组执行拆分后，该组枢轴变成 `archived=true` 且 `children=0`，成员散落成孤儿，看板里像是「整组没了」；或拆成单组时组直接消失。
- **根因**：`applyWorkSplit` 退役源枢轴的逻辑与「源组是否仍有成员」失衡——
  - 当拆分方案把所有成员都归到同一个新名下（no-op），或只搬走部分成员时，旧代码仍会退役源枢轴，却没有稳定的新枢轴接管；
  - `splitsAtAll` 只拦「全归原名」，但拦不住「改名却只形成单组」等边界。
- **修复**：
  1. **源枢轴退役守卫**：退役源枢轴前检查——若源组仍留有 ≥2 个 live 成员，则**不退役**；只有当源组被搬空（0 成员）才退役。避免产生「组还在、枢轴已归档」的孤儿态。
  2. 拆分路径与改名路径共用同一套「枢轴写回 + 退役」守卫，防止再次漂移。
- **数据恢复**：本次误伤的一个历史组（`work:闲聊与工具自检`，3 条寒暄记录）已用备份后的安全脚本恢复——将该枢轴由 `archived=true` 改回 `false` 并校验 3 条成员全部 `pivotId` 一致；恢复前已备份到 `~/.dsh/storages/dsh_memory.backup-before-pivot-restore.json`。全库扫描确认「≥2 live 成员但枢轴缺失/归档」的组数为 **0**。

### Tests
- `test/work.test.js`：新增 `applyWorkSplit` 回归测试 3 例——
  1. no-op（全归原名）不误封枢轴；
  2. 正常拆成 2 组时成员数据完整、无丢失、子组枢轴正确建立；
  3. 源组被搬空时源枢轴正确退役、不残留孤儿。
- 全量测试：**371/372 通过（0 fail，1 skip）**，较修复前 +3。
- `test/work.test.js`：新增 `isLikelySingleTopic` 测试 4 例（同质寒暄⇒标记 / 异质主题⇒放行 / 成员<2 不标 / 阈值生效且分数有界）。
- 全量测试（含配色修复 + 单一主题守门后）：**382 项 / 381 通过 / 0 失败 / 1 跳过**。
- `README.md`：更正验证段跑法——用 `npm test`（= `node --test test/*.test.js`），并写明裸 `node --test` 会误扫非测试文件的坑。

### Notes
- `lib/promote.js` 已同步到 profile 内置副本 `~/.dsh/profiles/desktop/node_modules/dsh-memory/lib/`，重启桌面端后生效；重启后实测数据层健康（目标组枢轴 live、成员全挂载）。
- 实践结论：**同类内容堆在一起的组不该拆**（拆了只制造碎片）；只有当一个 `work:` 组里明显混着两个不同主题时才值得拆。
