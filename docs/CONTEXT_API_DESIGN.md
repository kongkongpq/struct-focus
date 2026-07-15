# StructAgent Context Middleware：标准 Context API 设计

> 版本：v0.2.0-draft ｜ 日期：2026-07-15
> 配套：CONTEXT_MIDDLEWARE_STRATEGY.md（战略）、PDR_CONTEXT_ENGINE.md（引擎改造项）
> 目标：定义一套**模型无关、框架无关**的上下文管理接口。它有两副面孔——
> **甲·内核契约**（给自研/开源框架直接调用）；**乙·边缘接入**（闭源 Agent 不会 import 我们的包，只能从它与模型之间的流量边界插入）。

---

## 0. 设计原则

| 原则 | 含义 |
|---|---|
| **模型无关** | 只消费模型的**输入输出**（messages / tool_results），不依赖任何 LLM 内部机制。闭源模型直接可用。 |
| **框架无关** | 是「上下文层」契约，不假设上层是单 Agent、多 Agent 还是 DAG 编排。 |
| **最小契约** | 只暴露「写 / 聚焦 / 淘汰 / 审计」四件事，不替框架做决策。 |
| **向后对齐** | 接口直接映射现有 `ContextManager` / `BudgetManager` / `IMemoryProvider` 的真实方法（见 §4），不另起炉灶。 |
| **可审计** | 每次管理动作产出 `ContextManagementReport`；`reflect()` 暴露注意力浪费率。 |

---

## 1. 核心抽象

```
┌──────────────────────────────────────────────┐
│  Agent 框架                                    │
│   · 自研 / 开源（LangChain / LlamaIndex）      │ ── 甲：直接调用 ContextSession
│   · 闭源（Claude Code / Cursor / Codex）       │ ── 乙：流量边界插入（Proxy/MCP/Hooks）
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│  ContextSession（一次 Agent 运行 = 一个会话）  │
│   · ContextStore     窗口读写与淘汰            │
│   · AttentionEngine  focus/forget/manage       │
│   · MemoryStore      remember/recall           │
│   · BudgetPolicy     预算与驱逐策略            │
└───────────────┬──────────────────────────────┘
                │ 消费 I/O（模型边界外）
┌───────────────▼──────────────────────────────┐
│  闭源 LLM API（OpenAI / Claude / GLM …）        │
└──────────────────────────────────────────────┘
```

- **`ContextSession`**：一次 Agent 任务的上下文生命周期（open → 多次读写 → close）。等价于「一个 `ContextManager` 实例 + 一个 Git 分支」。
- **`ContextEntry`**：窗口里的最小单元（一条 message / 一个 focus 的文件 / 一个 tool 结果 / 一条 memory）。对齐 `manager.ts` L46。
- **`ContextWindow`**：当前准备发给 LLM 的 token 序列，由 `toMessages(): LLMMessage[]`（`manager.ts` L334/L978）产出。

---

## 2. 标准 API 接口（内核契约 / 甲）

> 以下为对外契约（`@structagent/context` 导出的 `ContextSession` 类）。所有方法**不抛非预期异常**——写类方法以 `Result` 形态返回，便于框架适配。

