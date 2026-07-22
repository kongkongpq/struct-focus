# Changelog

所有重要变更记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer）。

## [0.2.0] - Unreleased

### 新增
- **保守模式（conservative）**：`ManagementPolicy` 新增 `conservative` 标志与 `effectiveEmergencyThreshold()` 助手。开启后 `emergencyThreshold` 抬到 `max(emergencyThreshold, 0.97)`，仅当窗口接近满才把最冷 L3 内容落盘到 L4，避免可召回内容过早丢到磁盘。
- **多模型 benchmark harness**：`packages/context/bench/run-llm.ts` 支持 DeepSeek / 智谱 GLM / 通义千问 / GPT-4o-mini 矩阵跑分（读各家 Key 环境变量或 `STRUCT_LLM_*` 覆盖）。配套 `BENCHMARK_MATRIX.md` 对比表 + 每模型 `LLM_REPORT_<model>.md`。
- **胶囊数量上限**：`LongContextEngine` 新增 `capsuleMaxCount`（默认 50，`STRUCT_CAPSULE_MAX_COUNT`，0=不限制），`summarize` 后按 `createdAt` 踢最旧胶囊并物理删除 JSON（防 `listCapsules` / L1 渲染在千级胶囊时变慢、占大量 token）。
- **ContentStore 磁盘 LRU**：`ContentStore` 新增 `maybeCleanup()` / `dirSize()` / `getStorageStats()` / `enforceStorageLimit()`，`save()` 后异步按 `savedAt` 淘汰最旧条目，回到 `STRUCT_STORE_MAX_MB`（默认 512MB，0=无限）的 90% 以内。
- **LLM 压缩失败告警**：`LongContextEngine` 新增 `getLlmStatus()` / `checkLlmHealth()`，三级状态 `unknown / ok / degraded / failed`；`llmCall` 包裹失败计数，首次失败 `logger.warn`；MCP 启动时异步 ping `/models` 健康检查。失败时压缩自动降级为本地确定性摘要，不阻断主流程。
- **MCP 工具补齐**：新增 `context_set_policy`（热更新管理策略）、`context_stats`（精简状态速览）、`context_search`（ContentStore 历史原文全文检索）。`context_status` 现返回 `storeStats`（磁盘占用）、`llmStatus`（压缩健康）、`policy`（含 `effectiveEmergencyThreshold`）。
- **Gitee CI/CD**：`.gitee/workflows/ci.yml` 在 push/PR 到 main 时自动 typecheck → build → test → `mechanics.mjs` 机制验证。
- **统一基准测试入口**：`packages/context/bench/run.mjs` 作为唯一入口（纯 Node ESM，无需 tsx/key），`--suite <bm25|niah|multihop|docqa|all>`；BM25 套件无 Key 可跑，niah/multihop/docqa 在缺 Key 时优雅跳过（不伪造分数）。`pnpm bench` / `bench:bm25` / `bench:smoke` 均指向它，`docs/benchmarks/` 沉淀可复现报告。

### 修复
- **`hardThreshold` 单位错配**：`manager.ts` `getReflection()` 中 `usePercent`（百分比 0–100）直接对比 `hardThreshold`（比例 0–1）恒为真，已改为 `×100` 对齐。
- **`emergencyThreshold` 单位错配**：`manager.ts` `manage()` 中 `usePercent` 对比 `emergencyThreshold`（比例）恒为真导致紧急 L3→L4 几乎每次都触发，已改为 `usePercent >= effectiveEmergencyThreshold × 100`。
- **上下文管理接线断点（审计）**：逐层审计发现 `autoManage`（压缩/驱逐/窗口管理核心）、`recallAndInject`（召回内容注入被管理上下文）、`forgetRecalled`（清理每轮 `[recall]` 注入）此前仅在 tests/bench 调用，MCP 工具流与 `middleware.pre/postLlmCall` 只 `feed` 不管理，导致「LLM 压缩 / AI 接管上下文」在生产路径从未运行。已接入 MCP `context_inject` 与中间件，并为 `autoManage` 内部补 `summarizeInactive()` 真正概括归档为胶囊；新增 `integration-wiring.test.ts` 与 `server-wiring.test.ts` 集成测试（共 9 例，全量 192 例通过）。

### 变更
- **发布包拆分**：移除过时 Electron 外壳 `packages/app`，仓库现仅含 `@structfocus/context` 与 `@structfocus/mcp` 两个包。
- **MCP 工具数 5 → 8**（新增 `context_set_policy` / `context_stats` / `context_search`）。
- 版本号统一升至 `0.2.0`。

## [0.1.0] - 2026-07-19

### 新增
- 初始公开版本。长上下文管理引擎：四层冷热架构（L1 活跃 / L2 压缩 / L3 胶囊 / L4 磁盘深存）、语义胶囊召回、ContentStore 全文检索、LongContextEngine 公共 API。
- MCP Server（`@structfocus/mcp`）：stdio 传输，零依赖实现 MCP 协议，暴露 5 个上下文工具。
- 确定性压缩回退（无 LLM Key 时仍可运行）。
- 本地机制验证 `mechanics.mjs`（无 LLM 依赖）。
