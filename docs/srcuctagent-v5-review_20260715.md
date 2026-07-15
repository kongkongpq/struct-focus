# StructAgent v5 评估报告

> 日期：2026-07-15 ｜ 评估者：QClaw ｜ 对象：`packages/context` 上下文引擎中间件
> 前序报告：`srcuctagent-gap-analysis_20250712.md`（4.6/10）、`srcuctagent-v4-review_20260713.md`（8.2/10）

---

## 0. 评估快照

| 维度 | v4 (2026-07-13) | v5 (2026-07-15) | 变化 |
|---|---|---|---|
| 评分 | 8.2/10 | **7.8/10** | ↓ 0.4 |
| 测试 | 367 全过 | **56 全过**（8 文件） | ↓ 311（预期内：包裁剪） |
| 核心包 | 6 包 | **2 包**（context + app） | ↓ 4（预期内：聚焦） |
| 源文件 | 156 TS | **7 TS**（context/src）+ app | ↓ 大量（预期内） |
| 定位 | 完整 Agent 平台 | **上下文中间层** | 战略转向 |

**评分下降原因说明**：非退化，而是战略聚焦后评估标准变化。v4 评分包含「完整 Agent 平台」的广度加分（AST 编辑、SWE-bench、插件 SDK、多模态等）。v5 主动裁剪为上下文中间件，广度分自然消失。在「上下文引擎」这一垂直维度上，实际能力比 v4 更深更精，但作为一个「可交付产品」仍有关键缺口拖低总分。

---

## 1. 架构评估

### 1.1 战略转向：从 Agent 平台 → 上下文中间层 ✅ 正确决策

**判断依据**：
- Agent 平台赛道拥挤（Claude Code、Cursor、OpenHands、SWE-agent），完整平台的差异化空间有限
- 上下文管理是所有 Agent 的共同痛点，中间件定位有结构性差异化
- 「注意力聚焦而非压缩裁剪」+「RLVR 验证闭环」双支柱逻辑自洽，且不越界

**风险点**：
- 「上下文中间层」是未经验证的市场需求——现有 Agent 框架是否愿意接入第三方上下文层？
- CONTEXT_API_DESIGN.md 的三种边缘接入方案（Proxy/MCP/Hooks）中，Proxy 和 Hooks 都要求拦截模型流量，实操中大部分闭源 Agent 不会开放这个口
- MCP Server 方案最可行（已有生态），但 MCP 目前仅用于工具供给，用于上下文管理是否被接受有待验证

### 1.2 哈佛架构（I-Context + D-Context） ✅ 实现完整

**I-Context（InstructionContext）**：
- 只读、稳定、可缓存：✅ `getHash()` 做 prompt caching 命中判定
- 动态技能注入（M2）：✅ `addSkill`/`removeSkill` 幂等，失效哈希
- 内容结构：system prompt + project config + permission rules + onboarding + tool definitions

**D-Context（DataContext）**：
- Git 模型版本化：✅ commit/branch/merge/checkout/revert/squash 全实现
- 分支隔离：✅ `fork()` 创建子上下文，共享 I-Context 但绑定独立分支
- 局部哈希索引优化：✅ `getEntriesAt` 从 O(步数²) 降到 O(步数)
- commitsOnBranch：✅ 按分支链回溯，避免跨分支误处理

**分离的实际价值**：
- I-Context 稳定前缀 → 可利用 LLM provider 的 prompt caching → 降成本 ✅
- D-Context 版本化 → 可回滚到任意步骤 → 可审计 ✅
- 但 DESIGN_CRITIQUE.md §1.2 的批判有道理：Git 版本化对 agent 自身信息处理无直接帮助，主要是可审计性价值

### 1.3 六原语（focus/forget/reflect/remember/recall + autoManage）

