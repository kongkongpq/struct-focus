# 架构设计（ARCHITECTURE）

## 分层与依赖方向

```
@structfocus/context   ← 上下文引擎（哈佛 I/D 架构 + 主动注意力 + Git 版本化 + 记忆后端）
      ▲        ▲
      │        │
 structfocus-app   @structfocus/mcp
(Electron 壳) (MCP Server, stdio)
```

依赖单向、无环：`context` 不依赖 `app` / `mcp`；`app` 与 `mcp` 仅依赖 `context`。

## 各包职责

### context（上下文引擎 / 中间件，核心）
- **ContextManager**：哈佛架构落地——I-Context（system prompt + 记忆，稳定可缓存）与 D-Context（逐轮对话，Git 版本化 commit/branch/merge/revert/squash + 动态预算驱逐）。
- **BudgetManager**：token 预算（`estimateTokens` 对 CJK 加权）。
- **explorer**：代码探索，关键词提取支持中英文分词。
- **记忆后端**：内存后端（默认）+ `SqliteFtsBackend`（FTS5 全文检索 + 持久化，可选模块，`better-sqlite3` 为可选依赖）。
- **扩展模块（可选、不默认 index 导出）**：`Verifier`（tsc + lint 验证闭环）、`Phases`（五阶段 exit-checklist）、`askUser`（结构化提问）、`PointerRegistry`（指针系统）。

### app（Electron 壳）
- `main`：IPC 桥接聊天请求 → 构造/调用 `ContextManager`；消息长度与空消息校验。
- `preload`：安全的上下文隔离 IPC 桥；`ui`：聊天界面。

### mcp（MCP Server）
- 基于 JSON-RPC 2.0 over stdio 的零依赖协议实现，把 `@structfocus/context` 的上下文能力暴露为 MCP 工具，供 Claude Code / 其他 MCP 客户端接入。

## 数据流（一次交互）

```
外部调用方（app UI / MCP 客户端）
  → ContextManager 构建 I/D-Context（+ 可选记忆注入）
  → 调用方把序列化后的 messages 交给自有 LLM 链路（context 包不直接持有 LLM）
  → 工具结果 / observation 通过 appendToolResult / appendObservation 写回 D-Context
  → autoManage() 在超预算时做 compress/evict/truncate，必要时 compact() 压缩旧历史
  → 结果序列化（toMessages）回传调用方
```

## 设计决策

- **哈佛上下文**：I/D 分离使 system 层稳定、可缓存，D 层可廉价版本化与驱逐，控制 token 成本。
- **版本化优先**：D-Context 基于 Git 模型（commit/branch/merge/revert/squash），每次上下文变更可追溯、可回滚。
- **边界清晰**：`context` 包只负责上下文存储、注意力管理、预算与记忆后端接口；工具执行、LLM 调用、用户交互等「Agent 行为」由 `app` / `mcp` 消费端编排，context 不直接持有 LLM 或执行器。
- **可选扩展不污染核心**：`Verifier` / `Phases` / `askUser` / 指针系统作为可选模块，不默认经 `index` 导出。
- **故障隔离**：`compact()` 压缩旧历史、`autoManage()` 在超预算时做 compress/evict/truncate，必要时回滚到指定 step。
