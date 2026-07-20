# 设计思想萃取：StructAICoding → StructFocus（上下文主线）

> 本文不是「迁移清单」，而是**思想萃取**。
> 原则：只保留 StructAICoding 中真正优雅的*设计思想*，并以 StructFocus 的主线——**上下文管理**——为锚点重构，不搬项目专属复杂度。
> 凡不能直接服务于「上下文的组装 / 验证 / 审计」的内容，一律剔除。

---

## 0. 取舍原则

StructFocus 的本质是一个**上下文引擎**：I-Context（稳定、可缓存的指令层）与 D-Context（Git 版本化的对话数据）分离，六原语（focus/forget/reflect/remember/recall）做注意力调度，budget.ts 控制 125000 token 上限，manager.ts 做 evictLowValue / evictionScore 淘汰。

StructAICoding 的本质是一个**多 Agent 协作平台**：17 个 Agent、Electron 桌面端、PDR 驱动的架构演进、跨服务合同编排。它的优雅之处不在于「多」，而在于几处*与上下文同构*的思想。

萃取判据：**这条思想能否让 StructFocus 的上下文更准、更省、更可信？** 能，则留；不能，则弃。

### 明确不搬的部分（项目专属复杂度）

| 不搬的内容 | 原因 |
|---|---|
| 17 个 Agent 的编排 / leader-router | StructFocus 是单 Agent 框架，多 Agent 仅 GranularityController 默认关闭的 opt-in |
| PDR / 技术栈 SkillHub 映射体系 | 这是 StructAICoding 平台层的产品概念，与上下文引擎无关 |
| Electron / Fastify / Drizzle 后端栈 | 运行时选择，不是设计思想 |
| 跨服务的 `.d.ts` 合同管道整体 | 仅当开启多 Agent 分解才有意义；单 Agent 下是过度设计 |

---

## 1. 萃取的四个优雅设计思想

### 思想一：上下文的「分阶段动态汇编」——按角色/阶段精准投放，而非全量注入

**来源**：StructAICoding 的 `skill-resolver.ts` 四层 Skill 分层（`AGENT_OUTPUT_SKILL` / `AGENT_QUALITY_SKILLS` / `TECH_TO_SKILL` / `AGENT_DOC_SKILLS`）。核心不是「多一层 Skill」，而是**框架按 Agent 角色决定注入什么内容**，Dev Agent 只看到 4 个工具 + 自己的质量 Skill，绝不见无关上下文。

**为什么优雅**：它把「上下文该有什么」从「模型自己决定加载」变成了「框架在正确的时机主动组装」。这与 StructFocus 已有的 I/D 分离思想同构，但更进一步——不止分层，还**分时机**。

**映射回 StructFocus 上下文**：
- StructFocus 已有 `dynamic-prompt.ts` 的五阶段 `PHASE_PROMPTS`，但注入是「软引导」；可借鉴 SkillResolver，把**阶段专用的 Skill 文档（质量规约、代码搜索指引、测试指引）按 phase 结构化注入 I-Context**，而非一次性全塞。
- `filterToolsByPhase` 在 `dynamic-prompt.ts` 中**已定义但未被 StructFocus 调用**——这正是「分阶段裁剪工具视野」的现成落点，直接接线即可，不需新造。
- 收益直接命中 budget.ts 的 token 上限：无关上下文不进窗口，省下的预算留给 D-Context 的真实对话。

**我们不搬**：SkillHub 的技术栈自动匹配、文档导出 Skill 层——这是平台产品逻辑，与上下文引擎无关。

---

### 思想二：确定性验证层——用编译器/测试做硬验证，模型自评不可信

**来源**：StructAICoding 的 `.d.ts` 合同 + Compliance Checker 三步管道（`tsc --noEmit` → grep 禁止模式 → `@test` 执行），**全程不调用 LLM**。核心洞察：把「实现是否符合契约」交给成熟的确定性工具，而非让模型自己说「我改好了」。

**为什么优雅**：它把「正确性」从概率事件变成确定性事件。验证层的确定性，正是 DESIGN_CRITIQUE §1.1 修正后承认的——「结果是可验证的，确定性在验证层有价值」。

**映射回 StructFocus 上下文**：
- 这是 DESIGN_CRITIQUE 中「RLVR 内循环」的同源思想。在 `Harness.exec` 编辑类工具执行后，由**框架层**（非模型）自动跑 tsc / lint / 相关测试，把结果作为一条 observation **写回 D-Context**，驱动下一轮推理。
- 验证失败 → 自动分析 → 自动修复 → 再验证，这个闭环的输出是结构化事件，天然成为上下文的一部分。
- 此处只需借鉴「**验证用确定性工具、不由模型自证**」这一条，不必引入 `.d.ts` 合同体系（那是为多 Agent 接口设计的）。

**我们不搬**：`.d.ts` 合同文件、`@forbidden/@constraints/@test` 注释头解析、ComplianceChecker 作为独立模块——这些服务于跨 Agent 接口约束，单 Agent 下用 `tsc`/`lint`/`test` 直跑即可。

---

### 思想三：结构化事件流——每次动作机读记录，喂回上下文与审计，不靠 LLM 审查

**来源**：StructAICoding 的 `struct-dev-log`——每条操作（skill_load / file_create / dependency_call / testRun / phase_complete）写一条 JSONL，字段含 `exportsCoverage` / `forbiddenSummary` / `importsCompliance` 等自检结果，由框架消费，无需 LLM 审查代码质量。

