# Struct Agent 包：4 文件补齐

**时间**: 2026-07-11 21:02  
**仓库**: `E:\Develop\SrcuctAgent`

## 目标

补齐 agent 包缺失的 4 个关键文件，让 agent 能跑最小循环：
- `src/agent/struct-agent.ts` — 核心循环编排
- `src/agent/tools-registry.ts` — 33 工具注册 + LLM schema 转换
- `src/cli.ts` — CLI 入口
- `src/index.ts` — 包导出

## 关键设计决策

1. **Memory 注入用 IMemoryProvider 接口**（DI，context builder 不直接 import memory 包）
2. **StructAgentEvents 用 `Record<string,unknown> & {...}`** 满足 EventBus 泛型约束
3. **StateMachine 直接用 LifecycleState**：`idle→running→idle/stopped`（不额外定义事件表）
4. **ToolCall 不扩展**：只传入 `{ tool, args }`，sessionId/abortSignal 由 Harness 内部管理
5. **工具 schema readonly → `[...readonly]` spread** 解除传给 LLM
6. **所有 Memory API 用真实方法**：`getRecords()` `searchSync()` `recordCapsule(CapsuleInput)` 等

## 验证结果

- `tsc -b`：零错误
- `vitest --run`：188/188 全绿（framework 74 + harness 60 + memory 27 + context 27）
- `dist/` 构建成功，产出 `cli.js` `index.js` `agent/struct-agent.js` `agent/tools-registry.js` 等

## 已知未做

- agent 包无单元测试（需 mock Harness/Memory/LLM）
- 未端到端真机跑通（需 API key + 真实项目）
- 未接入 Electron sidecar
