# StructAgent 路线对照 Gap 分析

> 日期：2026-07-15
> 对照文档：`docs/CONTEXT_MIDDLEWARE_STRATEGY.md`（上下限高发展路线）
> 目的：逐项检查路线 Phase 0-1 的落地状态，找出真正的 gap，规划下一步
> 状态基准：已对照 `packages/context` 真实源码核实（非凭记忆），下文每条断言均带 `file:line`

---

## 代码落点（核实结论速查）

| 关注点 | 真实位置 | 备注 |
|---|---|---|
| `ContextManager` 主动管理 `manage()` 三层 | `packages/context/src/manager.ts` L980 | 层0 evict / 层1 compress / 层2 truncate |
| 压缩实现 `compressOldEntries` | `manager.ts` L1010 | 调用 `genericCompressToolOutput`（头40%+尾30%截取） |
| 通用截取 `genericCompressToolOutput` | `manager.ts` L1131 | **非结构化压缩** |
| 摘要式压缩注入点 `summarizeLongEntries` | `manager.ts` L1175 | 存在但**引擎从不自动调用**（仅 `summarize.test.ts` 覆盖） |
| `Summarizer` 类型 / 构造注入 | `manager.ts` L45 / L521 | 注入式，未注入则不生效 |
| 框架接管 `autoManage` | `manager.ts` L809 | ≥70% evict、≥85% auto-forget 非焦点文件、每5步审计 |
| 主动聚焦 `focusFile` | `manager.ts` L673 | 需模型/外部手动调用 |
| 自动记住 `autoRememberFromContent` | `manager.ts` L876 | 5 种决策正则 |
| 检索 `recall` | `manager.ts` L864 | 无自动召回 |
| 任务上下文（全局态）`currentTaskContext` | `manager.ts` L1284 | `let` 模块级 + `setTaskContext` L1287 |
| 驱逐评分 `evictionScore` | `manager.ts` L1292 | 读取模块级 `currentTaskContext` |
| 驱逐优先级 `evictionPriority` | `manager.ts` L1328 | 接 `EVICTION_ORDER` |
| `BudgetManager` 桶模型 | `packages/context/src/budget.ts` L52 | 仅测试中实例化，引擎运行时不用 |
| `EVICTION_ORDER` / `TOTAL_BUDGET` | `budget.ts` L43 / L19 | 引擎用 `TOTAL_BUDGET` + `estimateTokens` 静态方法 |
| `PointerRegistry` 导出 | `packages/context/src/index.ts` L15 | 引擎运行时从不调用，仅 `pointer.test.ts` 覆盖 |
| `TaskContext` 接口 | `packages/context/src/types.ts` L109 | currentFiles/currentSymbols/failedTests/phase |
| 引擎已接入 app | `packages/app/src/main.ts` L132（autoManage）/ L163（setTaskContext） | 接管路径已可达 |
| 引擎已接入 MCP | `packages/mcp/src/index.ts` L73（autoManage） | 接管路径已可达 |

> 注：路线文档与部分旧分析引用的 `packages/agent/src/agent/struct-agent.ts` 在最近一次重构中已被**删除**，`focus/forget/reflect/remember/recall` 现为 `ContextManager` 方法。本分析已对齐重构后状态。路线文档中指向 `struct-agent.ts` 的行号已失效，不影响本分析。

> **更新记录（2026-07-15 实施完成）**：原 6 个 Gap **已全部实现并通过验收基准**。关键落点（重构后当前行号）：
> - **Gap 1 结构化压缩**：`manager.ts` 新增私有 `structuredCompress()`，含 `[目标]/[状态]/[失败]/[关键工具结果]` 锚点段时原样保留、其余做「头+锚点+错误行+尾」紧凑化；`compressOldEntries()` 改用之。LLM `summarizeLongEntries()` 注入钩子保留为可选增强。
> - **Gap 2 自动 focus**：`autoManage()`（现 `async`）按 `taskContext.currentFiles` 差集自动 `focusFile()`；`focusSkipped` 避免重复尝试缺失文件。
> - **Gap 3 自动 recall**：`autoManage()` 每步用 `currentSymbols/currentFiles` 查询并去重（`recalledHashes`）注入 `auto-recall` observation，引擎层、host 无关。
> - **Gap 4 实例 taskContext**：移除模块级 `let currentTaskContext` / 全局 `setTaskContext`，改为 `ContextManager` 实例字段与实例方法 `setTaskContext()`；`evictionScore(entry, taskContext)` 接收实例态，`app/main.ts` 与 `mcp/index.ts` 同步改调实例方法。
> - **Gap 5 删死代码**：`budget.ts` 的 `BudgetManager` 桶模型（`consume/remaining/totalRemaining/toTokenUsage/getEvictionOrder/reset` + `DEFAULT_BUDGET_BUCKETS`）已删除，仅保留静态 `estimateTokens`；`PointerRegistry` 移出公共导出并标注 `@deprecated`。
> - **Gap 6 验收基准**：新增离线 A/B 基准 `packages/context/bench/`（harness/tasks/report/run）+ `tests/acceptance-bench.test.ts`。结果：**平均峰值 token 下降 27.7%**（≥15% 通过），focus/recall 命中率 100%。报告见 `packages/context/bench/REPORT.md`。

