# StructFocus 架构

> LLM 上下文**注意力管理**引擎。≈ MemGPT/Letta 的上下文部分，减掉 agent 框架，加社区标准 benchmark。
> 一句话：**长对话里不丢消息，只是不一直放在眼前** —— 概括 → 胶囊 → 指针 → 召回。

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

## 2. 仓库结构（pnpm monorepo，7 包）

引擎本身与任何 agent 框架**解耦**；`structfocus-agent` 只是官方参考实现，社区可接入任意框架。

| 包 | 角色 |
|:---|:---|
| `@structfocus/context` | **核心引擎**：上下文组装层（6 层 Pipeline / 指针层 / 预算桶 / CodeExplorer） |
| `@structfocus/memory` | 记忆层：JSONL 引擎 / 胶囊 / 指针 / 环境 / 侧车 |
| `@structfocus/harness` | 安全执行层：7 层管道 / 权限矩阵 / 进程树 / 33 工具 |
| `@structfocus/framework` | 地基：EventBus / PluginManager / Pipeline / 类型契约 |
| `@structfocus/mcp` | 上下文引擎的 MCP Server（stdio 传输，零依赖实现协议） |
| `structfocus-agent` | 参考实现：核心循环 v2 / Electron 预留 / CLI |
| `structfocus-app` | 桌面/应用外壳（Electron 预置） |

---

## 3. 分层与集成

```
┌─────────────────────────────┐
│   任意 Agent 框架            │   OpenClaw / CodeX / 自研 …
│   （只需支持 pre/post LLM hook）│
└───────────┬─────────────────┘
            │ 实现 ContextMiddleware 契约
            ▼
┌─────────────────────────────┐
│   ContextMiddleware          │  preLlmCall / postLlmCall / recall
│   （框架无关的集成点）        │
└───────────┬─────────────────┘
            │ 调用
            ▼
┌─────────────────────────────┐
│   @structfocus/context       │  LongContextEngine
│   （引擎，不绑定任何框架）    │  → ContextManager → 6层Pipeline
└───────────┬─────────────────┘
            │ 依赖
   ┌────────┼────────┬─────────┐
   ▼        ▼        ▼         ▼
 memory  harness framework   mcp
```

关键边界：**引擎不依赖任何框架源码**。`ContextMiddleware` 是 StructFocus 对外暴露的唯一集成契约；针对特定框架/语言的适配（HTTP Sidecar、Python wrapper）留给社区，不属于核心范围。

---

## 4. 上下文引擎（`@structfocus/context`）

### 4.1 公共 API

```ts
import { LongContextEngine } from "@structfocus/context";

const engine = new LongContextEngine({
  llmCall: (p) => yourLLM.chat([{ role: "user", content: p }]),
});

engine.feedBatch(history);              // 摄入历史
const { injectText } = await engine.recall(query);  // 语义召回
// preLlmCall 会把 injectText 注入到发给 LLM 的消息里
```

主要成员：`feed` / `feedBatch` / `summarize` / `flush` / `recall` / `recallAndInject` /
`forgetRecalled` / `autoManage` / `listCapsules` / `getStats` / `newConversation` / `reset`。

### 4.2 注意力三层

| 层 | 形态 | 渲染方式 |
|:---|:---|:---|
| L1 热 | 原始消息 | 按原始角色原样放入上下文 |
| L2 胶囊 | LLM 概括的压缩块 | `📦 [胶囊] … expand:context(…)` |
| L3 冷 | 指针（仅引用） | 不渲染，召回时按需展开 |

`expand:context(…)` 是**指针**——指向被压下去的内容；`recall(query)` 在语义层面找到相关胶囊/指针，把内容展开成 `injectText` 注入回上下文。这就是「不丢，只是不一直放在眼前」。

### 4.3 上下文组装：6 层 Pipeline

`ContextBuilder.buildContext()` 按固定顺序组装发送给 LLM 的消息：

```
system → git → task → focused → history → budget
```

- `system` 系统提示；`git` 仓库状态；`task` 当前任务；`focused` 当前焦点；
- `history` 历史层，依据 `placementMap` 决定每条消息落在 L1/L2/L3（L3 不渲染，L2 渲染成胶囊指针）；
- `budget` 预算层，在 token 上限内做裁剪与淘汰。

### 4.4 预算桶（`BudgetManager`）

用「固定开销 + 若干桶（budget buckets）」建模 token 预算，`EVICTION_ORDER` 决定淘汰优先级，`MAX_CONTEXT_WINDOW` 为窗口上限（可 `setMaxContextWindow` 覆盖）。`setTokenEstimator` 可注入自定义 tokenizer；默认桶模型被 builder/测试实际使用。

### 4.5 记忆后端

`InMemoryBackend` 是默认后端；`tokenizeQuery` 用于召回时的查询分词。长生命周期记忆由 `@structfocus/memory` 提供（JSONL 引擎 + 胶囊/指针管理 + 环境/侧车）。

---

## 5. 集成契约：`ContextMiddleware`

任何支持 pre/post LLM hook 的框架，只需实现这三个方法即可接入 StructFocus，**无需改框架源码、也无需引入框架依赖**：

```ts
interface ContextMiddleware {
  preLlmCall(messages: Message[]): Promise<Message[]>; // LLM 前：注入召回的上下文
  postLlmCall(userMsg: string, assistantMsg: string): void; // LLM 后：摄入本轮对话
  recall(query: string): Promise<string>;              // 按需语义召回，返回 injectText
}
```

用 `createContextMiddleware(engine, opts)` 把一个 `LongContextEngine` 包成 `ContextMiddleware`。参考实现 `structfocus-agent` 的 `StructFocus` 核心循环就是这么接的。

---

## 6. 参考实现（`structfocus-agent`）

`StructFocus` 类把引擎接成一条可运行的 agent 循环：

```ts
const agent = new StructFocus(options);
await agent.init();
const result = await agent.run("帮我把登录接口加上限流");
await agent.destroy();
```

- 内置 BYOK LLM 客户端（`createLLMClient`：DeepSeek / 智谱 / OpenAI / Ollama）
- 死循环检测器 `LoopDetector`、会话管理 `SessionManager`、`tools-registry`（向 harness 注册工具）
- `cli.ts` 提供命令行入口

---

## 7. 数据流：一次对话里引擎干了什么

1. 用户消息进入 → `postLlmCall` 摄入，写入 `ContextManager` / `MemoryBackend`。
2. 引擎按 `placementMap` 把旧消息分层：热的留、温的压胶囊、冷的留指针。
3. 下一轮 LLM 调用前 → `preLlmCall` 触发 `recall(query)`，把相关胶囊/指针展开成 `injectText` 注入消息。
4. 超预算时由 `BudgetManager` 按 `EVICTION_ORDER` 淘汰低优先内容。
5. 长话题被概括为胶囊存于 `CapsuleStore`，需要时可被再次召回——所以 160 轮后召回率仍 100%，而 FIFO 已掉到 33%。

---

## 8. 已知边界

详见 `README.md` 的「已知问题」：
- 仅测过 GLM-4-flash，未覆盖其他模型；
- 只在 Windows 单机跑过；
- DocQA 230K 字符超窗口会翻车（模型窗口限制，非架构问题）；
- 胶囊 LLM 概括质量未系统评估；
- MCP / Electron 当前仅为骨架。

---

## 9. 构建与验证

```bash
pnpm install
pnpm build      # tsc -b
pnpm test       # vitest run（286 用例）
pnpm lint       # eslint .
```

License：**Apache-2.0**（见 `LICENSE`）。
