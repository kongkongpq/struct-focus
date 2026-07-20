# StructFocus 社区标准对齐验收基准 — 设计说明

## 背景

之前的 Needle-in-Haystack 测试是自创的，不与社区标准对齐。审稿时会问"你跟 NIAH 的关系是什么"，没法回答。

## 三题对齐社区

| 题号 | 对齐目标 | 论文/来源 | 测什么 |
|---|---|---|---|
| 1 | gkamradt NIAH | `github.com/gkamradt/LLMTest_NeedleInAHaystack` (3500+ stars) | 变上下文长度 × 变针深度（3×3=9格），对比朴素 vs ContextManager |
| 2 | LongMemEval 风格 | `arxiv.org/abs/2410.10813` (2024-10) | 多段独立会话+分散事实→跨会话综合提问 |
| 3 | MemGPT doc analysis | `arxiv.org/abs/2310.08560` | 超窗口文档（50K chars），答案在70%深度处，朴素组只能看末尾 |

## 文件结构

- `bench/harness.ts` — 测试框架（零 SDK 依赖，纯 fetch）
- `bench/run.ts` — 运行入口

## 使用方法

```
$env:LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode"
$env:LLM_API_KEY="sk-xxx"
$env:LLM_MODEL="qwen2.5-7b-instruct"

npx tsx packages/context/bench/run.ts
```

输出：`packages/context/bench/LLM_REPORT.md`

## 设计关键

- 用 **弱模型**（Qwen2.5-7B）才能拉开差距，DeepSeek V3/Turbo 太强朴素组也答对
- 国内可用：阿里百炼、智谱 GLM、Moonshot 等 OpenAI 兼容 API
- `harness.ts` 的 `callLLM` 使用 `/v1/chat/completions`（OpenAI 兼容标准）