| 原语 | 实现状态 | 质量 |
|---|---|---|
| focus | ✅ `focusFile(path, scope)` 三级 scope（full/symbols/summary） | 良好 |
| forget | ✅ `forgetFile(target)` 移除指定文件条目 | 良好 |
| reflect | ✅ token 统计 + budgetPct + focusedFiles + attentionWaste | 良好 |
| remember | ✅ `remember(content, opts)` 自包含存储 | 可用但简陋 |
| recall | ✅ `recall(query, limit)` 轻量包含匹配 | 简陋（见 §2.3） |
| autoManage | ✅ 分级阈值 + 任务相关性 + 注意力审计 | 核心亮点 |

**关键进步（vs v4）**：
- `autoManage()` 从「模型手动工具」升级为「引擎主动接管」——这是 P1-1 的核心改动，从 opt-in 变为默认策略
- `evictionScore` 接入 `TaskContext`（当前文件/符号/失败测试），驱逐决策有了任务感知
- `attentionWaste` 度量（未引用 token 占比）+ `markReferenced` 标记机制，注意力透明度提升

---

## 2. 代码质量评估

### 2.1 manager.ts（核心文件，~800 行）

**优点**：
- 架构层次清晰：InstructionContext / DataContext / ContextManager 三层分离
- 主动管理三级策略（70%驱逐 / 85%压缩 / 90%告警）逻辑自洽
- `preprocessToolOutput` 工具结果预处理（截断/去HTML/去重）实用
- `Summarizer` 注入式 LLM 摘要器，不反向依赖 LLM，避免循环依赖

**问题**：

**P1（严重）：`autoManage` 的 budgetPct 快照在 manage() 执行前读取，但 manage() 会改变 token 总量**
```typescript
// manager.ts autoManage():
const budgetPct = this.reflect().budgetPct;  // 快照
const report = this.manage();                  // 改变 token
// 后续基于旧 budgetPct 判断 >=85%、>=90%
if (budgetPct >= 85) { ... }  // 可能已经不满足了
```
manage() 执行后 token 已下降，但后续仍用旧 budgetPct 判断 ≥85% 和 ≥90%。这会导致：
- 在 85% 边界附近时，manage() 驱逐后已降到 70%，但仍然触发 auto-forget（多余操作）
- 在 90% 边界附近时同理触发多余告警

**建议**：manage() 后重新读取 budgetPct，或把 auto-forget 和告警条件改为基于 manage 后的 tokens。

**P2（中等）：`evictionScore` 的 taskRelevance 权重不够精细**
```typescript
return impScore * 0.4 + freqScore * 0.15 + recencyScore * 0.15 - sizeScore * 0.1 + taskRelevance * 0.2;
```
- taskRelevance 是 0 或 1.0 的二值（有/无任务相关性），没有中间态
- 当前文件内但非当前符号的条目也获得 1.0 加成，粒度粗

**建议**：引入分级（exact file match > symbol match > partial match），给 0.3/0.6/1.0 三档。

**P3（轻微）：`compressOldEntries` 保护最近 5 个 commit 的条目，但 commit 频率与步数不一一对应**
- 一次 `appendAssistant` 产生一个 commit，一次 `appendToolResult` 也产生一个 commit
- 5 个 commit 可能只是 2-3 轮对话（1 轮 = 1 assistant + 1-2 tool results）
- 保护窗口太窄，高价值的长工具输出可能在 3 轮后就被压缩

**P4（轻微）：`genericCompressToolOutput` 压缩后的最大长度 `maxToolOutputTokens * 4 * 2` 可能不比原始短**
```typescript
const maxChars = this.maxToolOutputTokens * 4 * 2; // 压缩后仍可较大
if (content.length <= maxChars) return content;
```
默认 maxToolOutputTokens=500 → maxChars=4000。如果原 tool 输出 5000 chars，压缩后 4000 chars，只省了 20%。对大输出效果不足。

### 2.2 budget.ts

**优点**：
- 5 桶模型（fixed/session/retrieval/tools/dynamic）设计合理
- TokenEstimator 注入点分离，字符启发式作为保守下界（CJK/英文分别估算）
- `setTokenEstimator` 允许调用方注入真实 tokenizer