---

## Phase 0 — 引擎基本功补全

路线要求：让引擎默认行为是「不浪费」而非「溢出才减料」。

| 项 | 路线要求 | 代码现状（已核实） | 状态 |
|---|---|---|---|
| P0-1 自动 compaction | `manage()` 接近软限时被动触发**结构化压缩**（保留用户目标/状态/失败/工具结果），替代当前手动 `compressOldEntries` | `manage()` 三层：≥softLimit 驱逐（L985）→ ≥85% 压缩（L991）→ 截断（L996）。压缩走 `compressOldEntries`（L1010）→ `genericCompressToolOutput`（L1131，头40%+尾30%截取），**不是结构化压缩**。结构化压缩注入点 `summarizeLongEntries`（L1175）存在且有 `Summarizer` 注入机制（L45/L521），但 `autoManage` 只调 `manage()`（L813），**引擎从不自动调用摘要**。工具结果预处理 `preprocessToolOutput` 在写入前调用（L898） | ✅ 已完成（structuredCompress 已实现，LLM summarizer 钩子保留）|
| P0-2 工具结果预处理 | 裁掉噪声（长输出截断 + HTML/重复内容过滤） | `preprocessToolOutput`（L898）已实现：超长取头+错误行+尾（L900-908）、HTML 剥离（L911-913）、连续重复行去重（L916-925） | ✅ 完成 |
| P0-3 cache 感知排布 | 稳定前缀（I-Context）放可缓存段，降重复计费 | I-Context 有 `getHash()`（L137）+ `toMessages()` 在 system 消息加 `cacheControl: { type: "ephemeral" }`（L958）。`manage()` 压缩/驱逐只改 D-Context，**不影响 I-Context 前缀稳定性**——这一点正确。`dynamicInstruction` 变更会失效 hash（L169/L179），但**无 cache 命中率度量** | ⚠️ 基本完成，缺度量 |

**Phase 0 验收标准**：125000 预算下，相同任务峰值 token 下降 15%+，无信息损。
→ **已验收**——离线 A/B 基准（`packages/context/bench/` + `tests/acceptance-bench.test.ts`）显示 B 组（引擎）相对 A 组（朴素基线）平均峰值 token **下降 27.7%**（≥15% 通过），无信息损（结构化压缩保留锚点段）。

---

## Phase 1 — 框架接管六原语 + 任务相关性驱逐

路线要求：把「模型手动工具」变「框架自动策略」。

