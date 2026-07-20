# StructAgent

> 一个过渡期的 LLM 上下文管理实验。可能有用，可能没用。数据说话。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 它是干什么的

LLM 对话长了之后，大多数 agent 框架会直接丢掉最早的消息（FIFO 截断），假装它们不存在。StructAgent 换个思路：**不丢，只是不一直放在眼前。**

核心就四步：概括 → 打包成胶囊 → 留个指针 → 需要时再拿出来。

你会发现，FIFO 截断 160 轮后只能记住 33% 的东西，StructAgent 能记住 100% — 而且发出去的 token 少了 76%。

---

## 这个项目是什么（以及不是什么）

**不是**一个 agent 框架。**不是**一个向量数据库。**不是**一个要长期维护的产品。

**是**一个人花了 9 天从零写出来的实验，想看看"管理注意力"能不能比"删东西"更好用。

这个项目有一个自然的保质期。当 1000 万 token 上下文窗口变成标配（可能就一两年），这个中间层就没有存在的必要了。在那之前，如果你被 FIFO 截断坑过，它也许能帮上忙。

---

## 跑分（GLM-4-flash，真实 LLM，12 格 NIAH）

| 上下文长度 | 深度 | FIFO 截断 | StructAgent |
|:---:|:---:|:---:|:---:|
| 4K | Start | ✅ | ✅ |
| 4K | Mid | ✅ | ✅ |
| 4K | End | ✅ | ✅ |
| 16K | Start | ❌ | ✅ |
| 16K | Mid | ✅ | ✅ |
| 16K | End | ✅ | ✅ |
| 32K | Start | ❌ | ✅ |
| 32K | Mid | ✅ | ✅ |
| 32K | End | ✅ | ✅ |
| 64K | Start | ✅ | ✅ |
| 64K | Mid | ✅ | ✅ |
| 64K | End | ✅ | ✅ |

- **FIFO 截断**: 10/12 (83%)
- **StructAgent**: **12/12 (100%)**
- **StructAgent 截救了 2 个 FIFO 翻车的格子**（16K 和 32K 入口处）

长上下文召回 benchmark（160 轮对话，确定性模式）：

| 轮数 | 裸跑 | FIFO 截断 | StructAgent |
|:---:|:---:|:---:|:---:|
| 20 | 100% | 100% | 100% |
| 40 | 100% | 100% | 100% |
| 80 | 100% | 100% | 100% |
| 160 | 100% | 33% | 100% |

真实 LLM 完整 benchmark 报告：[benchmark-result-glm4_20260720.md](./benchmark-result-glm4_20260720.md)

---

## 怎么用

```bash
pnpm install
```

```typescript
import { LongContextEngine } from "@struct/context";

const engine = new LongContextEngine({
  llmCall: (prompt) => yourLLM.chat([{ role: "user", content: prompt }]),
});

engine.feedBatch(history);
const recent = engine.getContextManager().toMessages(systemPrompt);
const { injectText } = await engine.recall(userQuery);
```

就是这样。把 `messages` 数组交给 StructAgent 管，别的不用改。

---

## Package 结构

| 包 | 干什么的 |
|---|---|
| `@struct/context` | 核心引擎。`LongContextEngine`、`ContextManager`、`ContentStore`、`CapsuleStore` |
| `struct-app` | Electron 桌面壳（只有骨架） |
| `@struct/mcp` | MCP Server，让 Claude Code 等能调用引擎 |

---

## 已知问题（诚实列表）

- **没有单元测试覆盖长上下文下真实 LLM 的表现。** 测试套件 125 个全部通过，但都是 mock 模式。GLM-4-flash 的跑分只跑了 12 格 NIAH，更长的场景没测。
- **DocQA 在 230K chars 超窗口时翻车了。** CM 诚实地说"我不知道"，但基线碰巧蒙对了。GLM-4-flash 的 128K 上下文窗口不够大，需要换更大窗口的模型验证。
- **仅测试过 GLM-4-flash。** 没有测试其他模型（Qwen、DeepSeek、GPT-4o 等）。
- **capsule 的 LLM 概括质量没系统评估。** 确定性回退和 LLM 概括在短对话上差异不大（之前测出 LLM 25.7% vs 确定性 23.3% 召回率，368 倍延迟）。
- **没有 Windows 以外的 CI。** 只在我自己的 Windows 台式机上跑过。
- **MCP 集成只画了架构，没有端到端测试。**
- **Electron 桌面壳是空壳，不能跑。**

---

## 希望社区帮忙测什么

这个项目是我一个人写的，我只有一台 Windows 台式机。以下是我自己没条件测、但很想知道的：

- **其他 LLM 上的表现** — Qwen、DeepSeek、GPT-4o、Claude 等
- **macOS / Linux 上的兼容性** — 我只有 Windows
- **集成到现有 agent 框架的坑** — LangChain、CrewAI、AutoGPT、你手搓的 agent
- **233K+ 窗口的真正大模型跑 DocQA** — qwen-plus 的 131K 还不够，可能需要 Claude 的 200K
- **生产环境下的磁盘和内存占用** — ContentStore 在几千条记录下表现如何
- **capsule 概括中文 vs 英文的差异** — 我只测过中文

如果你跑了其中任何一个，**开个 Issue 告诉我结果**。就算结果是"StructAgent 在这个模型上没用"，我也想知道。

---

## 怎么参与

### ✅ 开 Issue — 非常欢迎

- Bug 报告
- 兼容性反馈（"我在 XXX 上试了，结果是……"）
- "FIFO 比 StructAgent 好的场景" — 这种反面数据特别有价值
- 建议和批判

### ❌ 提 Pull Request — 暂不接受

这是一个人维护的过渡项目。我没有精力做 code review、维护 contributor 指南、或者协调多人开发。

如果你真的有改进方案：**fork 它，改好，开个 Issue 贴上你 fork 的链接。** 如果你的 fork 解决了真正的问题，我会链接过去。

---

## 跑 benchmark

```bash
# 确定性模式（不需要 API Key）
npx tsx packages/context/benchmark/index.ts --full --mock

# 真实 LLM
$env:LLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
$env:LLM_API_KEY="你的key"
$env:LLM_MODEL="glm-4-flash"
npx tsx packages/context/bench/run.ts
```

---

## License

[MIT](./LICENSE)
