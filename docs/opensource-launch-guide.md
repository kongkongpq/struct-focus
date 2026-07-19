# 开源方向 & 兼容性接入指南

> 给你的。代码你自己写，这些是方向。

---

## 1. StructAgent 的集成边界：一句话说清楚

StructAgent **不是 Agent 框架**，它是夹在"Agent 框架的 LLM 调用"和"LLM API"之间的**透明代理层**。

```
Before:  Agent Code → buildMessages() → fetch("https://api.openai.com/...")
After:   Agent Code → buildMessages() → StructAgent.manage() → fetch("https://api.openai.com/...")
                                              ↑
                                    这里做概括/胶囊/召回/驱逐
```

所以兼容性只取决于一件事：**你能截获 Agent 构造的 messages 数组吗？**

---

## 2. 接入模式：三种，难度递进

### 模式一：函数包裹（5 分钟接入）

**适用**：任何自己写 prompt 的 Agent 项目。你把 `messages` 传给 StructAgent，它返回管理后的 `messages`，你再发给 LLM。

```ts
// 原来
const messages = buildMessages(history);
const reply = await llm.chat(messages);

// 接入后
const engine = new LongContextEngine({ llmCall: (p) => llm.chat([{role:"user", content:p}]) });
engine.feedBatch(history);  // 喂入历史
const managed = engine.getContextManager().toMessages();  // 拿管理后的消息
const reply = await llm.chat(managed);
engine.feed(reply, { type: "observation" });  // 喂入回复
```

**这是最稳的模式。什么框架都不用改。**

### 模式二：中间件注入（需要框架支持 hook）

**适用**：OpenClaw、CodeX 这类有 `preprocessMessages` 或 `beforeLlmCall` hook 的框架。

关键接口：

```ts
// StructAgent 暴露
export interface ContextMiddleware {
  /** 在 LLM 调用前处理 messages */
  preLlmCall(messages: Message[]): Promise<Message[]>;
  /** 在 LLM 返回后喂入回复 */
  postLlmCall(userMsg: string, assistantMsg: string): void;
  /** 语义召回（Agent 主动调用） */
  recall(query: string): Promise<string>;
}
```

接入方只需在框架的 hook 点调用上述三个方法。不需要改框架源码。

### 模式三：HTTP Sidecar（最通用但最重）

StructAgent 开一个 localhost HTTP 服务，Agent 框架通过 HTTP 调用。

```
Agent → POST /manage { messages: [...] } → StructAgent → { managed: [...], capsule: {...} }
Agent → POST /recall { query: "..." }     → StructAgent → { results: [...] }
```

**适用**：Python Agent、Claude Desktop（无法改源码）、任何非 JS/TS 项目。

**不建议现在就做。** 等社区有人问"怎么在 Python 里用"再写一个 50 行的 FastAPI wrapper。

---

## 3. 兼容性测试：不需要"全测"，测这四个场景就行

### 3.1 自测（你自己跑，README 写 ✅）

| 场景 | 怎么测 | 预期 |
|------|--------|------|
| **裸调 LLM（函数包裹）** | `benchmark/index.ts` 已经测了 | Recall 100%，token -76% |
| **磁盘持久化** | flush capsule → 重启进程 → recall | 召回率不变 |

### 3.2 社区测（README 写 ⚠ 欢迎测试，提 Issue）

| 场景 | 接入方式 | 为什么放社区 |
|------|---------|------------|
| **OpenClaw** | 模式二：hook `beforeLlmCall` | 你有 OpenClaw 环境，能自测 |
| **CodeX** | 模式二：同上 | 如果能拿到 CodeX 的 hook 文档 |
| **Cursor / Copilot** | 不可接入（闭源，无 hook） | README 直接写 ❌ 不支持闭源 IDE 插件 |
| **LangChain** | 模式一：函数包裹 | 社区贡献者很容易试 |
| **Claude Desktop (MCP)** | 模式三：HTTP sidecar | 需要额外开发，留给社区 |
| **Python Agent** | 模式三：HTTP sidecar | 同上 |

### 3.3 兼容性矩阵（放 README 底部）

```markdown
| 平台 | 状态 | 接入方式 | 备注 |
|------|:----:|---------|------|
| 裸 LLM 调用 | ✅ | 函数包裹 | benchmark 通过 |
| OpenClaw | ✅ | 中间件 hook | 自测通过 |
| CodeX | ⚠️ | 中间件 hook | 欢迎测试 |
| LangChain | ⚠️ | 函数包裹 | 欢迎测试 |
| Cursor / Copilot | ❌ | 无 hook | 不支持 |
| Claude Desktop | ⚠️ | HTTP Sidecar | 需额外开发 |
| 任意 HTTP Agent | ⚠️ | HTTP Sidecar | 需额外开发 |
```

---

## 4. README 结构

```
1. 一句话（10 秒抓住）
   → "FIFO 截断在 160 轮后丢 67% 的知识。StructAgent 保留 100%。"

2. 一张图（30 秒理解）
   → benchmark 对比表的截图

3. 核心概念（2 分钟读完）
   → 概括 → 胶囊 → 指针 → 语义召回
   → 不是压缩，是注意力管理

4. 快速开始
   → pnpm install + 3 行代码跑通

5. 为什么存在
   → "过两年 10M 上下文普及后退役。现在你需要它。"
   → 这段话写在最前面反而更诚实、更吸 star

6. 兼容性矩阵（上面那张表）

7. 不接受的 PR
   → 说清楚：只收 Issue，不维护 PR
   → 社区可以 fork 魔改

8. License: MIT
```

---

## 5. commit 历史：现在的就是最好的

你现在的 30+ commit 跨越 9 天，结构是：

```
修复核心文件 → 架构设计 → 竞争分析 → Phase 0-1 → 可逆性 → 胶囊 → 测试 → benchmark
```

这比 3 个月稀疏 commit 好看 10 倍。**不要造假。** README 里写 "9 days from zero to benchmark" 就是卖点。

如果真觉得太短，唯一能做的：在 README 开头加一句 "This is a 9-day sprint by a solo developer." 把短变成故事。

---

## 6. benchmark 需要跑一次真实 LLM

当前 benchmark 跑在 mock 模式（确定性回退），100% 召回率是结构本身的能力。社区会问"用真实 LLM 概括呢？"

**只要做一次**：GLM-4-flash 跑 `--full`，预期 C 线 ≥ 75%。然后：

- 如果 ≥ 85%：README 写 "100% with deterministic, 87% with GLM-4-flash"
- 如果 75-85%：README 写 "100% with deterministic, 80% with GLM-4-flash — LLM 概括有损失但远超 FIFO 的 33%"
- 如果 < 75%：查概括 pipeline 的 bug，修了再跑

**无论哪个结果都可以发。** 诚实 > 完美。

---

## 7. 不要做的事

| 不要做 | 为什么 |
|--------|--------|
| 造假 commit | 30 条真实 > 100 条假的。被发现=前功尽弃 |
| 写兼容层代码（HTTP sidecar、Python wrapper 等） | 社区会问，问了再写。现在写了没人用 |
| 追求 100% 测试覆盖率 | 这是个过渡项目，不是生产系统 |
| 写长篇论文式的技术博客 | benchmark 图 + 3 段话 > 5000 字博客 |
| 搞 CI/CD / GitHub Actions | 单人项目不需要。README 里写 "pnpm test" 就够了 |
| 申请 GitHub Trending | 自然流量够。话题天然吸 star（AI context window + 开源 + 单人 9 天） |
