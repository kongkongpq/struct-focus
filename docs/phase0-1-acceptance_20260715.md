# StructFocus 路线对照验收报告（Phase 0 + Phase 1）

> 日期：2026-07-15
> 对照文档：`docs/CONTEXT_MIDDLEWARE_STRATEGY.md`（上下限高发展路线）
> 测试：17 文件 / 75 tests / 全过（1.83s）
> 基准：A/B 对比 3 任务，平均峰值 token 下降 27.7%，focus/recall 命中率 100%

---

## 验收结论：Phase 0 + Phase 1 全部通过 ✅

### Phase 0 — 引擎基本功补全

| 项 | 路线要求 | 代码实现 | 状态 |
|---|---|---|---|
| P0-1 结构化压缩 | 接近软限时被动触发结构化压缩，保留用户目标/状态/失败/工具结果 | `structuredCompress()` 识别 `[目标]`/`[状态]`/`[失败]`/`[关键工具结果]`/`[错误]`/`[结果]`/`[小结]` 锚点段原样保留 + 头/错误行/尾紧凑化；无标记段回退 `genericCompressToolOutput` | ✅ |
| P0-2 工具结果预处理 | 裁掉噪声（截断 + HTML/重复过滤） | `preprocessToolOutput()`：超长取头+尾+错误行、HTML 剥离、连续重复行去重 | ✅ |
| P0-3 cache 感知排布 | I-Context 稳定前缀放可缓存段 | I-Context `getHash()` FNV-1a 内容指纹 + `toMessages()` 在 system 消息打 `cacheControl: { type: "ephemeral" }`；`dynamicInstruction` 不影响 I-Context 稳定性 | ✅ |

**验收标准**：125000 预算下峰值 token 下降 ≥15%。
**实际结果**：3 任务平均下降 **27.7%**（24.9% / 28.0% / 30.2%），**超出阈值 12.7 个百分点**。

---

### Phase 1 — 框架接管六原语 + 任务相关性驱逐

| 项 | 路线要求 | 代码实现 | 状态 |
|---|---|---|---|
| P1-1 框架接管 focus/forget/reflect | 框架自动执行，不依赖模型自觉 | `autoManage()` 自动：①taskContext.currentFiles 变化时自动 `focusFile(symbols)` ②≥70% 驱逐 ③≥85% 自动 forget 非焦点文件 ④≥90% 告警 ⑤每5步注意力审计 | ✅ |
| P1-2 自动 remember/recall | 重要决策自动 remember，相关任务自动 recall | `autoRememberFromContent()` 5 种决策模式正则匹配自动记忆；`autoManage()` 每步用 `currentSymbols + currentFiles` 作为 query 自动 `recall`，去重后注入 observation | ✅ |
| P1-3 任务相关性驱逐 | evictionScore 接入当前子任务状态 | `evictionScore(entry, this.taskContext)` 实例字段：精确文件命中 1.0 / 符号命中 0.6 / 部分文件 0.3 / 失败测试 0.6 | ✅ |
| P1-4 删死代码 | 移除未接管线 | 桶模型已删（`BudgetManager` constructor 空壳，`consume/remaining/buckets` 全部移除）；`EVICTION_ORDER` + `EVICTION_PRIORITY` 已接入 `evictionPriority()` | ✅ |

**验收标准**：不调用任何上下文工具时，引擎仍能按任务聚焦/淘汰。
**实际结果**：B 组（仅 autoManage，无手动工具调用）focus 命中率 100%、recall 命中率 100%。

---

## 6 个 Gap 逐项确认

### Gap 1：结构化压缩 ✅
- `manager.ts` L1195 `structuredCompress()`：识别 7 种语义锚点标记段，原样保留 + 头/错误行/尾紧凑化
- `compressOldEntries()` 调用 `structuredCompress()` 替代旧 `genericCompressToolOutput`
- 测试：`structured-compress.test.ts` 4 tests（锚点保留 / 无标记回退 / 短内容不压缩 / 去重）

### Gap 2：框架自动 focus ✅
- `manager.ts` L830-836 `autoManage()`：`taskContext.currentFiles` 差集自动 `focusFile(f, "symbols")`
- `focusSkipped` Set 避免重复尝试不存在路径
- 测试：`acceptance-bench.test.ts` B 组 focus 命中率 100%

### Gap 3：自动 recall ✅
- `manager.ts` L841-852 `autoManage()`：每步用 `currentSymbols + currentFiles` 作 query 调 `recall(3)`
- `recalledHashes` Set 去重，避免每步重复注入
- 测试：`acceptance-bench.test.ts` B 组 recall 命中率 100%

### Gap 4：taskContext 实例化 ✅
- `manager.ts` L497-498 `private taskContext?: TaskContext`（实例字段）
- 模块级 `let currentTaskContext` 已删除
- `setTaskContext()` 改为实例方法 `this.taskContext = ctx`
- `evictionScore(entry, this.taskContext)` 传实例字段

### Gap 5：死代码清理 ✅
- `budget.ts`：桶模型 `consume/remaining/totalUsed/totalRemaining/isOverBudget/toTokenUsage/getEvictionOrder/reset + DEFAULT_BUDGET_BUCKETS` 全部删除
- `BudgetManager` 仅保留 `estimateTokens()` 静态方法 + 空构造器（向后兼容）
- `PointerRegistry`：仍在 `pointer.ts` 但从 `index.ts` 导出列表中仅保留 `type ContextPointer`（类型导出），不导出运行时类——等真正需要时再接

### Gap 6：基准测试套件 ✅
- `bench/harness.ts`：A/B 对比（朴素基线 vs 上下文引擎），3 任务用真实 .ts 文件作语料
- `bench/tasks.ts`：3 任务（manager / budget / explorer 场景）
- `bench/report.ts`：Markdown 报告生成
- `bench/run.ts`：独立运行入口 `npx tsx bench/run.ts`
- `tests/acceptance-bench.test.ts`：vitest 集成，断言 ≥15% 下降 + focus/recall 100%
- 结果：平均下降 27.7%，全部通过

---

## 当前测试状态

```
17 files / 75 tests / all passed (1.83s)
```

新增测试文件（vs 上轮 80 tests → 现在 75 tests，因为部分旧测试被重写/合并）：
- `structured-compress.test.ts`（4 tests）— Gap 1
- `acceptance-bench.test.ts`（1 test，含 3 子任务）— Gap 6

---

## 下一步：Phase 2 可启动

路线文档原文：**「Phase 1 未验收前，禁止做完整 Agent」**

现在 Phase 0 + Phase 1 全部验收通过，可以启动 Phase 2：

### Phase 2 — 开源 SDK + 私有化 License
- P2-1 开源 Core SDK（Apache-2.0）：`@structfocus/context` npm 包
- P2-2 商业版：trace 回放、注意力浪费看板、成本分析
- P2-3 私有化 License：金融/政企数据不出域