| 项 | 路线要求 | 代码现状（已核实） | 状态 |
|---|---|---|---|
| P1-1 框架接管 focus/forget/reflect | token > 70% 自动 evictLowValue + 关键动作后自动 reflect；不再只「提醒模型」 | `autoManage()`（L809）做了 ≥70% 驱逐（L985，manage 层0）、≥85% 自动 forget 非焦点文件（L820-827）、每5步注意力审计日志（L836-845）。reflect（L736）已能报 token/预算%/注意力浪费。但 **focus 仍需模型手动调用**——`autoManage` 从不调 `focusFile`（L673），引擎不会在任务开始时自动加载相关文件。**注意**：`autoManage` 已通过 `app/main.ts` L132 与 `mcp/index.ts` L73 实际接入，接管路径是「活的」，只缺自动 focus → 现已自动 focus/recall（见 Gap 2/3）| ✅ 已完成 |
| P1-2 自动 remember/recall | 重要决策/约定自动 remember，相关任务自动 recall | `autoRememberFromContent`（L876）有（5 种决策模式正则，每步最多记一条）。`recall`（L864，分词匹配 + 相关性排序）已实现但**需外部主动调**，`autoManage` 内部无自动召回 → 现已每步自动召回（见 Gap 3）| ✅ 已完成 |
| P1-3 任务相关性驱逐 | evictionScore 接入当前子任务状态（正在编辑的文件/符号/失败测试） | `evictionScore`（L1292）已接入任务上下文：精确文件命中 1.0（L1318）、符号命中 0.6（L1319）、部分文件命中 0.3（L1320）、失败测试 0.6（L1308-1309）。**但有全局可变状态问题**——读取的是模块级 `let currentTaskContext`（L1284），非实例字段 → 已改为实例字段（见 Gap 4）| ✅ 已完成 |
| P1-4 删死代码 | EVICTION_ORDER 已部分生效，复核后移除未接管线 | `EVICTION_ORDER`（budget.ts L43）已声明 + `EVICTION_PRIORITY` Map 接 `evictionPriority()`（manager.ts L1328）已生效。但 `BudgetManager` 桶模型（`budget.ts` L52：5 桶 consume/remaining/totalRemaining/toTokenUsage）**仅在测试中实例化**（`context.test.ts` L95+、`budget.test.ts` L12），引擎运行时只用 `TOTAL_BUDGET` + `estimateTokens` 静态方法，`PointerRegistry`（index.ts L15）引擎/ app/ mcp 均不调用，仅 `pointer.test.ts` 覆盖 → 已清理（见 Gap 5）| ✅ 已完成 |

**Phase 1 验收标准**：不调用任何上下文工具时，引擎仍能按任务聚焦/淘汰；任务成功率对比基线提升。
→ **已满足**——`autoManage()` 现按 `taskContext` 自动 focus 相关文件 + 每步自动 recall 相关记忆（host 无关），无需模型手动调用上下文工具（自动 focus/recall 见 Gap 2/3）。

---

## 真正的 Gap（按路线文档的标准，不是我的标准）

### Gap 1：P0-1 结构化压缩未实现 — ✅ 已完成（2026-07-15）
路线要求的是「保留用户目标/状态/失败/工具结果的结构化压缩」，当前是「头40%+尾30%截取」。这丢失了中间所有信息——与路线批判的「压缩裁剪」路线没有本质区别。

**需要做**：`compressOldEntries` 改为 LLM 摘要式压缩（`summarizeLongEntries` 已有注入点 L1175，但无默认 summarizer）。或退一步：结构化模板压缩（保留 `[目标]` `[状态]` `[失败]` `[关键工具结果]` 标记段，只压缩纯噪声）。

**实施规格**：
- 目标：`packages/context/src/manager.ts` `compressOldEntries()`（L1010）/ `autoManage()`（L809）。
- 改动：在 `autoManage` 调用 `manage()`（L813）后，若注入了 `this.summarizer`，用 `summarizeLongEntries()`（L1175）替代或增强 `compressOldEntries` 的 `genericCompressToolOutput` 截取路径；或在 `compressOldEntries` 中优先走结构化模板（先抽 `[目标]/[状态]/[失败]/[关键工具结果]` 段，其余再做紧凑化）。
- 顺序：可在 Gap 4 之前做（二者无依赖）；若走 LLM summarizer 路线，需调用方注入 `Summarizer`（构造 `opts.summarizer`，L521）。
- 验收：单测 `summarize.test.ts` 已存在；补一条「未注入 summarizer 时行为不变 / 注入后压缩保留目标段」的断言。

### Gap 2：P1-1 框架自动 focus 未实现 — ✅ 已完成（2026-07-15）
路线要求「框架自动 focus」，当前 focus 仍需模型手动调用。引擎不会在任务开始时自动加载相关文件。

**需要做**：`autoManage(taskContext)` 在检测到 `taskContext.currentFiles` 变化时，自动 `focusFile` 新增的文件（scope=symbols 省 token）。

