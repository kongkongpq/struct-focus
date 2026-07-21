# StructFocus

> 中文文档（主）。English version: [README_EN.md](./README_EN.md)

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
      "args": ["-y", "@structfocus/mcp"],
      "env": {
        "STRUCT_LLM_API_KEY": "sk-xxx",
        "STRUCT_LLM_BASE_URL": "https://api.deepseek.com/v1",
        "STRUCT_LLM_MODEL": "deepseek-chat"
      }
    }
  }
}
```

### 配 LLM 压缩（可选）

引擎概括旧上下文时用 LLM 做语义摘要。**不配 Key 也能跑**（走确定性回退：头尾截取，免费但粗略）。

三条环境变量，适配任何 OpenAI 兼容 API：

| 环境变量 | 说明 | 默认值 |
|:---|:---|:---|
| `STRUCT_LLM_API_KEY` | API Key（必填） | — |
| `STRUCT_LLM_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `STRUCT_LLM_MODEL` | 模型名 | `gpt-4o-mini` |

常见例子：

```bash
# DeepSeek（¥1/1M tokens）
STRUCT_LLM_API_KEY=sk-xxx
STRUCT_LLM_BASE_URL=https://api.deepseek.com/v1
STRUCT_LLM_MODEL=deepseek-chat

# 智谱 GLM-4-Flash（免费）
STRUCT_LLM_API_KEY=xxx
STRUCT_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
STRUCT_LLM_MODEL=glm-4-flash

# Ollama 本地模型
STRUCT_LLM_API_KEY=ollama
STRUCT_LLM_BASE_URL=http://localhost:11434/v1
STRUCT_LLM_MODEL=qwen2:7b
```

接入后，Agent 可调用 8 个上下文工具：

| 工具 | 作用 |
|:---|:---|
| `context_inject` | 注入一条上下文（对话 / 工具输出 / 日志） |
| `context_recall` | 按自然语言语义召回历史上下文 |
| `context_status` | 查看引擎完整状态（token / 胶囊数 / 活跃条目 / 磁盘占用 / LLM 健康 / 当前策略） |
| `context_forget` | 忘记（卸载）指定上下文 |
| `context_focus` | 聚焦指定文件/目录到工作上下文 |
| `context_set_policy` | 热更新管理策略（如 `{ conservative: true }` 开启保守模式） |
| `context_stats` | 精简状态速览（更紧凑，适合每次调用后扫一眼） |
| `context_search` | 在历史原文（ContentStore）中按关键词全文检索 |

## 快速验证（30 秒）

接入后，用一段对话验证它真的在「管理上下文」而非「丢消息」：

1. **启动 MCP**（以 Claude Code 为例，已登记上面的 `mcp.json`）：
   ```bash
   # 手动起一个 Server 看日志（可选）
   cd packages/mcp
   STRUCT_LLM_API_KEY=sk-xxx STRUCT_LLM_BASE_URL=https://api.deepseek.com/v1 STRUCT_LLM_MODEL=deepseek-chat \
     node --experimental-strip-types ./src/index.ts
   # 启动时会打印「LLM 压缩已启用 …」并做 /models 健康检查（未通过会告警但不阻断）
   ```
2. **注入 + 召回**：让 Agent 先把一段长上下文交给 `context_inject`，过一会儿问一个**早就被注入、但早已被概括下沉**的细节。调用 `context_recall` 应能把它捞回来（而不是「我不记得了」）。
3. **看状态**：调用 `context_status`，重点看三块：
   - `storeStats`：`usedMB / maxMB` —— 磁盘占用是否在上限内（默认 512MB，设 `STRUCT_STORE_MAX_MB=0` 关掉）。
   - `llmStatus`：`status` 应为 `ok`（配置且最近成功）；若 `degraded`/`failed` 说明压缩在降级为本地摘要，检查 Key/配额。
   - `policy`：`effectiveEmergencyThreshold` 默认 0.85；若开了保守模式（`context_set_policy {conservative:true}`）会抬到 0.97。
4. **排错速查**：
   - `context_status` 报 `llmStatus.configured=false` → 没读到 `STRUCT_LLM_API_KEY`，压缩走免费回退（结果较糙但能跑）。
   - `healthy=false` → `/models` 不可达，检查 `STRUCT_LLM_BASE_URL` 与网络。
   - MCP 客户端连不上 → 确认 Node ≥ 22.6，且 `npx -y @structfocus/mcp` 能拉到包（未发布时改用本地 `node --experimental-strip-types ./packages/mcp/src/index.ts`）。

## 代码级使用（TypeScript 宿主）

```ts
import { LongContextEngine } from "@structfocus/context";
const engine = new LongContextEngine({ llmCall: (p) => yourLLM.chat([{ role: "user", content: p }]) });
engine.feedBatch(history);
const { injectText } = await engine.recall(query);
```

架构设计详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 环境要求

- **Node >= 22.6.0**（MCP Server 用 `node --experimental-strip-types` 直跑 TypeScript，22.6 起支持；低版本无法启动 `@structfocus/mcp`）
- pnpm >= 9（开发用）

## 构建与验证

```bash
pnpm install
pnpm build      # tsc -b（context → dist）
pnpm test       # vitest run（context 167 + mcp 16 = 183 用例）
pnpm lint       # eslint packages/context/src packages/mcp/src
```

本地起一个 MCP Server（stdio）：

```bash
cd packages/mcp
node --experimental-strip-types ./src/index.ts
```

## 已知问题

- 多模型 benchmark 已内置 harness（`packages/context/bench/run-llm.ts`，支持 DeepSeek/GLM/Qwen/GPT-4o-mini），但**实跑数据需你用自己的 Key** 生成（`STRUCT_LLM_*` 或各家 Key 环境变量）
- DocQA 窗口范围内已验证可召回；超窗口翻车为模型窗口限制，非架构问题
- 胶囊 LLM 概括质量未系统评估

## 参与

- **Issue 欢迎**：Bug、兼容性、反面数据（"FIFO 在这场景更好"）都有价值。
- **暂不收 PR**：一人维护过渡项目。改进请 fork 后开 Issue 贴链接。

## License

[Apache-2.0](./LICENSE)
