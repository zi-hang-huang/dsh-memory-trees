# dsh-memory

把 DSH 会话历史按 token 预算折叠成记忆节点，再用一条 `user/message` 替换被折叠的区间。模型每步看到的是

```
系统提示词 + <memory zone="volatile">…</memory> + 最近若干轮原文 + <memory zone="self">…</memory>
```

而不是一份无限增长的转录。这是 `dsh-memory-plan.md` v1.5 的 **v1 折叠实现**（不是 v4 的召回、也不是 v2 的模型蒸馏）。

> 变更记录见 [CHANGELOG.md](CHANGELOG.md)（含「拆分组」新增能力与源枢轴误封的修复）。

> **与其他记忆工具可能存在冲突。** 本插件通过 `surface` 替换通道压缩历史，和压缩引擎（含 billion-context 的 gate）用的是同一条通道。两者同时启用时可能都认为自己在管这条通道，结果是其中一个静默不生效——数据不会损坏，但现象是「装了没反应」，只能从日志看出来。把它与其它记忆/压缩插件当作**二选一**，不要叠加。

## 安装

```powershell
dsh plugin --profile memory-lab add D:\path\to\dsh-memory
```

然后在 profile 的 `package.json` 里把 `dsh-memory` 加进 `dsh.profile.bundles`（bundle patch 才生效），或者直接把本包的 `cordis.patch.yml` 内容并进 profile 的 patch 层。

依赖的服务都在 `dsh-base` 里、且都排在 `agent` 之前：`tools`、`session`。不需要额外装包。

## 做什么

每次 `agent/pre-step`：

1. **取回自我认知**：从 surface 里读现有 `memory:self` 消息携带的节点（没有就用默认四节点）。
2. **折叠**：把「超出逐字窗口的历史」蒸馏成记忆节点，写一条携带节点的 `user/message`，用 `surfaceOp: replace` 覆盖那一整段。
3. **发布自我认知**：需要时把 `memory:self` 追加到 surface 末尾；已有且未变则不动。

三条硬约束（都由测试钉住，不是为了好看）：

- **不碰 surface 第 0 号节点**。那是系统提示词，会话层只允许 `system/message` 改写它。
- **不在工具调用与结果之间切开**。切了模型会看到永远等不到结果的调用，请求直接被拒。
- **不折叠屏障注入**。`skill-catalog` 与 `agent-instructions` 靠读 `session.surface.nodes` 决定要不要重新发布；把它们折掉，它们下一轮会整份重发（目录最大 9,507 tok）。

## 配置

`dsh-memory/lib/index.js` 的 `Config` 是 schemastery，每个字段都 `.required()`：缺一个就加载失败，比静默默认成错的值更容易诊断。

| 字段 | 默认 | 含义 |
|---|---|---|
| `retainTokens` | 12000 | 逐字尾巴的 token 预算。**唯一值得调的旋钮**，也是唯一的成本旋钮。 |
| `volatileBudget` | 1500 | 变动区（短期记忆）token 预算。 |
| `minNodesToFold` | 2 | 小于这个数量就不折，避免为 1 个节点写一份检查点。 |
| `admitKinds` | `["user","agent-message","goal"]` | 哪些 `source.kind` 可以进记忆。其余一律丢弃。 |
| `barrierKinds` | `["skill-catalog","agent-instructions"]` | 哪些注入绝不能被折走。 |
| `selfEnabled` | `true` | 是否发布 `memory:self`。 |
| `verbose` | `false` | 把每次折叠决策写进日志。 |

`retainTokens` 低于 1000 会**拒绝启动**：窗口比一次自我认知提交（约 250 tok）还小的话，每步都会折掉整段历史再重发一遍人格，看起来像抖动，实际是每步付一次全量重编码。

## 成本形态（实测，不是估计）

| 量 | P50 | P95 |
|---|---|---|
| 不折叠的基线请求 | 335,514 | 1,326,896 |
| 折叠后每轮重编码（窗口 8 条） | 3,192 | 11,270 |
| 系统提示词（固定成本） | 3,844 | 11,600 |

**窗口成本是每轮的、不是一次性的。** 逐字尾巴每轮几乎整窗位移，所以「每轮重编码量 ≈ 窗口自身体积」。调大 `retainTokens` = 每轮线性加钱，而不是把总量一次性抬高。这一点在 UI 上必须写明，否则很容易被当成「总量问题」去调。

## 验证

```powershell
cd dsh-memory
npm test                              # = node --test test/*.test.js，跑 test/ 下全部 *.test.js
node sim/foldsim.mjs --sessions 999   # 回放真实会话，检查会话层不变量
```

> **开发辅助脚本**：`sim/`、`scripts/` 是作者本地开发用的一次性工具，依赖仓库外的
> `dsh-memory-v0/lib/log.mjs` 与真实会话日志目录（默认 `~/.dsh/sessions`，可用 `DSH_SESSIONS_ROOT` 覆盖）。
> 克隆本仓库的人**不需要它们**，`npm test` 也不依赖：只有 `test/` 下的 `*.test.js` 参与测试。