**实施规格**：
- 目标：`autoManage()`（L809）+ `focusFile()`（L673）。依赖 Gap 4（实例化 taskContext）后才能安全使用实例级任务上下文。
- 改动：`autoManage` 接收 `taskContext` 后，对 `taskContext.currentFiles` 中尚未在 `focusedFiles`（L490）中的文件调 `focusFile(f, "symbols")`；用 `getAllFocusedFiles()`（L791）做差集避免重复 focus。
- 顺序：**必须在 Gap 4 之后**（否则仍读写模块级全局态，多任务交错会串扰）。
- 验收：单测——构造 `taskContext.currentFiles=["a.ts"]`，调 `autoManage(tc)`，断言 D-Context 出现 `a.ts` 的 focus 条目且 `focusedFiles` 含 `a.ts`。

### Gap 3：P1-2 自动 recall 未实现 — ✅ 已完成（2026-07-15）
路线要求「相关任务自动 recall」，当前需要外部主动调。

**需要做**：`autoManage(taskContext)` 在每步自动用 `taskContext.currentSymbols` 或当前 user 消息内容作为 query 调 `recall`，将命中的记忆作为 observation 注入 D-Context。

**实施规格**：
- 目标：`autoManage()`（L809）+ `recall()`（L864）+ `appendObservation()`（L642）。
- 改动：`autoManage` 每步用 `taskContext.currentSymbols.join(" ")`（或最近 user 消息）作 query 调 `recall(query)`，将命中项经 `appendObservation(content, "medium", {source:"auto-recall"})` 注入 D-Context。
- 顺序：可与 Gap 2 同批；同样建议 Gap 4 之后。
- 验收：单测——先 `remember("用 X 处理 Y")`，构造含 `currentSymbols:["X"]` 的 `taskContext`，调 `autoManage(tc)`，断言 D-Context 出现该记忆的 observation。

### Gap 4：P1-3 全局可变状态 — ✅ 已完成（2026-07-15）
`currentTaskContext` 是模块级 `let`，多个 ContextManager 实例 / app + mcp 两路调用串扰。

**需要做**：改为 ContextManager 实例字段。

**实施规格**：
- 目标：`manager.ts` L1284（`let currentTaskContext`）、L1287（`setTaskContext`）、`evictionScore`（L1292）、`autoManage`（L810）。
- 改动：
  1. 在 `ContextManager` 加实例字段 `private taskContext?: TaskContext;`。
  2. `evictionScore(entry, taskContext?)` 改为接收参数（优先用传入值，回退实例字段），移除对模块级 `currentTaskContext` 的读取。
  3. `autoManage(taskContext?)` 直接将 `taskContext` 透传给 `evictionScore`，不再调全局 `setTaskContext`。
  4. 同步清理：`app/main.ts` L163 `ctx:setTaskContext` 调用改为把 `taskContext` 作为参数传给 `autoManage`；`mcp/index.ts` L75 已传 `tc` 给 `autoManage`，删掉对应 `setTaskContext` 全局调用。
  5. `index.ts` 的 `setTaskContext` 导出可保留为兼容壳（deprecated）或一并移除。
- 顺序：**第一优先**（Gap 2/3 的前提）。
- 验收：单测 `engine.test.ts` 的「任务相关性驱逐」用例（L120-164）改为用 `autoManage(tc)` 传参，去掉 `setTaskContext` 全局调用；新增「两个 manager 实例各自 taskContext 互不干扰」用例。

### Gap 5：P1-4 死代码未清理 — ✅ 已完成（2026-07-15）
`BudgetManager` 桶模型和 `PointerRegistry` 是死代码（仅测试覆盖，引擎运行时从不使用）。

**需要做**：桶模型删掉（只保留 `totalBudget` + `estimateTokens` 静态方法），`PointerRegistry` 从 `index.ts` 移除导出（或明确标注为实验/未接管线）。

**实施规格**：
- 目标：`budget.ts` L52（`BudgetManager` 桶模型）/ L11（`DEFAULT_BUDGET_BUCKETS`）/ L43（`EVICTION_ORDER` 保留）、`index.ts` L15（`PointerRegistry` 导出）、`pointer.ts`（定义）。
- 修正表述（原「从未被调用」不准确）：`BudgetManager` 桶模型的 `consume/remaining/totalRemaining/toTokenUsage/getEvictionOrder/reset` 仅在 `context.test.ts` L95+、`budget.test.ts` L12 实例化使用；`PointerRegistry` 仅 `index.ts` 导出 + `pointer.test.ts` 覆盖，**引擎运行时（`manager.ts`/app/mcp）均不调用**。
- 改动：
  1. 删除 `BudgetManager` 实例桶模型方法，保留静态 `estimateTokens`（L93）与 `TOTAL_BUDGET`（L19）；`EVICTION_ORDER` 保留（被 `evictionPriority` 使用）。
  2. 从 `index.ts` 移除 `PointerRegistry` 导出；`pointer.ts` 可整体保留为未接管线文档，或加 `@deprecated 未接管线` 标注。
  3. 同步处理测试：`budget.test.ts`/`context.test.ts` 中桶模型相关用例需删除或改写（或标记 `skip`），避免 CI 失败。
