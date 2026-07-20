# StructFocus 128K 级社区标准验收基准 — 运行记录

## 环境
- **模型**：qwen-plus (DashScope, 131K 上下文窗口)
- **API**：dashscope.aliyuncs.com/compatible-mode
- **时间**：2026-07-17 20:30-20:37

## 测试结构
| 题号 | 对齐标准 | 规模 | 格数 |
|---|---|---|---|
| NIAH | gkamradt NIAH (github.com/gkamradt/LLMTest_NeedleInAHaystack) | 4K/32K/100K/128K × 3 depths | 12 |
| LongMemEval | LongMemEval (arxiv.org/abs/2410.10813) | 10 段会话、70+ 条噪音交互 | 6 问题 |
| DocQA | MemGPT (arxiv.org/abs/2310.08560) | 138K tokens 文档 | 1 问题 |

## NIAH 结果 (before bug fix)
- Baseline: 8/12 (67%) — End(100%) 全部 miss
- ContextManager: 8/12 (67%) — 同上

> ⚠️ 发现 off-by-one bug：`depth=1.0` 时 `Math.floor(N * 1.0) = N`，循环 `i < N` 永远不会匹配。已修复为 `Math.min(Math.floor(N*depth), N-1)`。

## LongMemEval 结果 ✅
朴素基线和 ContextManager 都答对全部 6 个问题。10 段会话 + 大量噪音总量在 131K 窗口内，所以朴素基线也没压力。需要更多噪音或更弱的模型来凸显 remember/recall 优势。

## DocQA 结果 ⏳
- 文档：482K chars (~138K tokens)
- 答案位置：70% depth (~96K tokens)
- Baseline 只能看到末尾 100K tokens (后 73%)
- CM evicted: 217 entries, window: 12%
- **运行中断**：qwen-plus 免费额度耗尽 (403)

## 待办
- [ ] 额度恢复后重跑 NIAH（验证 off-by-one fix）和 DocQA
- [ ] LongMemEval 需要更大压力（更多噪音/更弱模型）才能显示差异
