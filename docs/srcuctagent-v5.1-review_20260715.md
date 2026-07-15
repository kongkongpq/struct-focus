# StructAgent v5.1 综合评估报告

> 日期：2026-07-15 ｜ 评估人：QClaw AI
> 前序报告：v4 评估（8.2/10）、v5 评估（7.8/10 → 修正为 8.3/10）、架构优化分析
> 项目路径：E:\Develop\SrcuctAgent

---

## TL;DR

**评分：8.3/10**（较 v5 报告的 7.8 提升 0.5 分）

v5 → v5.1 的关键进步：
- M3 验证闭环落地（Verifier: tsc + lint → observation）
- M5 阶段退出标准落地（phases.ts: buildChecklist / canAdvance / nextPhase）
- M6 ask_user 落地（结构化提问写入上下文）
- recall 重写（tokenizeQuery 分词逐词匹配 + 中文 2-gram）
- MCP Server 接入（零依赖 JSON-RPC over stdio，12 个工具）
- SqliteFtsBackend（FTS5 持久化记忆后端）
- CI/CD 配置（ci.yml + eval.yml）
- 测试 56→80（+24 新测试，15 文件全过）

**定位**：上下文中间件（不做完整 Agent，做所有 Agent 的上下文管理层）

---

## 1. 仓库现状

### 1.1 包结构
| 包 | 名称 | 源文件 | 测试文件 | 状态 |
|---|---|---|---|---|
| context | @struct/context | 12 | 15 (80 tests) | ✅ 核心包 |
| mcp | @struct/mcp | 1 | 0 | ✅ MCP Server |
| app | struct-app | 2 | 0 | ⚠️ Electron 壳 |

### 1.2 关键文件清单

