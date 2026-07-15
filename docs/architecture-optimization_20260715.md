# StructAgent 架构优化分析（v5.1）

> 日期：2026-07-15 ｜ 焦点：架构层面还有什么能优化的
> 前序：v5 评估报告（srcuctagent-v5-review_20260715.md，7.8/10）

---

## 0. 当前状态确认

v5 → v5.1 的进步（自上次评估以来）：
- ✅ P0#1 autoManage budgetPct 快照 bug 已修（manage 后重新读取 reflect）
- ✅ P0#2 recall 重写（tokenizeQuery 分词 + 逐词命中排序 + 中文 2-gram）
- ✅ P0#3 目录名/乱码 — package.json description 仍乱码（GBK），但 name 已改为 `struct-context-middleware`
- ✅ M3 验证层（Verifier：tsc + lint，verifyAndReport 写入 observation）
- ✅ M5 阶段标准（phases.ts：buildChecklist / canAdvance / nextPhase）
- ✅ M6 ask_user（ask-user.ts：结构化提问写入上下文）
- ✅ MCP Server（packages/mcp：零依赖 JSON-RPC over stdio，12 个工具）
- ✅ SqliteFtsBackend（FTS5 全文检索 + 持久化，可选模块）
- ✅ 测试 56→80（+24 新测试，15 文件）
- ✅ CI/CD（ci.yml + eval.yml）
- ✅ 文档归入 docs/

**当前评分：8.3/10**（比 v5 的 7.8 提升 0.5，主要来自 M3/M5/M6 落地 + recall 修复 + MCP 接入）

---

## 1. 架构层面的优化机会

以下按「影响 × 可行性」排序，从最值得做的开始。

### 1.1 🔴 DataContext 的 O(N) 重建问题（性能架构缺陷）

**问题**：`getEntriesAt(hash)` 每次调用都从根 commit 沿父链遍历，逐 commit apply diff，重建整个 entries Map。这个方法在以下路径被调用：
- `toMessages()` → 序列化给 LLM
- `tokens()` → 计算 token 占用
- `getEntries()` → 驱逐/压缩扫描
- `reflect()` → 条目计数 + 注意力浪费
- `evictLowValue()` / `compressOldEntries()` / `truncateLongEntries()`

在一次 `manage()` 调用中，`getEntriesAt` 至少被调用 5-7 次。每次都是 O(commits × entries)。在长会话中（100+ commits，50+ entries），这意味着单次 manage() 要遍历 5000+ entry-diff 操作。

**影响**：长会话性能退化。100 步的会话中，每次 LLM 调用前的 manage() 可能从毫秒级升到百毫秒级。

**建议**：引入 **entry cache / snapshot**：
```typescript
// DataContext 内部维护一个 cache
private entryCache: Map<string | null, Map<string, ContextEntry>> = new Map();
private cacheValid: Set<string> = new Set();

// commit 时失效受影响的 cache
commit(...): string {
  // ... 现有逻辑
  this.cacheValid.clear(); // 朴素失效
  return hash;
}

getEntriesAt(hash): Map<string, ContextEntry> {
  if (this.cacheValid.has(hash)) return this.entryCache.get(hash)!;
  // ... 重建逻辑
  this.cacheValid.add(hash);
  this.entryCache.set(hash, result);
  return result;
}
```

更优方案：维护一个 **HEAD snapshot**（当前分支的完整 entries），每次 commit 时增量更新（diff apply），而非全量重建。commit 是追加式的，只需 apply 新 diff 到现有 snapshot。

### 1.2 🔴 全局可变状态 `currentTaskContext`（架构异味）

**问题**：`manager.ts` 用模块级 `let currentTaskContext: TaskContext | null` 存储任务上下文，`setTaskContext()` 修改全局变量，`evictionScore()` 读取它。

这导致：
- **非线程安全**：多个 ContextManager 实例共享同一个 taskContext
- **fork 的子上下文继承父的 taskContext**，但语义上子任务可能有不同的关注点
- **测试隔离差**：`afterEach(() => setTaskContext(null))` 必须手动清理，否则泄漏到下一个测试
- **MCP 多会话冲突**：如果 MCP Server 同时服务多个会话，taskContext 串扰

**建议**：把 `taskContext` 作为 ContextManager 的实例字段：
```typescript
class ContextManager {
  private taskContext: TaskContext | null = null;
  
  setTaskContext(ctx: TaskContext | null): void {
    this.taskContext = ctx;
  }
  
  // evictionScore 改为实例方法或传入 taskContext 参数
}
```

