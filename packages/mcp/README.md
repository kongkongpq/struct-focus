# @structfocus/mcp

> **Context-as-a-Tool MCP server** —— 把 StructFocus 的长上下文注意力管理做成 MCP Server，让任意 MCP 宿主（Claude Code / Cursor / Cline）**三行接入**，无需改任何框架源码。

≈ MemGPT/Letta 的「上下文管理」那一半，减去 agent 框架，加上社区标准 benchmark。底层引擎见 [`@structfocus/context`](https://www.npmjs.com/package/@structfocus/context)。

## 为什么

长对话里多数 agent 直接丢最早的消息（FIFO 截断）。StructFocus 换个思路：**不丢，只是不一直放在眼前** —— 概括 → 胶囊 → 指针 → 召回。160 轮对话下，FIFO 只保留约 33% 的话题，StructFocus 保持 **100%**。

## 安装 & 接入

```bash
npx -y @structfocus/mcp
```

任意支持 MCP 的客户端，在 `mcp.json` 里登记即可：

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

要求 **Node >= 22.6.0**（本 Server 用 `node --experimental-strip-types` 直跑 TypeScript）。

## 配 LLM 压缩（可选）

LLM 概括旧上下文时用语义摘要。**不配 Key 也能跑**（走确定性回退：头尾截取，免费但粗略）。三条环境变量适配任何 OpenAI 兼容 API：

| 环境变量 | 说明 | 默认值 |
|:---|:---|:---|
| `STRUCT_LLM_API_KEY` | API Key（配了才启用 LLM 压缩） | — |
| `STRUCT_LLM_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `STRUCT_LLM_MODEL` | 模型名 | `gpt-4o-mini` |

常见例子：

```bash
# 智谱 GLM-4-Flash（免费）
STRUCT_LLM_API_KEY=xxx
STRUCT_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
STRUCT_LLM_MODEL=glm-4-flash

# Ollama 本地模型
STRUCT_LLM_API_KEY=ollama
STRUCT_LLM_BASE_URL=http://localhost:11434/v1
STRUCT_LLM_MODEL=qwen2:7b
```

## MCP 工具（8 个）

| 工具 | 作用 |
|:---|:---|
| `context_inject` | 注入一条上下文（对话 / 工具输出 / 日志） |
| `context_recall` | 按自然语言语义召回历史上下文 |
| `context_status` | 引擎完整状态（token / 胶囊 / 活跃条目 / 磁盘 / LLM 健康 / 策略） |
| `context_forget` | 忘记（卸载）指定上下文 |
| `context_focus` | 聚焦指定文件/目录到工作上下文 |
| `context_set_policy` | 热更新管理策略（如 `{ "conservative": true }`） |
| `context_stats` | 精简状态速览（适合每次调用后扫一眼） |
| `context_search` | 在历史原文（ContentStore）中按关键词全文检索 |

## 本地手动起（看日志）

```bash
cd packages/mcp
STRUCT_LLM_API_KEY=sk-xxx STRUCT_LLM_BASE_URL=https://api.deepseek.com/v1 STRUCT_LLM_MODEL=deepseek-chat \
  node --experimental-strip-types ./src/index.ts
```

## 验证它真的在「管理上下文」而非「丢消息」

注入一段长上下文后，问一个**早已被概括下沉**的早期细节，调用 `context_recall` 应能捞回来（而不是「我不记得了」）。看 `context_status` 的 `llmStatus.status` 应为 `ok`、`storeStats.usedMB` 在上限内。

## 链接

- 核心引擎包：[@structfocus/context](https://www.npmjs.com/package/@structfocus/context)
- 仓库与文档：<https://gitee.com/kongkongpq/struct-focus>

## License

[Apache-2.0](./LICENSE)