**问题**：

**P2（中等）：EVICTION_ORDER 的优先级在 `evictionPriority()` 函数中映射，但映射逻辑与 EVICTION_ORDER 的声明不完全一致**
- `type: "file"` → 映射到 `"active-code"`（priority 5），但 EVICTION_ORDER 中 active-code 标注「绝不扔」
- 而 `isProtected` 函数不保护 file 类型条目（只保护 high importance / tool_output / 带 toolCalls 的）
- 结果：active-code 声明「绝不扔」但实际上可以被驱逐（如果 importance 不是 high）

**建议**：要么 `isProtected` 加上 `e.type === "file"` 保护，要么 `evictionPriority` 给 file 类型更高优先级。

### 2.3 types.ts / explorer.ts / pointer.ts / skill-resolver.ts

- **types.ts**：自洽集中，最小类型，无外部依赖 ✅
- **explorer.ts**：零依赖正则符号扫描，够用但粗糙。`extractSymbols` 无法区分 export const 和 const、无法处理多行声明、装饰器语法等
- **pointer.ts**：PointerRegistry 功能完整（register/expand/compress/deduplicate/findByFile），但 `deduplicate` 的 50% 文件重叠阈值偏粗糙
- **skill-resolver.ts**：纯函数确定性解析 ✅，frontmatter + 文件名推导双保险，缺失目录优雅降级 ✅

### 2.4 app/src/main.ts（Electron 主进程）

**优点**：
- 无框深色主题，IPC 接口完整（ctx:init/loadTask/focus/forget/reflect/autoManage/appendTool/appendMessage/setTaskContext/getEntries/getLog/reset）
- electron-updater 可选依赖，动态 import 避免硬依赖
- 自动 remember/recall 集成在 appendMessage 中

**问题**：

**P2（中等）：`serializeEntries` 的 token 估算用 `length/4`，未复用 BudgetManager.estimateTokens**
```typescript
tokens: Math.ceil((msg.content ?? "").length / 4),
```
- 这与 BudgetManager 的 CJK-aware 估算不一致，UI 显示的 token 数会与引擎内部计算不一致

**P3（轻微）：recall 的查询构造过于粗糙**
```typescript
const hits = m.recall(content.slice(0, 100) + " " + content.replace(/[，。！？、\n]/g, " ")
  .split(/\s+/).filter(w => w.length >= 2 && w.length <= 10).slice(0, 5).join(" "));
```
- 把前 100 字符 + 前 5 个 2-10 字符的词拼成一个超长查询字符串做 `includes` 匹配
- 这种查询几乎不会命中——recall 是子串包含匹配，超长查询意味着需要 content 完全包含这个超长拼接串
- 应该分别对每个词做 recall，取并集

### 2.5 测试覆盖

| 测试文件 | 测试数 | 覆盖面 |
|---|---|---|
| engine.test.ts | 10 | 主动管理 / autoManage / 任务相关性驱逐 / 注意力审计 |
| context.test.ts | 22 | I-Context / D-Context / commit/branch/merge/checkout/revert/squash |
| manager.test.ts | 6 | ContextManager 基础操作 |
| skill-resolver.test.ts | 5 | 技能解析 |
| summarize.test.ts | 3 | LLM 摘要器 |
| tokenizer.test.ts | 4 | Token 估算 |
| budget.test.ts | 3 | 预算桶 |
| cache.test.ts | 3 | prompt caching |
| **合计** | **56** | — |

**缺口**：
- 无 `pointer.ts` 专项测试
- 无 `explorer.ts` 专项测试
- 无 `preprocessToolOutput` 专项测试（只在 engine.test.ts 间接覆盖）
- 无 IPC 层测试（main.ts 的 13 个 handler）
- 无边界条件测试（空 D-Context、超长单条、循环 merge 等）

---

## 3. PDR 落实评估

### 3.1 PDR_PHASE0_1（Phase 0-1 上下文引擎改造）