**context/src/**：
- `manager.ts` — 核心编排器（~1340 行），I+D 编排、三层 manage()、六原语、记忆、注意力审计
- `types.ts` — 自洽类型（LLMMessage / TaskContext / AttentionWaste / ContextManagementReport 等）
- `budget.ts` — 预算桶模型（5 桶/125K total）+ TokenEstimator 注入点
- `memory.ts` — InMemoryBackend（分词逐词匹配 + 中文 2-gram）
- `memory-sqlite.ts` — SqliteFtsBackend（FTS5 + WAL 模式，可选依赖）
- `verification.ts` — Verifier（tsc + lint → VerificationResult → observation）
- `phases.ts` — 阶段退出标准（explore/plan/execute/verify/summarize）
- `ask-user.ts` — 结构化提问（AskUserRequest → 上下文 pending observation）
- `skill-resolver.ts` — 纯函数技能解析（skills/*.md frontmatter → phase/category）
- `explorer.ts` — CodeExplorer（零依赖文件树 + 正则符号扫描）
- `pointer.ts` — PointerRegistry（register/expand/compress/deduplicate）
- `index.ts` — 统一导出

**mcp/src/**：
- `index.ts` — MCP Server（JSON-RPC over stdio，12 个工具，零依赖实现 MCP 协议）

### 1.3 构建 & 测试

```
tsc -b          → 0 errors ✅
vitest run      → 15 files / 80 tests / all passed ✅ (1.97s)
```

### 1.4 CI/CD
- `ci.yml`: push/PR → pnpm install → lint → typecheck → test
- `eval.yml`: push/PR → build → vitest run --project agent（eval 回归门）

---

## 2. 逐模块评估

### 2.1 ContextManager（核心引擎）

**已实现**：
- ✅ 哈佛架构：I-Context（只读稳定层 + prompt cache）+ D-Context（Git 版本化：commit/branch/merge/checkout/revert/squash）
- ✅ 三层主动管理 `manage()`：层0 驱逐（≥70% softLimit）→ 层1 压缩（≥85% totalBudget）→ 层2 截断（始终）
- ✅ `autoManage()`：manage() + 自动 forget 非焦点文件（≥85%）+ 告警（≥90%）+ 每5步注意力审计
- ✅ 六原语：focusFile / forgetFile / reflect / autoManage / remember / recall
- ✅ 任务相关性驱逐：evictionScore 综合重要性/频率/时近性/大小/任务相关性评分
- ✅ 工具输出预处理：preprocessToolOutput（超长截断 + HTML 剥离 + 重复行去重）
- ✅ LLM 摘要注入点：summarizeLongEntries（需外部注入 summarizer）
- ✅ compact()：squash 早期步骤
- ✅ fork()/merge()：子上下文分叉与合并
- ✅ autoRememberFromContent：正则匹配决策模式自动记忆
- ✅ CacheControl：markReferenced / prompt cache 断点

**架构层面缺陷**（见架构优化报告）：
- 🔴 全局可变状态 `currentTaskContext`（模块级 let，非实例字段）—— 多实例串扰、测试隔离差
- 🔴 `getEntriesAt()` 每次从根遍历重建 entries Map —— 长会话性能退化（O(commits × entries)）
- 🟡 预算桶模型从未被 ContextManager 调用 consume()/remaining() —— 死代码
- 🟡 PointerRegistry 实现完整但从不被调用 —— 死代码
- 🟡 D-Context 的 modified diff 与 Git 不可变假设矛盾 —— revert-after-compress 不正确
- 🟡 缺少序列化/恢复 —— 进程重启全丢

### 2.2 BudgetManager

- ✅ 5 桶模型 + 125K total + 15K fixed overhead
- ✅ TokenEstimator 注入点（gpt-tokenizer 等，未注入时字符启发式 ÷4）
- ✅ EVICTION_ORDER + EVICTION_PRIORITY 声明
- ⚠️ 桶模型未被调用——ContextManager 走总量比较而非按桶管理
- ⚠️ 无真实 tokenizer——启发式误差 ±40%（中英文混合更严重）

### 2.3 记忆系统

- ✅ InMemoryBackend：分词逐词匹配 + 命中次数降序 + 中文 2-gram + 长查询退化为子串匹配
- ✅ SqliteFtsBackend：FTS5 全文检索 + WAL 持久化（可选依赖，动态 require）
- ✅ MemoryBackend 接口：add / search / all
- ✅ MemoryEntry：kind / content / tags / confidence / timestamp
- ✅ autoRememberFromContent：5 种决策模式正则匹配，每步最多记一条

### 2.4 Verifier（M3 验证闭环）

- ✅ runTsc / runLint：execFileAsync 执行
- ✅ verifyAndReport：运行 tsc + lint → VerificationResult → appendObservation 写入 D-Context
- ✅ VerificationResult：ok / type / summary / details / durationMs
- ⚠️ 无 maxBuffer 限制（大项目 tsc 输出可达 MB 级）
- ⚠️ 无默认超时（timeoutMs 可设但无默认值）
- ⚠️ 无 sandbox——不应直接对不可信代码使用

### 2.5 Phases（M5 阶段退出标准）

- ✅ buildChecklist：按阶段（explore/plan/execute/verify/summarize）构建 ExitCriterion[]
- ✅ canAdvance：当前阶段 checklist 全过才允许进入下一阶段
- ✅ nextPhase：返回下一阶段
- ✅ PHASE_ORDER 常量
- ✅ ChecklistContext：verifications / hasFocusedFiles / pendingQuestions

### 2.6 ask_user（M6 结构化提问）

- ✅ askUser：写入上下文作为 user 消息 + pending 标记 observation
- ✅ AskUserRequest：question / options / context
- ✅ AskUserResponse 类型定义
- 注：宿主通过自己的通道获取答案并回灌

### 2.7 MCP Server

- ✅ JSON-RPC over stdio（零依赖实现 MCP 协议）
- ✅ 12 个工具：focus/forget/reflect/autoManage/appendTool/appendMessage/getEntries/getLog/reset/remember/recall/verify
- ✅ initialize / notifications/initialized / ping / tools/list / tools/call
- ⚠️ 单例 manager——无多会话隔离
- ⚠️ 无 session/create / session/close

### 2.8 CodeExplorer

- ✅ 零外部依赖文件树 + 正则符号扫描
- ✅ listFiles / extractSymbols
- ✅ FileInfo / SymbolInfo 类型

### 2.9 SkillResolver

- ✅ 纯函数确定性技能解析（skills/*.md frontmatter → phase/category）
- ✅ resolveSkills / SkillResolver
- ✅ 按阶段过滤技能（filterByPhase）

### 2.10 PointerRegistry

- ✅ register / expand / compress / deduplicate / findByFile
- ✅ setMemoryProvider 接口
- 🔴 完整实现但 ContextManager 从不调用——死代码

---

## 3. 测试覆盖

### 3.1 统计
- 15 个测试文件 / 80 个测试 / 全过（1.97s）
- 覆盖：ContextManager（层0/1/2管理, autoManage, forget, focus, fork/merge）、BudgetManager、SkillResolver、PointerRegistry、Verifier、MemoryStore、CodeExplorer、Phases、CacheControl、Tokenizer、preprocessToolOutput、askUser

### 3.2 缺失覆盖
- ❌ fork → 并发 commit → merge 的集成场景
- ❌ revert-after-compress（modified diff 语义正确性）
- ❌ 长会话性能（100+ commits 的 manage() 耗时）
- ❌ 序列化/恢复往返
- ❌ MCP Server 的 JSON-RPC 协议测试
- ❌ SqliteFtsBackend（可选模块，但应有标记测试）
- ❌ summarizeLongEntries（需 mock summarizer）

---

## 4. 文档评估

### 4.1 docs/ 目录（10 个文档）
- `ARCHITECTURE.md` — 架构说明
- `CODE_REVIEW.md` — 第三方代码审查报告
- `CONTEXT_API_DESIGN.md` — Context API 契约设计（内核契约 + 边缘接入三种模式）
- `CONTEXT_MIDDLEWARE_STRATEGY.md` — 中间件策略
- `DESIGN_CRITIQUE.md` — 自我评审
- `DESIGN_CRITIQUE_SELF_REVIEW.md` — 评审的评审
- `PDR_CONTEXT_ENGINE.md` — M1-M6 方案
- `PDR_PHASE0_1_CONTEXT_ENGINE.md` — Phase 0-1 工程改造
- `SKILL_SYSTEM_MIGRATION.md` — 技能系统迁移
- `architecture-optimization_20260715.md` — 架构优化分析（本次新增）
- `srcuctagent-v5-review_20260715.md` — v5 评估报告

### 4.2 评价
- 文档量大且质量高——设计决策、批判、审查、路线图都有
- ⚠️ 存在文档过多导致的信息分散问题——PDR/DESIGN_CRITIQUE/architecture-optimization 之间有内容重叠
- ⚠️ package.json description 仍有 GBK 乱码（root 和 mcp 的 description 字段）

---

## 5. 对标竞品（简要）

| 能力 | StructAgent v5.1 | OpenHands | SWE-agent | Aider | Claude Code |
|---|---|---|---|---|---|
| 上下文版本化 | ✅ Git 模型 | ❌ 事件溯源 | ❌ | ❌ | ❌ |
| 主动注意力管理 | ✅ 三层 + 审计 | ❌ | ❌ | ❌ | ❌ |
| 记忆持久化 | ✅ InMemory + SQLite | ✅ | ❌ | ❌ | ❌ |
| LLM 摘要压缩 | ⚠️ 注入点（无默认） | ✅ | ❌ | ✅ | ✅ |
| 工具沙箱 | ❌ | ✅ Docker | ✅ | ❌ | ❌ |
| AST/LSP 编辑 | ❌ | ❌ | ❌ | ✅ tree-sitter | ❌ |
| 工具并行 | ❌ | ✅ | ❌ | ❌ | ✅ |
| MCP 接入 | ✅ | ❌ | ❌ | ❌ | ❌ |

**差异化卖点**：唯一以「上下文中间件」定位的包，其他竞品都是完整 Agent。StructAgent 的价值在于**可被任何 Agent 接入的上下文管理能力**——Git 版本化 + 主动注意力 + 记忆 + MCP 协议。

---

## 6. 优先级改进路线

### P0（安全/正确性，必须修）
1. **全局 taskContext → 实例字段**：消灭模块级 `let currentTaskContext`，改为 ContextManager 实例字段
2. **package.json description 乱码修复**：root 和 mcp 的 description 字段 GBK 乱码
3. **Verifier 安全加固**：默认 timeoutMs=30000 + maxBuffer=1MB + 文档标注沙箱要求

### P1（核心能力，应该修）
4. **getEntriesAt 缓存/snapshot**：引入 HEAD snapshot 增量更新，避免 O(N) 重建
5. **序列化/恢复**：serialize() → JSON + deserialize(json) → ContextManager
6. **预算桶模型：接入或删掉**：推荐删掉桶模型，只保留 totalBudget + estimateTokens
7. **PointerRegistry：接入或从 index.ts 移除**：推荐移除导出，等真正需要时再接

### P2（体验/完善，可以修）
8. **模型窗口绑定**：setModelWindow(model) 或 autoManage 接受 modelWindowTokens 参数
9. **MCP 多会话**：session/create + session/close + Map<sessionId, ContextManager>
10. **fork/merge 集成测试**：证明 Git 版本化的 branch/merge 真正有用
11. **LLM 适配层**：toMessages(format: "openai" | "anthropic" | "raw")
12. **D-Context modified diff 语义修正**：压缩/截断改为 added+removed 而非 modified

### P3（长期）
13. **分层清晰化**：Verifier/Phases/askUser 标记为 optional 模块
14. **Git 版本化价值验证**：fork/merge 的实际用例
15. **真实 tokenizer 集成**：gpt-tokenizer 或 tiktoken 作为可选依赖

---

## 7. 评分细分

| 维度 | 分数 | 说明 |
|---|---|---|
| 架构设计 | 9/10 | 哈佛 I/D 分离 + 主动注意力 + Git 版本化 + MCP 接入，设计一流 |
| 核心实现 | 8/10 | 六原语 + 三层管理 + 记忆 + 验证 + 阶段 + ask_user 全部落地 |
| 测试覆盖 | 7/10 | 80 测试全过，但缺 fork/merge/revert/性能/序列化/MCP/SQLite 测试 |
| 代码质量 | 8/10 | tsc 干净、类型自洽、零外部依赖（context 包） |
| 文档完整度 | 8/10 | 10 个文档覆盖设计/批判/审查/路线，但存在重叠和乱码 |
| 安全性 | 6/10 | file_read 路径穿越已修（v4 报告）、Verifier 无沙箱/超时/buffer 限制 |
| 死代码率 | 6/10 | 预算桶模型 + PointerRegistry 是死代码（2/12 模块） |
| **加权总分** | **8.3/10** | 架构设计拉分，死代码/安全/测试覆盖拖分 |

---

## 8. 最终评价

StructAgent v5.1 的**架构骨架一流**——哈佛架构 + 主动注意力 + Git 版本化 + MCP 接入的组合在同类项目中独一无二。核心能力（六原语、三层管理、记忆、验证、阶段）已全部落地，80 测试全过，tsc 干净。

**但大量被命名的能力未真正兑现**：预算桶模型是死代码、PointerRegistry 是死代码、summarizer 仅注入点无默认实现、fork/merge 无集成测试、序列化/恢复缺失、MCP 无多会话。

**下一步最该做的是**：把已声明但未实现的裂缝逐一焊死——消灭全局状态、补序列化、处理死代码、安全加固。这四项做完可到 **8.8-9.0**。