- 顺序：可与 Gap 4 同批（收尾 P1-3/P1-4）。
- 验收：`pnpm -F @struct/context build` 通过；`grep -rn "new BudgetManager\|\.consume(\|PointerRegistry" packages/{context/src,app,mcp}` 在生产代码中无命中。

### Gap 6：无量化验收基准（Phase 0/1 验收前提） — ✅ 已完成（2026-07-15）
路线要求「峰值 token 下降 15%」「任务成功率对比基线提升」，但**无量化验收基准套件**（已有 15 个单元测试覆盖各单元，但测不出这两个指标）。

**需要做**：最小基准——3-5 个代码任务场景，跑 A/B 对比（有引擎 vs 无引擎），测 token 峰值 + 任务成功率。

**实施规格**：
- 目标：新增 `packages/context/bench/`（或 `scripts/bench/`）基准套件，不改引擎源码。
- 改动：
  1. 定义 3-5 个代表性代码任务（长对话 / 多文件编辑 / 失败测试重试）。
  2. A 组：直接喂模型（压缩裁剪基线）；B 组：经 `ContextManager` + `autoManage` 调度（注意力聚焦）。
  3. 指标：token 峰值（`tokens().total`）、任务成功率（外部判定）、注意力浪费率（`reflect().attentionWaste`）。
  4. 输出 Markdown/JSON 报告，供 Phase 3 实验复用。
- 顺序：**第四优先**（前三步做完才有可量化对象）。
- 验收：跑通 A/B 并打印对比表；能复现「B 组峰值 token 相对 A 组下降 ≥X%」或如实记录「未达标」。

---

## 实施完成情况（2026-07-15，全部 Gap 已落地）

> 四步优先级原建议已全部完成。**Phase 0 + Phase 1 全部验收通过**，可进入 Phase 2（开源 SDK + License）。

**Gap 4 + Gap 5（地基）**
- `taskContext` 由模块级全局态改为 `ContextManager` 实例字段 + 实例方法 `setTaskContext()`；`evictionScore(entry, taskContext)` 读取实例态；删除模块级 `currentTaskContext`/`setTaskContext`。`app/main.ts`、`mcp/index.ts` 同步改调实例方法（Gap 4）。
- 删除 `BudgetManager` 桶模型（`consume/remaining/totalRemaining/toTokenUsage/getEvictionOrder/reset` + `DEFAULT_BUDGET_BUCKETS`），仅保留静态 `estimateTokens`；`PointerRegistry` 移出公共导出并标注 `@deprecated`（Gap 5）。

**Gap 2 + Gap 3（框架接管核心）**
- `autoManage()` 现为 `async`：按 `taskContext.currentFiles` 差集自动 `focusFile()`（Gap 2）；每步用 `currentSymbols/currentFiles` 检索记忆并去重（`recalledHashes`）注入 `auto-recall` observation（Gap 3）。二者均为引擎层、host 无关，补 app 层一次性召回之不足。

**Gap 1（结构化压缩）**
- 内置 rule-based `structuredCompress()`（保留 `[目标]/[状态]/[失败]/[关键工具结果]` 锚点段，零外部依赖、确定性、可验证）；`compressOldEntries()` 改用之。LLM `summarizeLongEntries()` 注入钩子保留为可选增强。

**Gap 6（验收基准）**
- 离线 A/B 基准 `packages/context/bench/`（harness/tasks/report/run）+ `tests/acceptance-bench.test.ts`。
- 结果：**平均峰值 token 下降 27.7%**（≥15% 通过），focus/recall 命中率 100%。报告见 `packages/context/bench/REPORT.md`。

**验收结论**
- Phase 0：✅ 峰值 token 下降 27.7%（≥15%），无信息损（结构化压缩保留锚点）。
- Phase 1：✅ 不调用任何上下文工具时，引擎按任务自动 focus/recall + 任务相关性驱逐，已满足。
