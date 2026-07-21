# StructFocus 架构

> LLM 上下文**注意力管理**引擎，通过 **MCP（Model Context Protocol）** 作为「上下文中间层」接入任意 Agent 宿主。
> 一句话：**长对话里不丢消息，只是不一直放在眼前** —— 概括 → 胶囊 → 指针 → 召回。

> 新品类定位：**MCP 上下文管理（Context-as-a-Tool）**。StructFocus 不绑定任何 Agent 框架，
> 而是作为一个 MCP Server 暴露 8 个上下文工具，被 Claude Code / Cursor / Cline / 任意支持 MCP 的客户端直接调用。

---

## 1. 它解决什么问题

多数 agent 在长对话里直接丢弃最早的消息（FIFO 截断）。代价是：话题越久，关键信息越容易掉出窗口。
StructFocus 换一种策略：把上下文**分层管理**——热的放眼前、冷的压成胶囊、最冷的只留一个指针，需要时在语义层面把对应内容**召回**回上下文。

召回率对比（注入话题是否还留在上下文）：

| 轮数 | FIFO | StructFocus |
|:---:|:---:|:---:|
| 20–80 | 100% | 100% |
| 160 | 33% | **100%** |

NIAH（针在草堆）基准见 `packages/context/bench/hardcore.ts`：20 格硬核网格 + 语义干扰项，可本地复现。

---

## 2. 仓库结构（pnpm monorepo，3 包）

重构后只保留 **2 个包**，历史包 `agent` / `framework` / `harness` / `memory` 已删除（其类型契约已内联进 `@structfocus/context`），桌面 Electron 外壳 `structfocus-app` 也已移除。
引擎本身与任何 agent 框架**解耦**，Agent 宿主通过标准 **MCP** 协议接入。

| 包 | 角色 |
|:---|:---|
| `@structfocus/context` | **核心引擎**：长上下文管理引擎（L1–L4 四层冷热 / 胶囊 / 指针 / 预算桶 / 语义召回） |
| `@structfocus/mcp` | 上下文引擎的 **MCP Server**（stdio 传输，零依赖实现 MCP 协议，暴露 8 个工具） |

---

## 3. 四层架构（MCP-first）

```
┌─────────────────────────────────────┐
│  Layer 1 — 任意 Agent 框架          │   Claude Code / Cursor / Cline / 自研
│  （作为 MCP 客户端接入）             │   只需支持 MCP（stdio / SSE）
└───────────────┬─────────────────────┘
                │ MCP (JSON-RPC over stdio)
                ▼
┌─────────────────────────────────────┐
│  Layer 2 — @structfocus/mcp         │   MCP Server，零依赖实现协议
│  8 个工具：                         │   context_inject / context_recall / context_status
│   context_forget  context_focus     │   context_set_policy（含 conservative 保守模式）
│   context_stats  context_search     │   context_status / context_stats 查状态
│   context_focus  context_set_policy  │   context_search 查历史原文
└───────────────┬─────────────────────┘
                │ 调用
                ▼
┌─────────────────────────────────────┐
│  Layer 3 — @structfocus/context     │   LongContextEngine
│  （引擎，不绑定任何框架）            │   → ContextManager → 四层冷热 / 胶囊 / 指针 / 召回
└───────────────┬─────────────────────┘
                │ LLM 调用（注入式）
                ▼
┌─────────────────────────────────────┐
│  Layer 4 — LLM API                  │   GLM-4 / DeepSeek / Claude …
│  compress（概括归档）+ recall（召回）│   通过 engine.setLlmCall(fn) 注入，协议无关
└─────────────────────────────────────┘
```

关键边界：**引擎不依赖任何框架源码**，也不依赖任何 MCP SDK。MCP Server 仅用 Node 内置 `readline` + `stdout` 实现一个最小 JSON-RPC 循环。

---

## 4. MCP 工具契约（8 个）

| 工具 | 入参 | 行为 |
|:---|:---|:---|
| `context_inject` | `content`, `source?`, `type?` | 注入一条上下文（user/tool/observation） |
| `context_recall` | `query`, `topK?` | 自然语言语义召回（胶囊摘要 + 相关原文片段） |
| `context_status` | — | 引擎完整状态：token/胶囊数/活跃归档条目、storeStats（磁盘占用）、llmStatus（压缩健康）、policy（含 effectiveEmergencyThreshold） |
| `context_forget` | `target` | 忘记（卸载）指定上下文：文件路径或条目 ID |
| `context_focus` | `path`, `symbols?`, `level?` | 聚焦文件/目录到工作上下文（L0 元数据 / L1 符号大纲 / L2 全文） |
| `context_set_policy` | `conservative?`, `softThreshold?`, `hardThreshold?`, `emergencyThreshold?`, `topicDistance?`, `maxChunkBeforeManage?`, `userOverride?` | 热更新管理策略（如 `{ conservative: true }` 开启保守模式，emergency 抬到 0.97） |
| `context_stats` | — | 精简状态速览：累计注入/概括、胶囊数、活跃/归档条目、磁盘占用、LLM 健康、当前 emergency 阈值 |
| `context_search` | `query`, `topK?` | 在 ContentStore 历史原文中按关键词全文检索（精确找某段原文，而非语义召回） |

接入示例（`mcp.json`，三行搞定）：

```json
{
  "mcpServers": {
    "structfocus": {
      "command": "npx",
      "args": ["-y", "@structfocus/mcp"]
    }
  }
}
```

---

## 5. 上下文引擎（`@structfocus/context`）

### 5.1 公共 API

