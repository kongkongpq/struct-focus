# StructFocus

> **MCP 上下文管理（Context-as-a-Tool）** —— 把长上下文注意力管理做成一个 MCP Server，让任意 Agent 宿主（Claude Code / Cursor / Cline）三行接入。
>
> LLM 上下文注意力管理。≈ MemGPT/Letta 的上下文部分，减掉 agent 框架，加社区标准 benchmark。

长对话里，多数 agent 直接丢最早的消息（FIFO 截断）。StructFocus 换个思路：**不丢，只是不一直放在眼前** —— 概括 → 胶囊 → 指针 → 召回。

## 跑分

长对话召回率（注入的话题是否还留在上下文）：

| 轮数 | FIFO | StructFocus |
|:---:|:---:|:---:|
| 20–80 | 100% | 100% |
| 160 | 33% | **100%** |

NIAH（针在草堆）：见 `packages/context/bench/hardcore.ts` —— 20 格硬核网格 + 语义干扰项，可本地复现。

## 三行接入（MCP）

任意支持 MCP 的客户端，在 `mcp.json` 里登记即可，无需改任何框架源码：

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

接入后，Agent 可调用 5 个上下文工具：

| 工具 | 作用 |
|:---|:---|
| `context_inject` | 注入一条上下文（对话 / 工具输出 / 日志） |
| `context_recall` | 按自然语言语义召回历史上下文 |
| `context_status` | 查看引擎状态（token / 胶囊数 / 活跃条目） |
| `context_forget` | 忘记（卸载）指定上下文 |
| `context_focus` | 聚焦指定文件/目录到工作上下文 |

## 代码级使用（TypeScript 宿主）

```ts
import { LongContextEngine } from "@structfocus/context";
const engine = new LongContextEngine({ llmCall: (p) => yourLLM.chat([{ role: "user", content: p }]) });
engine.feedBatch(history);
const { injectText } = await engine.recall(query);
```

架构设计详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 构建与验证

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
```

## 已知问题

- 仅测过 GLM-4-flash，未覆盖其他模型
- DocQA 230K 字符超窗口会翻车（模型窗口限制，非架构问题）
- 胶囊 LLM 概括质量未系统评估

## 参与

- **Issue 欢迎**：Bug、兼容性、反面数据（"FIFO 在这场景更好"）都有价值。
- **暂不收 PR**：一人维护过渡项目。改进请 fork 后开 Issue 贴链接。

## License

[Apache-2.0](./LICENSE)
