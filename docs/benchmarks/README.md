# 基准报告索引 (roadmap 三.2)

StructFocus 的基准脚本位于 `packages/context/bench/`，报告集中于此目录。

| 报告 | 脚本 | 状态 | 说明 |
|---|---|---|---|
| [bm25-precision.md](./bm25-precision.md) | `bench/search-precision.mjs`（`pnpm bench:bm25`） | ✅ 可用 | BM25 vs includes 的 P@5/R@5，本地可跑、无需 key |
| LoCoMo 长程对话 | `bench/locomo/cm-bench.mjs` 等 | ✅ 已有 `LOCOMO_REPORT.md` / `LOCOMO_V3_BASELINE.md` | NIAH + Cat2 时序，需 GLM-4 key |
| 多跳 QA（1.3） | `bench/multihop.ts`（待建） | ⏳ 待 GLM-4 key | 3 文档 × 20 问，跨文档推理 |
| DocQA 750K（1.4） | `bench/docqa.ts`（待建） | ⏳ 待 GLM-4 key | 长文档问答，需 key |
| 整合运行（3.1） | `bench/run.ts` | 🟡 仅 NIAH | 缺 multihop/docqa/bm25 suite 接线 |

## 运行

```bash
pnpm bench:bm25          # BM25 精度基准（本地）
# LoCoMo / 多跳 / DocQA 需先配置 GLM-4 key 后运行对应脚本
```

> 标注 ⏳ 的项依赖 GLM-4 API key；在当前约束下代码可建但无法本地出分，已记入 roadmap 待办组。
