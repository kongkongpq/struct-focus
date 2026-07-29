# @structfocus/context

> LLM 长上下文注意力管理引擎。四层冷热架构（L1 常驻 / L2 工作 / L3 压缩 / L4 原文落盘），把「被 FIFO 截断丢掉的历史」变成「可随时召回的胶囊与原文」。

这是 StructFocus 的**核心引擎**包。如果你想要「三行接入任意 MCP 宿主（Claude Code / Cursor / Cline）」，直接用 [`@structfocus/mcp`](https://www.npmjs.com/package/@structfocus/mcp)；本包适合在 **TypeScript/Node 宿主里以代码方式集成**。

## 为什么

长对话里多数 agent 直接丢最早的消息（FIFO 截断）。StructFocus 换个思路：**不丢，只是不一直放在眼前** —— 概括 → 胶囊 → 指针 → 召回。

长对话召回率（注入的话题是否还留在上下文）：

| 轮数 | FIFO | StructFocus |
|:---:|:---:|:---:|
| 20–80 | 100% | 100% |
| 160 | 33% | **100%** |

## 安装

```bash
npm install @structfocus/context
# 或 pnpm / yarn
```

要求 **Node >= 22.6.0**。

## 快速开始

```ts
import { LongContextEngine } from "@structfocus/context";

// 注入你自己的 LLM 调用（任何 OpenAI 兼容 API 都行）
const engine = new LongContextEngine({
  maxWindow: 200_000,
  llmCall: async (prompt) =>
    (await yourLLM.chat([{ role: "user", content: prompt }])).text,
});

// 灌入历史
engine.feedBatch(history);

// 窗口溢出时自动压缩 / 召回
await engine.autoManage();

// 按自然语言召回早期上下文
const { injectText } = await engine.recall("支付网关 503 那次的根因是什么？");
console.log(injectText);
```

不配 `llmCall` 也能跑：引擎走确定性回退（头尾截取），免费但粗略；配上 LLM 即升级为语义摘要。

## 核心能力

- **四层冷热管线**：活跃对话保持热，闲置上下文逐层压缩下沉到磁盘，按需召回。
- **胶囊（Capsule）**：把多轮上下文语义凝练成一个摘要，可 `expand:context("<id>")` 还原原文。
- **ContentStore（BM25 磁盘检索）**：被压缩 / 驱逐的原文落盘，按关键词或语义召回，绝不丢失。
- **自适应管理**：`autoManage()` 自动聚焦 / 召回 / 压缩 / 容量兜底，也可 `setPolicy()` 热更新（保守 / 激进 / 自定义阈值）。

## 配 LLM 压缩（可选）

`llmCall` 适配任何 OpenAI 兼容 API 即可，例如：

```ts
// 智谱 GLM-4-Flash（免费）
const engine = new LongContextEngine({
  llmCall: makeGlmCaller(process.env.STRUCT_LLM_API_KEY!),
});
```

## 链接

- MCP Server 包：[@structfocus/mcp](https://www.npmjs.com/package/@structfocus/mcp)
- 仓库与文档：<https://gitee.com/kongkongpq/struct-focus>

## License

[Apache-2.0](./LICENSE)