> **跑法坑**：不要用裸 `node --test`。它会把 `test/` 之外的 `.js`（含 `lib/`、`sim/` 等）也当测试文件扫，
> 一是数字对不上（会混进非测试脚本），二是遇到非 ESM/无断言文件会报错。
> 正确入口是 `npm test`（已在 `package.json` 里固化为 `node --test test/*.test.js`），只跑 `*.test.js`。
>
> 当前基线：`test/` 下 26 个 `*.test.js`，**429 项 / 428 通过 / 0 失败 / 1 跳过**。

`sim/foldsim.mjs` 在真实会话日志上重放折叠、逐轮检查五条不变量（0 号节点不进范围、范围内无屏障、工具配对余额为 0、seq 不重复、覆盖所有被遮蔽节点）。当前全语料结果：67 会话 / 43 会话发生折叠 / 62 次折叠 / **0 违规**；检查点 P50 134 tok、P95 1,403 tok（预算 1,500）。

装进 profile 后，在会话里调 `memory_stats` 可以看到本会话的折叠次数、跳过原因分布、被遮蔽 token 数、保留/丢弃节点数。

## 图形化设置页（v11）

DSH 设置面板里有一栏独立「记忆」，可直接调 7 个字段并**即时生效、无需重启**：

| 字段 | 含义 |
|---|---|
| `distillPolicy` | 蒸馏方式：`rules`（确定性摘录）/ `llm`（模型总结） |
| `retainTokens` | 逐字保留尾部预算（最小 1000；调大 = 每轮更贵） |
| `volatileBudget` | 短期（易变）区预算 |
| `recallTopK` | 召回候选数（预算裁剪前先排序几个） |
| `recallEnabled` | 召回总开关（同时管 pre-step 块与 `memory_recall` 工具） |
| `selfEnabled` | 是否发布 `memory:self` 自我认知消息 |
| `verbose` | 是否把折叠决策写进插件日志 |

**实现要点**：设置服务只认 `.volatile()` 字段，而 volatile 字段解析后会被包成 `Volatile` 对象；因此 `Config = withLiveFields(...)` 标记这 7 个字段，`apply` 开头用 `unwrapVolatileConfig(config)` 一次性解包成普通只读视图，其余 `config.x` 读取无需改动。浏览器半（`src/client/SettingsPage.tsx`）注册进 `settings.section` 槽，读写走插件自己的 7788 fenced 路由（`GET /settings.get`、`POST /settings.update`），由宿主转成 `settings.update`。

> 改完 `lib/*.js` 或 `lib/client.js` 后**必须重启桌面端**：7788 在启动时 `listen`，不热重载。

### 自我认知编辑区（v12）

设置页底部还有一块「自我认知」：可直接改正文、改标题、切换类别（身份/偏好/约束…）、`＋ 新增一条`、`删除`，以及 `恢复默认`。保存后**跨会话生效**。

- **存储**：`~/.dsh/storages/dsh_memory_self.json`（独立覆盖层）。`publishSelf` 的取值顺序是 **覆盖文件 → surface 上的 `memory:self` → 内置默认四节点**；文件不存在时行为与旧版逐字节一致。
- **只落用户字段**：文件里只存 `id/kind/order/title/body`，`zone/parentId/weight/pinned/rev/archived` 在读出时重新推导——手改文件也注入不了非法节点。
- **拒绝而非截断**：标题 >120 字或正文 >600 字直接报错，不会静默切一半（半截正文读起来像完整事实）。
- **恢复默认写默认值、不删文件**：删文件会让当前会话 surface 的旧节点被读回来，用户点了恢复却看到旧内容；写默认值可保证任何会话结果一致。
- **路由**：`GET /self.get`、`POST /self.update`（409 版本冲突 / 400 校验拒绝 / 503 无服务）、`POST /self.reset`。

## 已知边界（v1 有意不做）

- **没有跨会话长期记忆**。树活在检查点消息里（`message.source.nodes`），resume/fork 能恢复，但换会话就没了。LTM 与 `storage-domain` 落盘属于 v4。
- **没有召回区**。v1 不按需检索历史，只保留逐字窗口 + 变动区。召回（BM25 + 图扩展）属 v4。
- **补丁是纯规则的**（P3 已拍板）。因此 `title` 是截断 + 关键词，`body` 是结构化模板，不是摘要；质量上限低于模型蒸馏。
- **自我认知只能由用户改**。模型没有写权限（D11）：想改必须走提议 → 用户确认。本 v1 还没有实现提议通道，只有默认的四节点与用户手工改。
- **不新增会话事件类型**。会话层的事件集是封闭的，运行期 `append()` 也设不了 `ignorable` 标记，所以全部表达为 `user/message` + `surfaceOp`——压缩引擎本身也是这么做的。