```typescript
// ─── 基础类型（对齐现有 types.ts） ───
export type Importance = "high" | "medium" | "low";

export type EntryType =
  | "message" | "file" | "tool_output"
  | "memory"  | "pointer" | "instruction" | "observation";

export interface ContextEntry {
  id: string;
  type: EntryType;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: readonly unknown[];
  metadata: {
    tokens: number;
    importance: Importance;
    toolCallId?: string;
    file?: string;        // focus 的文件路径
    createdAt: number;
    lastAccessed: number;
    accessCount: number;
    compressed?: boolean; // 已被摘要压缩
    summarized?: boolean; // 已被 LLM 摘要
  };
}

// 当前子任务状态（驱动任务相关性驱逐，P1-3）
export interface TaskContext {
  currentFiles: string[];
  currentSymbols: string[];
  failedTests: string[];
  phase: string;
}

// 注意力浪费度量（Sentry for Context 的数据源）
export interface AttentionWaste {
  unusedTokens: number;       // 窗口内从未被引用的 token 数
  unusedRatio: number;        // 0~1
  topWaster: string | null;   // 占窗最多且未引用的条目标签
}

export interface ContextManagementReport {
  compressed: number;
  evicted: number;
  truncated: number;
  tokensBefore: number;
  tokensAfter: number;
}

// ─── 标准 Context API ───
export interface ContextSession {
  // ── 生命周期 ──
  open(sessionId: string, opts: SessionOptions): Promise<void>;
  close(): Promise<ContextManagementReport>;

  // ── 写入（D-Context） ──
  /** 追加一条 message（自动估算 token、记 accessCount）；映射 ContextManager.commit */
  append(entry: AppendInput): Promise<ContextEntry>;
  /** Git 风格 commit，带 message + author（映射 manager.ts L200 commit(message, author?)） */
  commit(message: string, author?: "agent" | "user" | "system"): Promise<string>;

  // ── 注意力原语（六原语对外面） ──
  /** focus：加载文件/目录/符号进窗口；scope 控制粒度（映射 focusFile L697） */
  focus(scope: FocusScope): Promise<{ ok: boolean; focused: string[] }>;
  /** forget：主动卸载指定文件（非二值化，可重新 focus 恢复；映射 forgetFile L745） */
  forget(target: string): Promise<number>;

  // ── 记忆（持久层） ──
  remember(content: string, importance?: Importance): Promise<string>;
  recall(query: string, limit?: number): Promise<readonly RetrievedMemory[]>;

  // ── 读取（给 LLM 的窗口；映射 toMessages L334/L978） ──
  getWindow(): Promise<ContextWindow>;

  // ── 框架接管（关键：注意力由引擎驱动，不靠模型自觉） ──
  setTask(task: TaskContext): void;
  /** 引擎主动按预算阈值管理；currentTask 驱动任务相关性驱逐（映射 autoManage L833 / manage L1008） */
  manage(): ContextManagementReport;

  // ── 审计 ──
  reflect(): {
    instruction: number; data: number; total: number;
    budgetPct: number; entries: number; focusedFiles: string[];
    attentionWaste: AttentionWaste;
  };
  /** 显式审计：返回可被 Sentry-for-Context 消费的浪费快照 */
  audit(): AttentionWaste;
}

export interface AppendInput {
  type: EntryType;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: readonly unknown[];
  importance?: Importance;
  file?: string;
}

export interface FocusScope {
  path: string;
  scope: "full" | "symbols" | "summary"; // 对齐 focusFile 的三档粒度
}

export interface RetrievedMemory {
  id: string;
  content: string;
  importance: Importance;
  score: number;
}

export interface ContextWindow {
  messages: LLMMessage[];
  totalTokens: number;
  budgetTokens: number;
  /** I-Context 稳定前缀的 cache_control 断点（保 prompt caching 命中） */
  cacheBreakpointAt?: number;
}

export interface SessionOptions {
  budgetTokens?: number;          // 默认 TOTAL_BUDGET 125000（budget.ts L19）
  autoManageThreshold?: number;   // 默认 0.70；≥阈值时 manage() 触发
  enableCacheControl?: boolean;   // 默认 true；I-Context 打 ephemeral 断点
  memoryProvider?: IMemoryProvider;
  gitVersioning?: boolean;        // D-Context 是否 Git 版本化（默认 true）
}
```

---

## 3. 数据流（内核路径）

```
Agent 框架
   │  session.append({role, content})  ──► ContextManager.commit()
   │  session.setTask({currentFiles...}) ──► 存 currentTask
   ▼
session.manage()
   ├─ 预算 ≥ autoManageThreshold → autoManage(currentTask)  ── 任务相关性驱逐
   └─ 超硬限 → evictLowValue（evictionScore：人工重要+访问频率+时间衰减+体积）
   ▼
session.getWindow()  ──► toMessages()  ──► LLMMessage[]  ──► 发给模型
   ▲ I-Context（system）带 cacheControl:{type:"ephemeral"}（manager.ts L987）
```

---

## 4. 与现有引擎的精确映射（防跑偏）

| 标准 API | 现有实现 | 位置 |
|---|---|---|
| `session.append` / `commit` | `ContextManager.commit(message, author?)` | manager.ts L200 |
| `session.focus` | `ContextManager.focusFile(path, scope="symbols")` | manager.ts L697 |
| `session.forget` | `ContextManager.forgetFile(target)` | manager.ts L745 |
| `session.remember` / `recall` | `this.memory` 模块（record / searchHybrid） | struct-agent.ts L1047-1062 |
| `session.getWindow` | `ContextManager.toMessages(): LLMMessage[]` | manager.ts L334 / L978 |
| `session.setTask` + `manage` | `ContextManager.autoManage(taskContext?)` / `manage()` | manager.ts L833 / L1008 |
| `session.reflect` | `ContextManager.reflect()` | manager.ts L760 |
| 预算桶 | `BudgetManager.DEFAULT_BUDGET_BUCKETS` | budget.ts L11 |
| cache 断点 | `CacheControlBreakpoint = {type:"ephemeral"}` | types.ts L42；manager.ts L987 |

> 注：`remember`/`recall` 在 `context/src` 无定义，但 `struct-agent.ts` 已将其路由到 `this.memory`（六原语**全部已实现为工具**）。标准 API 的 `remember/recall` 应直接复用该 memory 模块，而非新建。