| 项 | 状态 | 备注 |
|---|---|---|
| P0-1 manage() 重构 | ✅ 已实现 | 三级主动策略 + 移除 hard limit |
| P0-2 工具结果预处理 | ✅ 已实现 | 截噪声/去HTML/去重 |
| P0-3 cache 感知布局 | ✅ 已实现 | I-Context prompt caching 断点 |
| P1-1 框架接管六原语 | ✅ 已实现 | autoManage 主动接管 |
| P1-2 remember/recall 自动触发 | ✅ 已实现 | autoRememberFromContent + loadTask 自动 recall |
| P1-3 任务相关性驱逐 | ✅ 已实现 | evictionScore 接入 TaskContext |
| P1-4 清死代码 | ✅ 已实现 | EVICTION_ORDER 复核 + evictionPriority 映射 |

Phase 0-1 **全部完成**。

### 3.2 PDR_CONTEXT_ENGINE（M1-M6）

| 项 | 状态 | 备注 |
|---|---|---|
| M1 工具裁剪 | ⚠️ N/A | 原 `dynamic-prompt.ts` 已随 `packages/agent` 删除 |
| M2 技能仓库 | ✅ 已实现 | SkillResolver + 3 个技能 markdown |
| M3 RLVR 验证 | ❌ 未实现 | 无验证层代码 |
| M4 事件流 | ✅ 部分 | `appendObservation` 已实现，但无 `tool:after` 事件钩子 |
| M5 阶段标准 | ❌ 未实现 | 无 ExitChecklist / 阶段推进逻辑 |
| M6 ask_user | ❌ 未实现 | 无 ask_user 工具 |

### 3.3 CONTEXT_API_DESIGN.md（标准 API）

- `ContextSession` 接口已定义但**未实现为独立抽象**——当前 ContextManager 兼任此角色
- 三种边缘接入方案（Proxy/MCP/Hooks）仅文档，无代码实现
- 这属于 Phase 2-4 的范围，当前不实现合理

---

## 4. 关键缺口与改进建议

### 缺口 A（严重）：recall 太弱，记忆系统形同虚设

`recall` 是纯 `includes` 子串匹配：
```typescript
recall(query: string, limit = 3) {
  const q = query.toLowerCase();
  return this.memoryStore
    .filter(m => m.content.toLowerCase().includes(q) || m.tags.some(t => t.toLowerCase().includes(q)))
    .slice(-limit)
}
```
- 无分词、无语义、无相关性排序
- 查询超长时几乎不会命中（见 §2.4 P3）
- memoryStore 是纯内存数组，无持久化，会话结束即丢失
- `remember` 无去重、无冲突检测

**影响**：双支柱中「优雅上下文」的记忆维度无法兑现。模型记住的决策，recall 不出来 = 没记住。

**建议**：
1. 短期：recall 改为分词后逐词匹配，取命中次数排序
2. 中期：接入 SQLite + FTS5（context 包已声明 `IMemoryProvider` 接口，实现它）
3. 长期：向量检索（context 包的 `RetrievedMemory` 已有 `relevance` 字段预留）

### 缺口 B（严重）：M3/M5/M6 未实现，双支柱缺一条腿

双支柱之「更高正确率」依赖 M3（RLVR 验证闭环）+ M5（阶段成功标准）+ M4（事件流完整）。当前：
- M3 完全未实现——没有 tsc/lint/test 自动验证
- M5 完全未实现——无阶段推进逻辑
- M4 部分实现——`appendObservation` 有，但无 `tool:after` 钩子自动生成 observation

**影响**：产品卖点只有一条腿（优雅上下文），「更高正确率」是空话。

**建议**：
- 如果定位是纯上下文中间件（不碰 Agent 执行层），则 M3/M5 可以是「推荐给上层框架去做」的指导文档
- 如果要兑现双支柱承诺，至少需要一个最小可用的验证层（tsc + lint）作为 context 包的可选模块

### 缺口 C（中等）：Electron app 是 demo 还是产品？