**为什么优雅**：它让 Agent「对自己诚实」——隐瞒未实现的导出，`tsc` 会在 Step 1 暴露。本质是**把可观测性变成结构化数据**，而非自然语言总结。

**映射回 StructFocus 上下文**：
- StructFocus 已有事件发射器：`structfocus-agent.ts` L153/L203 声明 `events: EventBus<StructFocusEvents>`，且 `tool:before`(L799)/`tool:after`(L803/L909) 已携带结构化载荷（工具名、参数、成败、输出片段）。优雅的迁移不是新建 `dev-logger.ts`，而是**给现有事件加结构化载荷**，让每次工具调用的结果成为 D-Context 中可机读的 observation，同时作为 `manager.ts` 做 evictionScore / 审计的依据。
- 自检字段（`exportsCoverage` 等）的思想可降级为：在 verify 阶段由框架对照「本阶段声明要改的文件」与「实际改动」做结构化比对——这一比对本就是思想二的验证层。
- 收益：上下文里的 observation 是真实结构化事件，不是模型复述的「我做了 X」，淘汰决策也更精准。

**我们不搬**：独立的 JSONL 日志文件体系、ComplianceChecker 对日志的二次消费管道——直接复用 EventBus + D-Context 即可。

---

### 思想四：阶段性成功标准结构化——框架定义「什么算够」，而非软提示

**来源**：StructAICoding 的 `PhaseDefinition`（`name` / `agentType` / `reviewerType` / `maxRetries` / `reviewChecklist` / `onPassDesc` / `onFailDesc`）。每个阶段有明确的通过标准，框架层自动执行 checklist 校验，失败自动重试。

**为什么优雅**：它把「阶段该产出什么」从提示词里的愿望，变成框架可校验的契约。阶段切换不再靠模型自觉，而靠结构化判据。

**映射回 StructFocus 上下文**：
- StructFocus 的五阶段（explore → plan → execute → verify → summarize）目前是 `PHASE_PROMPTS` 软引导。可给每个 phase 增加**结构化 exit-checklist**，由框架在阶段切换前校验（例如 explore 退出需「相关文件已识别、依赖图已理解」），不通过则停留/重试。
- 这与思想一互补：思想一解决「上下文里*有什么*」，思想四解决「上下文*攒到什么程度*才推进」。
- 校验失败的反馈本身就是一条高质量 observation，回到 D-Context 驱动修正。

**我们不搬**：`reviewerType` 跨 Agent 复审调度——单 Agent 下评审可由同一引擎在 verify 阶段完成，不需独立的 reviewer Agent。

---

## 2. 为什么第五项（PDR Changelog / 依赖级联）不单列

原稿的「迁移 5」是 StructAICoding 增量迭代时的 `affected_importers` 级联检查。它的优雅内核只有一句话：**「增量变更应声明受影响范围，并由框架做结构校验」**。

但这套机制是为「多服务架构演进」设计的——Architect 改一个 service 的返回值，要级联检查所有 importer。在 StructFocus 的上下文主线里，这对应的是「**单次会话内，模型声明要改的文件 vs 实际改动**」的比对，而这已经由思想二（确定性验证层）和思想三（结构化事件流）覆盖了。因此不单独成项，避免引入 PDR / 版本化架构的平台概念。

---

## 3. 整合到 StructFocus 上下文引擎的最小方向（概念级）

四个思想落到 StructFocus 现有结构上，均为**扩展而非新建**，且都围绕上下文：

| 思想 | 落点（现有文件） | 最小动作 |
|---|---|---|
| 一：分阶段动态汇编 | `packages/agent/src/agent/dynamic-prompt.ts` | 接线已存在的 `filterToolsByPhase`；按 phase 向 I-Context 注入阶段专用 Skill 文档 |
| 二：确定性验证层 | `packages/harness/src/harness.ts` | 编辑类工具执行后，框架层跑 tsc/lint/test，结果写回 D-Context 作为 observation（RLVR 内循环） |
| 三：结构化事件流 | `packages/harness/src/harness.ts` EventBus | 给现有事件加结构化载荷，作为 `manager.ts` evictionScore / 审计依据 |
| 四：阶段成功标准 | `packages/agent/src/agent/structfocus-agent.ts` | 五阶段各加结构化 exit-checklist，框架层校验后切换 |

四条共同指向一个结论：**StructFocus 的上下文应由框架在正确时机主动组装与校验，而非依赖模型自觉。** 这与 DESIGN_CRITIQUE 的「框架层应主动管理上下文」完全同构。

---

## 4. 与 DESIGN_CRITIQUE 论点的呼应

| DESIGN_CRITIQUE 论点 | 本文萃取的思想 |
|---|---|
| §1.1 确定性在验证层有价值 | 思想二：确定性验证层 |
| §1.2 框架层应主动管理上下文 | 思想一、思想四：框架主动汇编与校验 |
| §1.4 工具应为 LLM 优化（少而精） | 思想一：`filterToolsByPhase` 分阶段裁剪视野 |
| §2.2 RLVR 内循环 | 思想二在 harness 层的落地 |
| §1.5 契约核心是可验证接口 | 思想二：用确定性工具替代模型自证（但降级为多 Agent 专属，不强行套用） |

---

## 5. 一句话原则

> 萃取 StructAICoding，只取「**上下文按需汇编、验证交给确定性工具、动作机读可审计、阶段标准结构化**」四则；其余平台复杂度一律不搬——因为 StructFocus 的主场是上下文，不是编排。