---

## 5. 接入总览：为什么需要两副面孔

闭源 Agent（Claude Code、Cursor、Codex、Devin）**不会 import 我们的包去调 `session.focus()`**——它内部的上下文拼接、压缩、淘汰全在自己代码里。它只会做一件事：**把拼好的窗口发给模型 API**。

因此我们站在「Agent 与模型之间」的流量边界，用三种边缘适配器插入：

| 适配器 | 主动权 | 能改窗口？ | 通用性 | 用途 |
|---|---|---|---|---|
| **Proxy**（§7.1） | 在我们 | ✅ 重排整窗 | 所有闭源 Agent 通用 | 真正的上下文管理层 |
| **MCP Server**（§7.2） | 在闭源 Agent | ⚠️ 只能供给聚焦内容 | 依赖其接 MCP | 让其主动问我们"该 focus 哪" |
| **Hooks 旁路**（§7.3） | 在闭源 Agent | ❌ 改不了窗口 | 依赖其支持 Hooks | 仅做浪费度量审计 |

> 关键判断：**Proxy 是价值最高但最难的；Hooks 是零侵入但只能审计；MCP 居中。** 三者可叠加：Proxy 做主管理，Hooks 做旁路验证。

---

## 6. 开源 / 自研框架适配器（甲）

自研 Agent 或开源框架（LangChain / LlamaIndex / OpenSquilla）直接持有 `ContextSession` 实例：

```typescript
// LangChain 适配器示例：用 StructAgent 的窗口替代原生 memory
const ctx = new ContextSession();
await ctx.open("run-123", { budgetTokens: 125000 });

// 模型每轮前
const window = await ctx.getWindow();
const llmReply = await model.invoke(window.messages);

// 把模型输出与工具结果写回
await ctx.append({ type: "message", role: "assistant", content: llmReply });
await ctx.append({ type: "tool_output", role: "tool", content: toolResult, file });
await ctx.setTask({ currentFiles: [editing], currentSymbols: [fn], failedTests });
await ctx.manage(); // 引擎驱动注意力，不靠模型自觉
```

适配器只需做「框架的消息 ↔ `ContextEntry`」的双向转换，管理层完全交给引擎。

---

## 7. 闭源 Agent 边缘接入（乙）—— 核心章节

### 7.1 Proxy 适配器（最有效，零侵入）

**原理**：闭源 Agent 把窗口（system + messages + tool_results）发给模型 API（Anthropic `/v1/messages` 或 OpenAI `/v1/chat/completions`）。我们做一层本地代理，把 Agent 的 API base URL 指向我们（如 `http://localhost:8787/v1`），流程：

```
Claude Code ──► 我们的 Proxy(:8787) ──► 真实 Anthropic API
   │                     │                        │
   │  拦截请求体         │ ① 反解 messages         │
   │                     │ ② 逐条 commit 进 session │
   │                     │ ③ session.manage()       │
   │                     │ ④ getWindow() 重排窗口    │
   │                     │ ⑤ 转发重排后请求          │
   │                     │                         │ ⑥ 响应回来
   │                     │ ⑦ 记 observation 进 session（喂 evictionScore）
   │◄── 原样返回响应 ─────│                         │
```

**为什么通用**：Anthropic Messages 与 OpenAI Chat Completions 的请求/响应格式**都是公开的**。我们只需按格式反解，不依赖任何闭源 Agent 内部实现。Claude Code / Cursor / Codex 全吃同一套。

**能做什么**：在步骤 ④ 对整窗做「注意力聚焦 + 价值淘汰 + 重排」——这是唯一能**真正改变模型看到的窗口**的入口。闭源 Agent 完全无感，我们就成了它脚下的上下文层。

### 7.2 MCP Server 适配器（让其主动问我们）

**原理**：闭源 Agent 都支持 MCP。我们把 `focus` / `recall` 暴露成 MCP 工具：

```typescript
// mcp server 暴露给 Claude Code 的两个工具
server.tool("struct_focus", {
  description: "给定当前任务，返回应聚焦的文件/符号内容（已由 StructAgent 排序）",
  input: { task: "string", files: "string[]" }
}, async ({ task, files }) => {
  const session = registry.get(currentSession);
  session.setTask({ currentFiles: files, ... });
  const { focused } = await session.focus({ path: files[0], scope: "symbols" });
  return { content: focused.map(renderFocused) };
});
```

**边界**：MCP 只能「供给聚焦内容」，改不了 Agent 发给模型的整窗。适合做「读取增强」——它要读文件前先问我们"该聚焦哪"，我们返回聚焦后的内容。若它不调，我们就没介入。故 MCP 是 Proxy 的补充，不是替代。