`autoManage(taskContext?)` 已经接受参数，只需让它写入 `this.taskContext` 而非全局变量。`setTaskContext` 导出函数改为废弃或代理到实例方法。

### 1.3 🟡 D-Context 的不可变条目假设与实际修改操作的矛盾

**问题**：D-Context 基于 Git 模型——每次 commit 是一个 diff（added/modified/removed）。但 `compressOldEntries` 和 `truncateLongEntries` 做的是 **原地修改已有条目**（modified diff），这违反了 Git 的不可变历史假设：

- 条目 `E1` 在 commit C1 中被 added
- manage() 在 commit C2 中把 E1 modified 为 E1'
- 此时 C1 的 diff 仍然引用原始 E1

这本身不致命（getEntriesAt 按 chain 重放 diff，modified 会覆盖），但导致：
- **`revert(C1)` 不可靠**：revert C1 会尝试 remove E1，但当前 HEAD 中已经是 E1'（通过 C2 的 modified 覆盖）。revert 的 diff.removed 里是原始 E1，但 getEntriesAt(C2.parent) 已经有 E1' 而非 E1
- **`diffBetween` 不精确**：比较两个 hash 时，如果中间有 modified 操作，diff 会显示 modified，但原始条目已被覆盖
- **审计日志不真实**：log() 显示的 diff 是 C1 added E1, C2 modified E1→E1'，但实际上 E1 在 C1 时是完整的，在 C2 时被压缩了——这个语义信息丢失了

**影响**：中等。当前测试没覆盖 revert-after-compress 场景，但实际使用中这会出问题。

**建议**：
- **方案 A（轻量）**：在 commit message 中记录压缩操作的元信息（`manage: compress E1 (600→200 tokens)`），不改 diff 结构。保证可审计性。
- **方案 B（正确）**：压缩/截断不产生 modified diff，而是 added 一条新条目 + removed 旧条目。这样 diff 语义正确，但增加了条目数量。
- **方案 C（最优但复杂）**：引入「快照 commit」概念——压缩操作创建一个特殊 commit，其 diff 是对当前 HEAD 的全量快照，而非增量 diff。squash 时优先保留快照 commit。

### 1.4 🟡 预算桶模型与实际使用脱节

**问题**：`BudgetManager` 定义了 5 个桶（fixed/session/retrieval/tools/dynamic），但 `ContextManager` 从不调用 `budget.consume()` 或 `budget.remaining()`。预算管理实际走的是 `this.tokens().total` vs `this.totalBudget` 的总量比较。

桶模型是死的——它存在但不起作用。

**影响**：
- 无法按桶做细粒度驱逐（如「retrieval 桶超限只驱逐检索结果，不动 session」）
- `toTokenUsage()` 返回的 slices 全是 0（没人调 consume）
- 给用户/开发者造成误解：「有桶管理」实际没有

**建议**：
- **方案 A（诚实地删掉）**：移除 BudgetManager 的桶模型，只保留 `totalBudget` + `estimateTokens` + `setTokenEstimator`。简化代码。
- **方案 B（接起来）**：在 `appendToolResult`/`appendFocusEntry`/`appendObservation`/`appendUser` 等方法中调 `budget.consume(bucket, tokens)`，在 `evictLowValue` 中按桶驱逐。
- **推荐 A**：当前定位是「上下文中间件」，中间件不应替上层决定桶分配策略。把桶模型留给上层，中间件只管总量。

### 1.5 🟡 fork/merge 的并发安全与分支隔离不完整

**问题**：`fork()` 创建子 ContextManager，共享同一个 DataContext 实例但绑定不同分支。但：
- `fork()` 创建的子上下文没有继承父的 `summarizer`、`memory`、`logger`、`maxToolOutputTokens` 等配置
- `fork()` 后父子可以并行 `commit`，但 `commit` 内部没有锁/队列——如果真的异步并发调用，commits 数组可能交错损坏（JS 单线程下不太会，但如果有 await 间隙则可能）
- `merge()` 策略简陋（union 只做 Set 合并，不处理 modified 冲突）

**影响**：当前低（大部分使用场景是串行的），但作为「中间件」被多 Agent 并发使用时会暴雷。

**建议**：
- fork 时继承父的所有配置项
- fork 返回的 ContextManager 标记为 `sealed = false` 但绑定 `parentManager` 引用，merge 时通过父引用而非全局 data 实例
- merge 的 conflict 检测：如果两边都 modified 了同一个 entry，报冲突而非静默 union

