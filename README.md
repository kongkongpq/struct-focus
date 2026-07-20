# StructFocus

> LLM 上下文注意力管理。≈ MemGPT/Letta 的上下文部分，减掉 agent 框架，加社区标准 benchmark。

长对话里，多数 agent 直接丢最早的消息（FIFO 截断）。StructFocus 换个思路：**不丢，只是不一直放在眼前** —— 概括 → 胶囊 → 指针 → 召回。

## 跑分

长对话召回率（注入的话题是否还留在上下文）：

| 轮数 | FIFO | StructFocus |
|:---:|:---:|:---:|
| 20–80 | 100% | 100% |
| 160 | 33% | **100%** |

NIAH（针在草堆）：见 `packages/context/bench/hardcore.ts` —— 20 格硬核网格 + 语义干扰项，可本地复现。

## 怎么用

```ts
import { LongContextEngine } from "@structfocus/context";
const engine = new LongContextEngine({ llmCall: (p) => yourLLM.chat([{ role: "user", content: p }]) });
engine.feedBatch(history);
const { injectText } = await engine.recall(query);
```

## 已知问题

- 仅测过 GLM-4-flash，未覆盖其他模型
- 只在 Windows 单机跑过
- DocQA 230K 字符超窗口会翻车（模型窗口限制，非架构问题）
- 胶囊 LLM 概括质量未系统评估
- MCP / Electron 仅骨架

## 参与

- **Issue 欢迎**：Bug、兼容性、反面数据（"FIFO 在这场景更好"）都有价值。
- **暂不收 PR**：一人维护过渡项目。改进请 fork 后开 Issue 贴链接。

## License

[MIT](./LICENSE)