### 7.3 Hooks 旁路审计（零侵入，仅度量）

**原理**：Claude Code 的 PreToolUse / PostToolUse 钩子允许我们在工具调用前后运行脚本。

```bash
# settings.json
{ "hooks": {
  "PostToolUse": [{
    "matcher": ".*",
    "command": "struct-audit --event '$TOOL_NAME' --input '$TOOL_INPUT'"
  }]
}}
```

`struct-audit` 把每次工具调用的 I/O 写进 session 做**旁路观察**，只产出 `AttentionWaste` 快照（Sentry for Context 的数据源），**绝不改窗口**。

**用途**：当无法部署 Proxy 时（企业安全策略禁止流量代理），Hooks 是降级方案——至少让团队看见「它的上下文浪费在哪」，为后续收敛到 Proxy 提供证据。

### 7.4 cache 冲突处理（Proxy 的生死线）

**问题**：闭源 Agent 普遍用 prompt caching 降本——它在「稳定前缀」（通常是 system prompt + 工具定义）上打 `cache_control` 断点，前缀不变则缓存命中、不计费或低价。我们的 Proxy 若**重排整窗**，会打掉前缀的字节一致性 → **缓存全 miss → 反而更贵**。这直接抵消「省 token」的收益。

**缓解策略**（对齐引擎已有的 `CacheControlBreakpoint`）：

1. **只动 D-Context，绝不碰 I-Context 前缀**：引擎的 I-Context（system + 工具定义）已带 `cacheControl:{type:"ephemeral"}`（manager.ts L987）。Proxy 必须把 I-Context 块**逐字节原样透传**，只对 D-Context（messages / tool_results）做聚焦与淘汰。这样缓存命中不受影响。
2. **D-Context 重排保稳定结构**：对被聚焦的文件内容、近期 tool 结果保持相对顺序稳定（避免每轮乱序导致 Anthropic 对「前缀变化」的二次惩罚）。
3. **分层 cache 策略**：I-Context 用 `ephemeral` 长缓存；D-Context 的热点条目（频繁 access 的核心文件）也可打次级 `cache_control`，减少重复计费。
4. **成本护栏**：Proxy 内置「重排省下的 token」vs「cache miss 多付的 token」实时对账。若某轮重排导致缓存失效率高估的收益，则回退为「仅淘汰不重排」（只减不挪），保住缓存。

> 结论：Proxy 的黄金规则 = **I-Context 字节级透传，D-Context 可重排**。违背即自伤。

---

## 8. 接入选择决策树

```
闭源 Agent（Claude Code / Cursor / ...）
   │
   ├─ 能改 API base URL（允许本地代理）？
   │     ├─ 是 ──► 首选 Proxy（§7.1）+ 叠加 Hooks 旁路（§7.3）做双保险
   │     └─ 否 ──► 能用 Hooks？ ──► 是 ──► 仅旁路审计（§7.3），卖 Sentry-for-Context
   │                       └─ 否 ──► 能用 MCP？ ──► 是 ──► MCP 增强（§7.2）
   │
自研 / 开源框架（LangChain / LlamaIndex / 自研）
   └─ 直接持 ContextSession（§2/§6），框架改造成本最低、收益最高
```

---

## 9. 风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| **Proxy 破坏 cache** | 重排打掉稳定前缀 → 更贵 | §7.4 的 I-Context 透传规则 + 成本护栏 |
| **格式漂移** | Anthropic/OpenAI 改请求格式 | Proxy 做「格式适配层」隔离，格式变更只改适配器 |
| **闭源 Agent 不调 MCP** | 主动供给失效 | 不依赖 MCP 作主路径，仅 Proxy + Hooks |
| **延迟引入** | Proxy 每轮多一跳 + manage() 计算 | manage() 增量执行；Proxy 本地回环延迟 < 5ms |
| **企业禁用代理** | 安全策略不允许流量重定向 | 降级到 Hooks 旁路审计（仅度量，不改流量） |

---

## 10. 与战略的呼应

- 标准 API 的**两副面孔**正是 CONTEXT_MIDDLEWARE_STRATEGY.md 里「做层不做 Agent」的落地：甲（内核契约）让开源框架**用我们的引擎替代原生记忆**；乙（边缘接入）让闭源 Agent **在流量边界被我们的层包裹**——无论 Agent 开源与否，我们都在它脚下。
- 「Sentry for Context」（§7.3 / `audit()`）是该战略里**最可防守的独立变现点**：任何平台都不给 builder 这个可见性，且旁路零侵入、无 cache 冲突。
- 乙层的存在本身证明定位：我们站在**闭源 Agent 与闭源模型之间**，比任何 Agent 都靠下、比模型靠外——「模型无关、工作在模型边界外」的最强证据。
