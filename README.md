# StructAgent

> LLM 上下文注意力管理。≈ MemGPT/Letta 的上下文部分，减去 agent 框架，加上社区标准 benchmark。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

长对话里，大多数 agent 直接丢掉最早的消息（FIFO 截断）。StructAgent 换了个思路：**不丢，只是不一直放在眼前。** 概括 → 胶囊 → 指针 → 召回。

---

## 跑分

### NIAH（GLM-4-flash，12 格）

| | FIFO | StructAgent |
|---|---|---|
| 4K | 3/3 | 3/3 |
| 16K | 2/3 | **3/3** |
| 32K | 2/3 | **3/3** |
| 64K | 3/3 | 3/3 |
| **合计** | **10/12 (83%)** | **12/12 (100%)** |

### 长对话召回（160 轮，确定性模式）

| 轮数 | FIFO | StructAgent |
|:---:|:---:|:---:|
| 20-80 | 100% | 100% |
| 160 | 33% | **100%** |

---

## 怎么用

```typescript
import { LongContextEngine } from "@struct/context";
const engine = new LongContextEngine({ llmCall: (p) => yourLLM.chat([{role:"user",content:p}]) });
engine.feedBatch(history);
const { injectText } = await engine.recall(query);
```

---

## 已知问题

- 仅测过 GLM-4-flash，没测其他模型
- 只在我自己的 Windows 机器上跑过
- DocQA 230K chars 超窗口时翻车（模型窗口限制，非架构问题）
- capsule LLM 概括质量未系统评估
- MCP / Electron 只有骨架

---

## 怎么参与

- **开 Issue：欢迎。** Bug、兼容性反馈、反面数据（"FIFO 在这种场景更好"）都很有价值。
- **提 PR：暂不接受。** 一人维护的过渡项目。有改进方案就 fork，开 Issue 贴链接。

---

## License

[MIT](./LICENSE)