### 1.6 🟡 MCP Server 缺少会话管理

**问题**：当前 MCP Server 是单例——`let manager = new ContextManager(...)`，所有 `tools/call` 请求共享同一个 ContextManager。如果一个 MCP 客户端需要多会话（如同时跑两个 Agent 任务），无法隔离。

**建议**：
- 增加 `session/create` 和 `session/close` 工具，返回 session ID
- manager 改为 `Map<string, ContextManager>`
- 所有工具调用带 `sessionId` 参数（或通过 MCP 的 session 机制）
- 至少加一个 `sessions/list` 工具用于调试

### 1.7 🟢 toMessages() 缺少 LLM 适配层

**问题**：`toMessages()` 返回 `LLMMessage[]`，但不同 LLM provider 的消息格式有差异：
- OpenAI: `tool_calls` 在 assistant 消息里，`tool_call_id` 在 tool 消息里
- Anthropic: `tool_use` / `tool_result` content blocks
- 某些 provider 不支持 `cache_control` 字段

当前 `LLMMessage` 是 OpenAI 格式偏好的。如果作为「模型无关」的中间件，应有适配层。

**建议**：增加 `toMessages(format: "openai" | "anthropic" | "raw")` 参数，或引入 `MessageFormatter` 接口。当前可以不做，但在 CONTEXT_API_DESIGN.md 中标注。

### 1.8 🟢 缺少上下文序列化/恢复（持久化）

**问题**：ContextManager 的状态（I-Context entries + D-Context commits + focusedFiles + memory）全在内存中。进程重启全部丢失。

作为「中间件」，应支持：
- `serialize()` → JSON（保存到文件/DB）
- `deserialize(json)` → 恢复 ContextManager

当前只有 `memory` 有持久化路径（SqliteFtsBackend），其他状态无。

**建议**：
```typescript
interface ContextSnapshot {
  version: string;
  instructions: { entries: ContextEntry[] };
  data: { commits: ContextCommit[]; branches: [string, string | null][]; currentBranch: string };
  focusedFiles: string[];
  // memory 由 MemoryBackend 自己管持久化
}

serialize(): ContextSnapshot { ... }
static deserialize(snapshot: ContextSnapshot): ContextManager { ... }
```

这对于 `--resume` 场景、MCP 多会话恢复、调试/审计都关键。

### 1.9 🟢 Verifier 的进程隔离与结果有界性

**问题**：`Verifier.runTsc()` / `runLint()` 用 `execFileAsync` 直接在主进程中执行。问题：
- 没有 sandbox——tsc/eslint 可以读写任意文件
- `details` 截断为前 20 行，但 `stdout`/`stderr` 可能极大（大项目的 tsc 输出可达 MB 级），`execFileAsync` 会全部 buffer 到内存
- 超时默认未设（`timeoutMs` undefined → Node.js 默认无超时）

**建议**：
- 默认 `timeoutMs = 30000`
- `maxBuffer` 限制为 1MB
- details 截断前先限制总输出长度：`extractOutput(err).slice(0, 100000)`
- 文档中标注「Verifier 应在容器/sandbox 中运行，不应直接在宿主机上对不可信代码使用」

### 1.10 🟢 指针系统（PointerRegistry）未接入主循环

**问题**：`PointerRegistry` 实现完整（register/expand/compress/deduplicate/findByFile），但 `ContextManager` 没有 `PointerRegistry` 实例，也没有任何代码调用它。它是死的。

与 v4 评估时「EVICTION_ORDER 声明未接线」类似的死代码问题。

**建议**：
- **方案 A**：如果短期不打算接入，直接从 `index.ts` 导出中移除，避免给用户「有指针系统」的错误印象
- **方案 B**：接入——在 `appendToolResult` 时自动 `register` 指针，在 `focusFile` 时 `expand` 相关指针，在 `manage()` 的压缩层 `compress` 已展开指针
- **推荐 A**，等真正需要时再接

---

## 2. 设计层面的思考

### 2.1 「上下文中间件」的边界——哪些该做哪些不该做

当前 context 包做了：
- 上下文存储 + 版本化 ✅ 该做
- 注意力管理（驱逐/压缩/截断）✅ 该做
- 记忆存储 + 检索 ✅ 该做（但应定位为「内置记忆后端」，允许上层替换）
- 验证层（tsc/lint）⚠️ 边界模糊——验证是 Agent 行为，不是上下文管理
- 阶段管理（ExitChecklist）⚠️ 边界模糊——阶段推进是 Agent 决策，不是上下文管理
- ask_user ⚠️ 边界模糊——用户交互是 Agent 行为