当前 `packages/app` 是一个上下文引擎控制台（可视化 focus/forget/reflect/autoManage），但：
- 无实际 Agent 对接（main.ts 只有 IPC handler，无 LLM 调用循环）
- 无文件编辑能力（focus 只读，不能写）
- UI 是静态 HTML（无 React/Vue 框架）

**定位问题**：作为上下文中间件的演示工具价值有，但作为产品交付不够。

### 缺口 D（中等）：开源就绪度

- ✅ LICENSE (Apache 2.0)、CONTRIBUTING.md、CHANGELOG.md、README.md 已创建
- ❌ 目录名 `SrcuctAgent` 拼写错误（历史遗留）
- ❌ root package.json 的 description 字段乱码（GBK 编码问题）
- ❌ `.codebuddy/`、`.workbuddy/` 目录仍在（应清理）
- ❌ 多个 PDR/DESIGN 文档在根目录，应归入 `docs/` 子目录
- ❌ 无 CI/CD 配置（.github/workflows 为空？）

---

## 5. 评分明细

| 维度 | 得分 | 满分 | 备注 |
|---|---|---|---|
| 架构设计 | 8.5 | 10 | 哈佛架构 + 主动管理 + 版本化，设计优秀 |
| 代码质量 | 7.5 | 10 | 核心逻辑正确，但 autoManage 快照 bug、recall 太弱 |
| 测试覆盖 | 6.5 | 10 | 56 测试覆盖核心路径，但缺 pointer/explorer/IPC/边界测试 |
| PDR 落实 | 7.0 | 10 | Phase 0-1 全完成，M 系列只完成 2/6 |
| 产品完整度 | 6.0 | 10 | Electron demo 级，无实际 Agent 对接 |
| 开源就绪 | 6.5 | 10 | 基础文件有，但目录名/乱码/文档组织有问题 |
| 战略清晰度 | 9.0 | 10 | 双支柱 + 六 Phase 路线清晰，定位准确 |
| **加权总分** | **7.8** | **10** | — |

---

## 6. 建议优先级

### P0（阻断性）
1. 修复 autoManage 的 budgetPct 快照 bug
2. 修复 recall 查询逻辑（分词 + 逐词匹配）
3. 修复 root package.json 乱码 + 目录名拼写

### P1（核心价值）
4. 实现最小 M3（tsc + lint 验证层，可选模块）
5. 补充 pointer/explorer/preprocessToolOutput 测试
6. 整理文档结构（PDR/DESIGN → docs/ 子目录）

### P2（提升性）
7. evictionScore taskRelevance 分级化
8. serializeEntries 复用 BudgetManager.estimateTokens
9. EVICTION_ORDER 与 isProtected 一致性修复
10. 开源 CI/CD（GitHub Actions: lint + test + build）

### P3（远期）
11. CONTEXT_API_DESIGN 的 MCP Server 接入方案实现
12. recall → SQLite FTS5 / 向量检索
13. M5 阶段标准 + M6 ask_user

---

## 7. 总结

StructAgent v5 完成了从「完整 Agent 平台」到「上下文中间件」的战略转向，核心引擎（哈佛架构 + 主动注意力管理 + 任务相关性驱逐 + 注意力审计）实现扎实，Phase 0-1 改造全部落实。这是**正确的方向**——在 Agent 平台红海中，做所有 Agent 都需要的上下文层，差异化更清晰。

但作为「可交付产品」，仍有三个关键缺口：
1. **recall 太弱**——记忆系统形同虚设，双支柱之一的核心能力不达标
2. **M3/M5 未实现**——双支柱之「更高正确率」是空话
3. **开源就绪度不足**——目录名、乱码、文档组织

**当前评分 7.8/10**。如果能修复 P0 三个阻断 bug + 实现 M3 最小验证层 + 开源清理，可到 **8.5/10**。再补齐 MCP 接入和测试覆盖，可冲 **9.0+**。

核心引擎做得好，差在「让引擎兑现承诺」的最后一公里。