```ts
import { LongContextEngine } from "@structfocus/context";

const engine = new LongContextEngine({
  llmCall: (p) => yourLLM.chat([{ role: "user", content: p }]),
});

engine.feedBatch(history);              // 摄入历史
const { injectText } = await engine.recall(query);  // 语义召回
```

主要成员：`feed` / `feedBatch` / `summarize` / `flush` / `recall` / `recallAndInject` /
`forget` / `focus` / `forgetRecalled` / `autoManage` / `listCapsules` / `getStats` /
`newConversation` / `reset` / `setLlmCall`。

> 重构新增：`forget(target)`（文件路径按 `forgetFile` 驱逐，ID 按 `forgetNoise` 驱逐）与
> `focus(path, opts)`（委托 `ContextManager.focusFile`）—— 与 MCP 工具 `context_forget` / `context_focus` 一一对应。

### 5.2 四层冷热架构

| 层 | 形态 | 渲染方式 |
|:---|:---|:---|
| L1_permanent | 永久知识（用户习惯、项目方向、胶囊指针） | 始终留指针，绝不驱逐 |
| L2_working | 当前工作（最近 N 轮对话 + 聚焦文件） | 按原始角色原样放入上下文 |
| L3_compressed | LLM 概括的压缩块（胶囊正文） | `📦 [胶囊] … expand:context(…)` |
| L4_raw | 最冷原文（ContentStore 磁盘深存） | 不渲染，精确召回时从磁盘取出 |

流动：`L2 → L3`（触发管理时概括归档）→ `L3 → L4`（胶囊原文 >7 天或超 30 个后深存）；
`L1 → L3`（永久知识旧了也压缩归档，L1 仅留指针）。

`expand:context(…)` / `recall(query)` 是**指针/语义召回**——把压下去的内容按需展开成 `injectText` 注入回上下文。这就是「不丢，只是不一直放在眼前」。

### 5.3 上下文组装：6 层 Pipeline

`ContextBuilder.buildContext()` 按固定顺序组装发送给 LLM 的消息：

```
system → git → task → focused → history → budget
```

- `system` 系统提示；`git` 仓库状态；`task` 当前任务；`focused` 当前焦点；
- `history` 历史层，依据 `placementMap` 决定每条消息落在 L1/L2/L3/L4（L4 不渲染，L3 渲染成胶囊指针）；
- `budget` 预算层，在 token 上限内做裁剪与淘汰。

### 5.4 预算桶（`BudgetManager`）

用「固定开销 + 若干桶（budget buckets）」建模 token 预算，`EVICTION_ORDER` 决定淘汰优先级，`MAX_CONTEXT_WINDOW` 为窗口上限（可 `setMaxContextWindow` 覆盖）。`setTokenEstimator` 可注入自定义 tokenizer；默认桶模型被 builder/测试实际使用。

### 5.5 记忆后端

`InMemoryBackend` 是默认后端；`tokenizeQuery` 用于召回时的查询分词。长生命周期记忆原先由 `@structfocus/memory` 提供，现已内联关键契约（`IMemoryProvider` / `ContextPointer` / `RetrievedMemory`）进 `framework-types.ts`，引擎通过 `IMemoryProvider` 接口与记忆交互（DI）。

---

## 6. 集成契约：`ContextMiddleware` / MCP

两种接入方式：

**A. 作为 MCP Server（推荐，零框架改造）**
任意支持 MCP 的客户端在 `mcp.json` 里登记 `struct-context-mcp`，即可调用上述 8 个工具，无需任何框架源码改动。

**B. 作为代码级中间件（TypeScript 宿主）**
任何支持 pre/post LLM hook 的框架，实现 `ContextMiddleware` 即可接入，无需引入框架依赖：

```ts
interface ContextMiddleware {
  preLlmCall(messages: Message[]): Promise<Message[]>; // LLM 前：注入召回的上下文
  postLlmCall(userMsg: string, assistantMsg: string): void; // LLM 后：摄入本轮对话
  recall(query: string): Promise<string>;              // 按需语义召回，返回 injectText
}
```

用 `createContextMiddleware(engine, opts)` 把一个 `LongContextEngine` 包成 `ContextMiddleware`。

---

## 7. 数据流：一次对话里引擎干了什么

1. 用户消息进入 → `context_inject` 摄入，写入 `ContextManager` / `MemoryBackend`。
2. 引擎按 `placementMap` 把旧消息分层：热的留、温的压胶囊、冷的留指针。
3. 下一轮 LLM 调用前 → `context_recall(query)` 触发语义召回，把相关胶囊/指针展开成 `injectText` 注入消息。
4. 超预算时由 `BudgetManager` 按 `EVICTION_ORDER` 淘汰低优先内容。
5. 长话题被概括为胶囊存于 `CapsuleStore`，需要时可被再次召回——所以 160 轮后召回率仍 100%，而 FIFO 已掉到 33%。

---

## 8. 已知边界

- 仅测过 GLM-4-flash，未覆盖其他模型；
- MCP Server 在 Windows / macOS / Linux 上均以 stdio 验证过握手；
- DocQA 230K 字符超窗口会翻车（模型窗口限制，非架构问题）；
- 胶囊 LLM 概括质量未系统评估。

---

## 9. 构建与验证

```bash
pnpm install
pnpm build      # tsc -b（context → dist）
pnpm test       # vitest run（context + mcp 共 136 用例）
pnpm lint       # eslint packages/context/src packages/mcp/src
```

本地起一个 MCP Server（stdio）：

```bash
cd packages/mcp
node --experimental-strip-types ./src/index.ts
# 客户端发送 initialize → tools/list → tools/call
```

License：**Apache-2.0**（见 `LICENSE`）。