**建议**：明确分层——
- **核心层（context 包）**：上下文存储 + 版本化 + 注意力管理 + 预算 + 记忆后端接口
- **扩展层（context 包的可选模块）**：Verifier、Phases、askUser——标记为 optional，不 index 导出
- **应用层（app/mcp 包）**：Agent 行为编排，调用核心层 + 扩展层

这样中间件的「核心」足够小而稳定，扩展能力又够。

### 2.2 DESIGN_CRITIQUE.md 的批判仍未被完全吸收

DESIGN_CRITIQUE.md §1.2 指出「D-Context 的 Git 版本化是过度工程」。从当前代码看，确实如此：
- `branch` / `merge` / `checkout` / `revert` / `squash` 全部实现，但 **没有任何测试覆盖 fork→merge 场景**
- 实际使用中，`fork()` 在 `manager.ts` 中被调用了一次（`fork()` 方法），但 `packages/app/src/main.ts` 和 `packages/mcp/src/index.ts` 都没有调用它
- `merge()` 的 `theirs` / `ours` 策略从未被测试

**建议**：要么投入写 fork/merge 的集成测试证明它真的有用，要么诚实地把 branch/merge 标记为 experimental。作为一个声称「可审计」的中间件，声称的能力必须有用例支撑。

### 2.3 缺少「上下文预算」与「模型窗口」的绑定机制

`totalBudget` 默认 125K，但实际模型窗口可能远小于此（GPT-4o 128K、Claude 3.5 200K、GLM-4 128K、DeepSeek 64K）。context 包不知道目标模型的窗口大小。

当前 `setTotalBudget(tokens)` 是手动设置。作为中间件，应能：
- 从 LLM API 响应中解析 `max_tokens` / `context_window`，自动调整预算
- 或在 `autoManage` 时检查 `tokens().total > modelWindow * 0.9` 并告警

**建议**：增加 `setModelWindow(model: string)` 方法，内置常见模型的窗口大小表。或更简单：`autoManage` 接受 `modelWindowTokens` 参数。

---

## 3. 优先级排序

| 优先级 | 项目 | 影响 | 工作量 |
|---|---|---|---|
| P0 | 1.2 全局 taskContext → 实例字段 | 高（并发安全、测试隔离） | 小 |
| P0 | 1.4 预算桶模型：接起来或删掉 | 中（死代码误导） | 小（删）或中（接） |
| P1 | 1.1 getEntriesAt 缓存/snapshot | 高（长会话性能） | 中 |
| P1 | 1.8 序列化/恢复 | 高（resume 场景必需） | 中 |
| P1 | 1.10 PointerRegistry：接入或移除 | 低（死代码清理） | 小 |
| P2 | 1.3 D-Context modified diff 语义 | 中（revert 正确性） | 中 |
| P2 | 1.6 MCP 多会话 | 中（多任务隔离） | 中 |
| P2 | 1.9 Verifier 安全加固 | 中（安全） | 小 |
| P2 | 2.3 模型窗口绑定 | 中（防超限） | 小 |
| P3 | 1.5 fork/merge 完善 | 低（使用场景少） | 中 |
| P3 | 1.7 LLM 适配层 | 低（当前单格式够用） | 中 |
| P3 | 2.1 分层清晰化 | 低（架构整洁） | 小 |
| P3 | 2.2 Git 版本化的价值验证 | 低（但关乎设计可信度） | 中 |

---

## 4. 总结

当前架构的核心骨架（哈佛 I/D 分离 + 主动注意力管理 + 版本化 + MCP 接入）设计扎实，v5.1 的进步把 v5 报告中的 P0 缺口基本补齐了。接下来最值得做的架构优化是：

1. **消灭全局可变状态**（taskContext → 实例字段）—— 这是最小代价、最高回报的改动
2. **解决长会话性能隐患**（getEntriesAt 缓存）—— 100+ 步会话的性能退化是可预见的
3. **补上序列化/恢复**—— 作为中间件，不能进程重启就全丢
4. **诚实处理死代码**（桶模型、PointerRegistry）—— 要么接起来，要么删掉，不要留着误导用户

这四项做完，架构可信度从「demo 级」升到「可交付中间件级」，评分可到 **8.8-9.0**。
