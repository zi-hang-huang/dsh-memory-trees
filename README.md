# dsh-memory

[![test](https://github.com/zi-hang-huang/dsh-memory-trees/actions/workflows/test.yml/badge.svg)](https://github.com/zi-hang-huang/dsh-memory-trees/actions/workflows/test.yml)

**让长对话不再越聊越贵，也不再"聊着聊着忘了自己是谁"。**

`dsh-memory` 是 DeepSeek Harness 的记忆插件：它把会话历史按 token 预算折叠成记忆节点，并给模型三样东西——短期记忆、跨会话长期记忆、以及一份稳定的自我认知。模型每一步看到的是

```
系统提示词
  + <memory zone="volatile">…</memory>     ← 短期记忆（本次会话折叠出的要点）
  + <memory zone="recall">…</memory>       ← 召回（从长期记忆里按需检索的相关条目）
  + 最近若干轮原文
  + <memory zone="self">…</memory>         ← 自我认知（身份 / 偏好 / 约束）
```

而不是一份无限增长的完整转录。

> 完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 它解决什么问题

| 不装 | 装了 |
|---|---|
| 对话越长，每轮重发的历史越多，成本线性上涨 | 历史按预算折叠，长会话的成本曲线被压平 |
| 上下文塞满后，早期的约定、偏好被挤掉 | 关键结论进长期记忆，跨会话也能召回 |
| 换个会话就"失忆"，每次都要重新交代背景 | 长期记忆是跨会话的全局存储 |
| 人格/偏好每轮靠系统提示词硬塞 | 自我认知独立成一张树，可单独查看与编辑 |

## 三棵记忆树 + 一个长期库

插件把记忆分成四个独立的存放处，各有各的预算和用途：

| 存放处 | 在哪 | 活多久 | 谁写 |
|---|---|---|---|
| **短期记忆**（`volatile`） | 会话 surface 的 `memory` 消息 | 跟随本次会话 | 折叠时自动写 |
| **召回区**（`recall`） | 每轮临时注入的请求文本 | 一次请求 | pre-step 按需检索 |
| **自我认知**（`self`） | `memory:self` 消息 + 落盘覆盖层 | 跨会话 | 用户（模型无写权限） |
| **长期记忆**（LTM） | `~/.dsh/storages/dsh_memory.json` | 跨会话、全局 | 折叠晋升 / `memory_save` / 整理 |

## 安装

```powershell
dsh plugin --profile <你的 profile> add D:\path\to\dsh-memory
```

然后把 `dsh-memory` 加进该 profile `package.json` 的 `dsh.profile.bundles`（bundle patch 才会生效），或直接把本包的 `cordis.patch.yml` 内容并进 profile 的 patch 层。

依赖的服务（`tools`、`session`）都在 `dsh-base` 里、且都排在 `agent` 之前，不需要额外装包。长期记忆需要宿主的 `storageDomain` 服务；profile 里没有存储栈时 LTM 会**静默降级**（不报错、只是不记），其余功能照常。

## 工作方式

每个 `agent/pre-step` 做三件事：

1. **折叠**：把「超出逐字窗口的历史」蒸馏成记忆节点，写一条携带节点的 `user/message`，用 `surfaceOp: replace` 覆盖那一整段。
2. **召回**：用当前用户消息去长期记忆里检索相关条目，命中则拼成一小块注入本次请求（临时文本，不进 surface、不落盘、不参与折叠）。
3. **发布自我认知**：需要时把 `memory:self` 追加到 surface 末尾；已有且未变则不动。

三条硬约束（都由测试钉住，不是为了好看）：

- **不碰 surface 第 0 号节点**。那是系统提示词，会话层只允许 `system/message` 改写它。
- **不在工具调用与结果之间切开**。切了模型会看到永远等不到结果的调用，请求直接被拒。
- **不折叠屏障注入**。`skill-catalog` 与 `agent-instructions` 靠读 `session.surface.nodes` 决定要不要重新发布；把它们折掉，它们下一轮会整份重发（目录最大 9,507 tok）。

## 给模型的六个工具

| 工具 | 作用 |
|---|---|
| `memory_stats` | 查看本会话折叠了几次、跳过原因、被遮蔽的 token、保留/丢弃节点数 |
| `memory_recall` | 按关键词检索长期记忆，返回命中的记录和即将呈现给模型的那块文本 |
| `memory_save` | 直接把一条持久事实写进长期记忆，不依赖折叠（记用户偏好、决定、已核实的事实） |
| `memory_fetch` | 分页取回被折叠的大块原文（折叠时留下 `seq` 指针；可带 `sessionId` 跨会话取） |
| `memory_organize` | 把"其实是同一件事"的工作组合并（两段式：先 `dryRun` 出方案，用户确认后再 `apply`） |
| `memory_split` | 反向操作：把被过度合并的工作组拆成子组 |

## 配置

`Config` 是 schemastery，核心字段要么 `.required()`（缺了就加载失败，比静默默认成错的值更容易诊断），要么有明确 `.default()`。

**最常调的三个：**

| 字段 | 默认 | 含义 |
|---|---|---|
| `retainTokens` | 12000 | 逐字尾巴的 token 预算。**唯一的成本旋钮**——调大 = 每轮更贵。 |
| `volatileBudget` | 2500 | 短期记忆（易变区）的 token 预算。 |
| `distillPolicy` | `rules` | `rules` 确定性摘录 / `llm` 模型总结（更慢、更贵、质量更高） |

**其余关键字段：**

| 字段 | 默认 | 含义 |
|---|---|---|
| `recallEnabled` | `true` | 召回总开关，一次管住 pre-step 注入块和 `memory_recall` 工具 |
| `recallBudget` | 1200 | 召回块的 token 上限（独立预算，不占 `retainTokens`） |
| `recallTopK` | 5 | 排序后先取几条再裁预算 |
| `recallMaxExtra` | 2 | 同 `subject` 命名空间的扩展条数；0 关闭 |
| `sessionRecallEnabled` | `true` | 额外检索**本会话**事件日志，补充原文片段 |
| `selfEnabled` | `true` | 是否发布 `memory:self` |
| `ltmEnabled` | `true` | 是否启用长期记忆（晋升 + 召回） |
| `ltmMaxNodes` / `ltmMaxTokens` | 500 / 200000 | 长期记忆的节点与 token 上限 |
| `workEnabled` | `true` | 是否把同一工作的几条记忆归组（≥2 条自动生成"枢轴"） |
| `saveEnabled` | `true` | 是否暴露 `memory_save` 工具 |
| `verbose` | `false` | 把每次折叠决策写进插件日志 |

`retainTokens` 低于 1000 会**拒绝启动**：窗口比一次自我认知提交（约 250 tok）还小的话，每步都会折掉整段历史再重发一遍人格，看起来像抖动，实际是每步付一次全量重编码。

## 召回是怎么实现的（以及它做不到什么）

本地 **BM25 over 字符二元组**，纯离线的词法检索：**不调模型、不建向量索引、没有额外依赖**，500 条记录上单次查询约 0.05 ms。它擅长命中精确标识符（`retainTokens is 15000`、`--test-concurrency=1`）这类词。

**一个必须说清的限制**：字符二元组不匹配同义改写。「保留」和「保存」共享一个汉字但没有共同的二元组，所以**匹配不上**。设计方向是「宁可漏，不要错配」——误召回的记忆会以权威的口吻出现，那比沉默更糟。

## 成本形态（实测，不是估计）

| 量 | P50 | P95 |
|---|---|---|
| 不折叠的基线请求 | 335,514 | 1,326,896 |
| 折叠后每轮重编码（窗口 8 条） | 3,192 | 11,270 |
| 系统提示词（固定成本） | 3,844 | 11,600 |

**窗口成本是每轮的、不是一次性的。** 逐字尾巴每轮几乎整窗位移，所以「每轮重编码量 ≈ 窗口自身体积」。调大 `retainTokens` = 每轮线性加钱，而不是把总量一次性抬高。这一点在 UI 上必须写明，否则很容易被当成「总量问题」去调。

## 图形化设置页（v11 / v12）

DSH 设置面板里有一栏独立「记忆」，可直接调 7 个常用字段并**保存即生效、无需重启**：蒸馏方式、逐字保留预算、短期区预算、召回候选数、召回总开关、自我认知开关、详细日志。

底部还有一块「自我认知」编辑区：改标题、改正文、切类别（身份/偏好/约束…）、`＋ 新增一条`、`删除`、`恢复默认`。保存后**跨会话生效**，存在 `~/.dsh/storages/dsh_memory_self.json`。

几个刻意的设计：

- **只落用户可见字段**：文件里只存 `id/kind/order/title/body`，其余结构字段读出时重新推导——手改文件也注入不了非法节点。
- **拒绝而非截断**：标题 >120 字或正文 >600 字直接报错，不会静默切一半（半截正文读起来像完整事实）。
- **「恢复默认」写默认值、不删文件**：删文件会让当前会话 surface 的旧节点被读回来，用户点了恢复却看到旧内容。

**实现要点**：设置服务只认 `.volatile()` 字段，而 volatile 字段解析后会被包成 `Volatile` 对象；因此 `Config = withLiveFields(...)` 标记这 7 个字段，`apply` 开头用 `unwrapVolatileConfig(config)` 一次性解包成普通只读视图，其余 `config.x` 读取无需改动。浏览器半（`src/client/SettingsPage.tsx`）注册进 `settings.section` 槽，读写走插件自己的 7788 fenced 路由，由宿主转成 `settings.update`。

> 改完 `lib/*.js` 或 `lib/client.js` 后**必须重启桌面端**：7788 在启动时 `listen`，不热重载。

## 已知边界

- **规则蒸馏不是摘要**。`rules` 模式下标题是截断加关键词、正文是结构化模板，质量上限低于 `llm` 模式。系统内没有模型可用时会自动回落到 `rules`。
- **字符二元组召回不认同义改写**（见上文）。语义相似但用词不同的记忆会漏掉。
- **自我认知只能由用户改**。模型没有写权限，这条是故意的。
- **长期记忆需要宿主的存储栈**。profile 里没有 `storageDomain` 时 LTM 静默降级为不记，折叠与自我认知不受影响。
- **不新增会话事件类型**。会话层的事件集是封闭的，运行期 `append()` 也设不了 `ignorable` 标记，所以全部表达为 `user/message` + `surfaceOp`——压缩引擎本身也是这么做的。

## 与其他记忆/压缩插件必须二选一

本插件通过 `surface` 替换通道压缩历史，和压缩引擎（含 billion-context 的 gate）用的是**同一条通道**。两者同时启用时可能都认为自己在管这条通道，结果是其中一个静默不生效——数据不会损坏，但现象是「装了没反应」，只能从日志看出来。请把它与其它记忆/压缩插件当作**二选一**，不要叠加。

## 验证

```powershell
cd dsh-memory
node --test test/*.test.js   # 或 npm test；只跑 test/ 下的 *.test.js
```

> **跑法坑**：不要用裸 `node --test`。它会把 `test/` 之外的 `.js`（含 `lib/`、`sim/` 等）也当测试文件扫，
> 一是数字对不上（会混进非测试脚本），二是遇到非 ESM/无断言文件会报错。

当前基线：`test/` 下 26 个 `*.test.js`，**429 项 / 428 通过 / 0 失败 / 1 跳过**（跳过的那条依赖本机真实 DSH profile 状态，按设计 skip）。

> **开发辅助脚本**：`sim/`、`scripts/` 是作者本地开发用的一次性工具，依赖仓库外的
> 会话日志目录（默认 `~/.dsh/sessions`，可用 `DSH_SESSIONS_ROOT` 覆盖）。
> 克隆本仓库的人**不需要它们**，测试也不依赖：只有 `test/` 下的 `*.test.js` 参与测试。

CI 在 Node 22 / 24 双版本上跑同一套测试。在干净环境（无 `~/.dsh`）下，`ltm-domain` 的 4 条契约测试会按设计 skip，结果为 **425 通过 / 0 失败 / 4 跳过**，退出码 0。

装进 profile 后，在会话里调 `memory_stats` 可以看到本会话的折叠次数、跳过原因分布、被遮蔽 token 数、保留/丢弃节点数；面板与独立页面可查看完整的长期记忆树。
