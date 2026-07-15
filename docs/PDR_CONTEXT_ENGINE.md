# PDR：StructAgent 上下文引擎增强（设计思想萃取 + 能力补齐）

| 字段 | 值 |
|---|---|
| 文档版本 | v0.2.0-draft |
| 日期 | 2026-07-15 |
| 状态 | 待评审（Draft） |
| 主线 | 上下文管理（I-Context / D-Context / 六原语 / budget / eviction） |
| 思想来源 | StructAICoding 的优雅设计思想（已萃取，非搬运） |
| 关联文档 | `SKILL_SYSTEM_MIGRATION.md`（思想萃取稿）、`DESIGN_CRITIQUE.md` |

---

## 1. 背景与目标

StructAgent 的本质是一个**上下文引擎**：`InstructionContext`（I-Context，稳定可缓存）与 `DataContext`（D-Context，Git 版本化对话）分离，六原语（focus/forget/reflect/remember/recall）做注意力调度，`budget.ts` 控制 125000 token 上限，`manager.ts` 做 `evictLowValue` / `evictionScore` 淘汰。

在审视旧项目 StructAICoding 后，萃取了其中与「上下文」同构的四条优雅设计思想（M1–M5 的思绪来源）。本 PDR 将这四条思想落定为 StructAgent 的**上下文修改项**，并补充一项当前缺失的基础能力（M6，非萃取自 StructAICoding）。目标是：

1. 上下文**按需汇编**而非全量注入（省 token、提信噪比）—— 主要由 **M2 技能仓库**（按阶段注入技能文档，取代静态全量系统提示）实现；工具集保持全量（见 M1 实证约束）；
2. 正确性由**确定性工具**保证，模型自评不可信—— M3；
3. 每次动作留下**机读事件**，喂回上下文与审计—— M4；
4. 阶段推进由**结构化标准**驱动，而非软提示—— M5；
5. 需求**有歧义时主动问清楚**，不硬猜—— M6（能力补齐，非萃取）。

> 本 PDR **不引入** StructAICoding 的平台复杂度（多 Agent 编排、PDR/SkillHub、Electron 后端栈、跨服务合同管道）。详见 §5。M2 的技能仓库是 StructAgent 仓库内的静态 markdown 集合，与 StructAICoding 的 SkillHub（运行时技术栈自动匹配 + 文档导出层）无关，后者不搬。

---

## 2. 范围

### 2.1 In Scope（本次修改项）

| 编号 | 修改项 | 对应思想 / 来源 |
|---|---|---|
| M1 | 工具裁剪机制完善（保持 opt-in，不默认启用） | 思想一的一半：工具视野可裁剪，但尊重实证约束（§1.4 少而精） |
| M2 | Skills 机制（SkillResolver + 技能仓库） | 思想一的另一半：按阶段动态汇编技能文档 |
| M3 | 确定性验证层（RLVR 内循环） | 思想二：验证交给确定性工具，不由模型自证 |
| M4 | 结构化事件流接入上下文 | 思想三：动作机读记录，喂回 D-Context 与审计 |
| M5 | 阶段成功标准结构化 | 思想四：框架定义「什么算够」，非软提示 |
| M6 | `ask_user` 工具：主动澄清 | 能力补齐（非 StructAICoding 萃取） |

### 2.2 Out of Scope（明确不做）

见 §5。

---

## 3. 设计修改项

### M1：工具裁剪机制完善（保持 opt-in，不默认启用）

**问题陈述**
`dynamic-prompt.ts` 已提供 `filterToolsByPhase`（L160）作为 opt-in 工具裁剪，但模块头注释（L7-11）与 `PHASE_PROMPTS` 注释（L38-39）明确记载**实证结论**：默认 explore 阶段若裁剪掉 `file_write`/`file_edit`，模型无法写文件、表现「很傻」。`toolFiltering` 配置（L34）默认 `"all"`，注释（L30-32）要求默认全量暴露。因此「默认启用裁剪」会与现有设计直接冲突，且会退化真实表现——这不是偏好分歧，是已有教训。

**设计思想来源**
StructAICoding 的 SkillResolver 四层分层中「按角色/阶段精准投放」的**工具视野**一半。但萃取时必须尊重 StructAgent 已有的实证约束：裁剪是「可选能力」，不是「默认行为」。

**方案**
1. **不改动默认行为**：`toolFiltering` 维持 `"all"`，全量工具（读/写/执行/验证）在任意阶段可见——守住 L7-11、L38-39 的铁律，避免模型退化。
2. **完善 opt-in 裁剪的安全集**：评审 `PHASE_TOOLS`（L130）与 `ALWAYS_AVAILABLE`（L145），确保受限场景下裁剪不误伤跨阶段必需工具；当前 `ALWAYS_AVAILABLE` 未含写工具，正常模式裁剪会伤模型——这正是默认不裁剪的原因。
3. **明确适用场景**：在 `DynamicPromptConfig` 注释中写明——裁剪仅用于受限沙箱 / 只读审计等显式场景，由调用方传入裁剪后 schema 触发，非默认。
4. 「工具为 LLM 优化（少而精）」的更高杠杆在 DESIGN_CRITIQUE §1.4 的**工具整体设计**（减 / 重设工具集），不在阶段裁剪；本 PDR 不改动工具集本身。

**落点文件与符号（已核实）**
- `packages/agent/src/agent/dynamic-prompt.ts`：`filterToolsByPhase` L160、`PHASE_TOOLS` L130、`ALWAYS_AVAILABLE` L145、`toolFiltering` 配置 L34、模块头注释 L7-11
- `packages/harness/src/tools/defs.ts`：`ALL_TOOLS` L58（默认全量传入，裁剪作用对象）

**验收标准**
- [ ] `toolFiltering` 默认仍为 `"all"`，全量工具任意阶段可见（不退化模型表现）；
- [ ] `PHASE_TOOLS` / `ALWAYS_AVAILABLE` 经评审，受限场景裁剪不误伤必需工具；
- [ ] opt-in 裁剪的适用场景（受限沙箱 / 只读审计）在配置注释中明确，不误导为默认行为。

**风险**
- 若误将默认改为裁剪，模型在 explore 看不到写工具会退化——已有实证教训，严禁翻转默认。

---

### M2：Skills 机制（SkillResolver + 技能仓库）

**问题陈述**
当前 I-Context 是静态系统提示 + 五阶段 `PHASE_PROMPTS`（`dynamic-prompt.ts` L40）软引导，没有「技能仓库」概念。模型在 explore 阶段需要代码搜索指引、在 execute 阶段需要质量规约、在 verify 阶段需要测试指引——但这些「技能文档」要么全量塞入，要么没有。这与思想一「上下文应按阶段动态汇编」相悖：知道要分阶段，却没有可被阶段检索的技能载体。

**设计思想来源**
StructAICoding 的 `skill-resolver.ts` 四层 Skill 分层（`AGENT_OUTPUT_SKILL` / `AGENT_QUALITY_SKILLS` / `TECH_TO_SKILL` / `AGENT_DOC_SKILLS`）：框架按角色持有技能仓库，动态解析并注入相关技能文档到上下文，而非模型自选加载。萃取为「**框架按阶段持有技能仓库，确定性解析并注入相关技能文档到 I-Context**」。**不引入 SkillHub 技术栈自动匹配**（那是平台层产品逻辑，见 §5）。

**方案**
1. 新增 `skill-resolver.ts`（`packages/context/src/`）：定义
   - `SkillDef { id: string; category: "quality" | "search" | "test" | "convention"; phases: TaskPhase[]; content: string }`
   - `SkillResolver.resolve(phase: TaskPhase, signals?): SkillDef[]`：按阶段 + 任务信号（如检测到 TS 项目 → 注入 TS 约定技能）解析应注入的技能文档。确定性逻辑，不调 LLM。
2. 新增技能仓库：`packages/context/src/skills/*.md`（静态 markdown，目录当前不存在，需新建），初始最小集：
   - `explore.search.md`：代码搜索 / 符号定位指引；
   - `execute.quality.md`：编辑质量规约（命名、错误处理、不引入未用导入）；
   - `verify.test.md`：测试与验证指引。
3. 阶段切换时（由 M5 的 `exitChecklist` 通过后），调用 `SkillResolver.resolve(phase)` → 注入 I-Context（复用 `InstructionContext` L97 的增删机制）；阶段结束移出，无残留。
4. 技能文档是静态 markdown，`SkillResolver` 为纯函数式解析——与 M1 的工具裁剪互补：M1 管「有哪些工具」，M2 管「有哪些知识」。

**落点文件与符号（已核实）**
- 新增 `packages/context/src/skill-resolver.ts`（新模块）
- 新增 `packages/context/src/skills/*.md`（技能文档仓库，目录当前不存在，需新建）
- `packages/agent/src/agent/dynamic-prompt.ts`：`TaskPhase` L15、`PHASE_PROMPTS` L40（阶段切换触发解析）
- `packages/context/src/manager.ts`：`InstructionContext` L97（注入 / 移出技能文档）

**验收标准**
- [ ] 存在 `SkillResolver` 模块，按 `TaskPhase` 解析技能文档；
- [ ] 不同阶段 I-Context 中技能文档集合不同，阶段结束无残留；
- [ ] 技能仓库为静态 markdown，`SkillResolver` 确定性注入，不调用 LLM；
- [ ] 初始最小集（search / quality / test）覆盖 explore / execute / verify 三阶段。

**风险**
- 技能文档需持续维护；初始仅最小集，按实测扩展。若技能文档过多，其体积计入 budget，需设上限（参考 `budget.ts` L19 截断策略）。

---

### M3：确定性验证层（RLVR 内循环）

**问题陈述**
模型编辑代码后，正确性依赖模型自评（「我改好了」），无框架层硬验证。这与 DESIGN_CRITIQUE §2.2 的 RLVR 内循环同源——但当前未落地。

**设计思想来源**
StructAICoding 的 `.d.ts` 合同 + Compliance Checker 三步管道（`tsc --noEmit` → grep 禁止模式 → `@test` 执行），全程不调 LLM。萃取为「**验证用确定性工具，不由模型自证**」。**不引入 `.d.ts` 合同体系**（那是多 Agent 接口约束，单 Agent 下过度设计）。

**方案**
1. 在 `harness.ts` 的编辑类工具（`file_write` / `file_edit`）执行成功后，由**框架层**（非模型）自动触发校验：
   - TS 项目：`tsc --noEmit`；
   - 通用：`lint` + 相关 `test` 命令（由项目配置决定）。
2. 校验结果作为一条 observation **写回 D-Context**（经 M4 建立的 observation 通道），驱动下一轮推理（失败 → 自动分析 → 自动修复 → 再验证）。
3. 校验失败不阻断，但作为高优先级 observation 进入窗口。

**落点文件与符号（已核实）**
- `packages/harness/src/harness.ts`：`execTransaction` L266、`runTransaction` L300（编辑类工具执行后挂校验钩子）
- `packages/context/src/manager.ts`：`DataContext` L159（写入校验 observation）
- `packages/context/src/budget.ts`：`TOTAL_BUDGET` L19、`FIXED_OVERHEAD` L20（校验输出计入预算，需设上限截断）

**验收标准**
- [ ] 编辑类工具执行后自动跑 tsc / lint / test（可配置开关）；
- [ ] 校验失败结果以结构化 observation 进入 D-Context，且模型下一轮能据此修正；
- [ ] 校验输出超过预算阈值时截断，不撑爆窗口。

**风险 / 范围限定**
- `tsc --noEmit` 仅对 TS 项目有效；非 TS 项目退化为 lint / test。这属 DESIGN_CRITIQUE §2.2 已标注的「框架层可行性」边界，不在此 PDR 内强行泛化。

---

### M4：结构化事件流接入上下文

**问题陈述**
模型在 D-Context 中看到的「动作」多为自身复述（「我做了 X」），缺少机读、可审计的真实事件。无法支撑 `manager.ts` 的精准淘汰与事后审计。

**设计思想来源**
StructAICoding 的 `struct-dev-log`：每条操作写一条 JSONL，字段含自检结果，由框架消费，无需 LLM 审查。萃取为「**动作机读记录，喂回上下文与审计**」。**不新建 `dev-logger.ts`**——复用现有事件发射器。

**方案**
1. StructAgent 已有 `events: EventBus<StructAgentEvents>`（`struct-agent.ts` L153 / L203），且 `tool:before`(L799) / `tool:after`(L803 / L909) 已携带结构化载荷（工具名、参数、成败、输出片段）。
2. 新增一个**框架层订阅者**：监听 `tool:after` 等事件，将结构化载荷转为一条 D-Context observation（含工具名、影响文件、成败、关键输出摘要），供模型与淘汰决策共用。同时作为 M3 校验结果的 observation 通道。
3. 同一事件流同时驱动 `manager.ts` 的 `evictionScore`（L1069） / `evictLowValue`（L862）审计依据——高价值动作（如成功编译）降低淘汰优先级。

**落点文件与符号（已核实）**
- `packages/agent/src/agent/struct-agent.ts`：`events` L153 / L203、`tool:before` L799、`tool:after` L803 / L909
- `packages/context/src/manager.ts`：`evictionScore` L1069、`evictLowValue` L862、`ContextManager` L437

**验收标准**
- [ ] 每次工具执行后，D-Context 中出现一条结构化 observation（非模型复述）；
- [ ] 同一事件流可被 `evictionScore` 消费，影响淘汰排序；且 M3 校验结果经此通道进入 D-Context；
- [ ] 事件载荷结构稳定（工具名 / 影响文件 / 成败 / 摘要），可作为审计溯源。

**风险**
- 事件频率高时 observation 体积膨胀。需对 `tool:after` 输出摘要做截断（现有 L909 已 `slice(0,500)`，保持该上限）。

---

### M5：阶段成功标准结构化

**问题陈述**
五阶段（explore → plan → execute → verify → summarize）的切换依赖模型自觉，无框架层可校验的「退出条件」。`PHASE_PROMPTS` 是愿望式引导，不是契约。

**设计思想来源**
StructAICoding 的 `PhaseDefinition`（`reviewChecklist` / `maxRetries` / `onPass` / `onFail`）。萃取为「**阶段退出由结构化 checklist 驱动**」。**不引入独立 `reviewerType` Agent**——单 Agent 下评审在 verify 阶段由同一引擎完成。

**方案**
1. 为五个 `TaskPhase` 各定义一份 `exitChecklist: string[]`（如 explore 退出需「相关文件已识别、依赖图已理解」）。
2. 在阶段切换前，框架对当前阶段输出做 checklist 校验：
   - 通过 → 切换，并触发 **M2** 的 `SkillResolver.resolve(nextPhase)` 注入下一阶段技能文档；
   - 不通过 → 停留当前阶段并注入「未满足项」observation，最多 `maxRetries` 次；
   - 超限 → 升级人工。
3. checklist 校验为结构性检查（关键词 / 字段存在性），不依赖 LLM 判断「质量」。

**落点文件与符号（已核实）**
- `packages/agent/src/agent/struct-agent.ts`：阶段切换逻辑（参考 `step:start` L344 / `step:end` L431 的事件驱动）
- `packages/agent/src/agent/dynamic-prompt.ts`：`PHASE_PROMPTS` L40、`TaskPhase` L15

**验收标准**
- [ ] 每个 `TaskPhase` 有对应的 `exitChecklist`；
- [ ] 阶段切换前框架执行 checklist，未通过不切换；通过后触发 M2 技能文档注入；
- [ ] 超限后明确升级人工，不静默卡死。

**风险**
- checklist 过严会拖慢任务。初始阈值宜宽松，按实测调参。

---

### M6：`ask_user` 工具——主动澄清能力

**问题陈述**
能力审计确认：agent 逻辑中 grep `clarif` / `unclear` / `ambiguous` / `askUser` **0 命中**；22 个工具（`defs.ts`）全是 fs / shell / git / analysis / verify / context / memory，**无任何「提问 / 确认」类工具**；主循环（`struct-agent.ts` L349-438）无「模型输出疑问 → 暂停等用户输入」分支；plan 阶段提示只说「小任务直接做」，未教模型在歧义时停下来问。结果是：需求有歧义或关键信息缺失时，agent 要么硬猜着做，要么卡在 loop-detector 里，不符合「不确定时主动问清楚」的基本要求。

**设计思想来源**
非来自 StructAICoding（其 SkillResolver 也不含澄清），而是补齐 StructAgent 缺失的基础能力——与「框架层主动管理」哲学一致：把「何时该问」交给明确的工具 + 指令，而非模型自觉。

**方案**
1. 新增 `ask_user` 工具（`packages/harness/src/tools/defs.ts`）：注册一个 `ASK_TOOLS` 常量并并入 `ALL_TOOLS`（L58） / `TOOL_MAP`（L71）。参数：`{ question: string; options?: string[] }`，返回用户输入。
2. 在主循环（`struct-agent.ts` L349-438）增加分支：当模型调用 `ask_user`，**暂停 agent 循环**，通过 CLI `readline`（已有）或 UI 输入通道收集用户回答，将回答作为一条 user-role observation 注入 D-Context 后恢复循环。该暂停不计入 loop-detector 的 `paused` 卡死判定。
3. 在 plan 阶段指令（`PHASE_PROMPTS` L40 的 plan 段）明确：「需求有歧义、关键信息缺失或存在多种合理实现路径时，调用 `ask_user` 暂停澄清，不要硬猜」。
4. `ask_user` 走权限矩阵的 `read` 类（无需写 / 删审批），但应在 I-Context 标注「此工具会阻塞等待用户」。

**落点文件与符号（已核实）**
- `packages/harness/src/tools/defs.ts`：`ALL_TOOLS` L58、`TOOL_MAP` L71（新增 `ask_user` 注册点）
- `packages/agent/src/agent/struct-agent.ts`：主循环 L349-438（新增暂停 / 恢复分支）、`events` L153 / L203（可选发 `ask:pending` 事件）
- `packages/agent/src/agent/dynamic-prompt.ts`：`PHASE_PROMPTS` L40（plan 阶段指令补充）

**验收标准**
- [ ] 存在 `ask_user` 工具，模型可在任意阶段调用；
- [ ] 调用后 agent 循环暂停并等待用户输入，输入作为 user-role observation 进入 D-Context 后恢复；
- [ ] plan 阶段指令明确要求歧义时调用 `ask_user`，硬猜行为减少（可对比歧义任务的前后表现）；
- [ ] `ask_user` 暂停不触发 loop-detector 的卡死升级。

**风险**
- 过度提问会拖慢交互。可在指令中限定「仅在歧义 / 缺失时提问，且单次最多 N 个」，并设会话级提问上限。

---

## 4. 实施阶段

| 阶段 | 修改项 | 依赖 | 说明 |
|---|---|---|---|
| Phase A | M1 + M2 + M5 | 无 | 上下文汇编三件套：工具裁剪完善为 opt-in（M1，不改默认）+ SkillResolver 与技能仓库（M2）+ exitChecklist（M5）。纯框架层改动，不触碰 LLM 调用。M5 的切换成功触发 M2 技能注入。 |
| Phase B | M4 | 无 | 接入现有 `events: EventBus`，新增框架层订阅者写 D-Context observation，并建立 M3 的 observation 通道。 |
| Phase C | M3 | M4 | 在 `harness.ts` 编辑类工具后挂确定性校验钩子，结果经 M4 通道写回 D-Context。 |
| Phase D | M6 | 无 | 新增 `ask_user` 工具 + 主循环暂停 / 恢复分支。独立于上下文改动，可先行。 |

> 优先级：M1 / M2 / M5 成本最低、收益直接（省 token + 阶段可控 + 知识按需注入），先行；M4 复用现有事件基础设施，次之；M3 需接外部工具（tsc / lint / test），再次；M6 独立且低风险，可随时插入。

---

## 5. 非目标（明确不搬）

以下均为 StructAICoding 的项目专属复杂度，**不在本 PDR 范围**，避免跑偏：

| 不搬内容 | 原因 |
|---|---|
| 17 个 Agent 编排 / leader-router | StructAgent 是单 Agent；多 Agent 仅 GranularityController（默认关闭 opt-in） |
| PDR / 技术栈 SkillHub 映射体系 | StructAICoding 平台层产品概念，与上下文引擎无关。**M2 的技能仓库是仓库内静态 markdown，非 SkillHub 自动匹配** |
| Electron / Fastify / Drizzle 后端栈 | 运行时选择，非设计思想 |
| 跨服务 `.d.ts` 合同管道整体 | 仅多 Agent 接口约束有意义；单 Agent 下用 M3 的 tsc / lint / test 直跑即可 |
| PDR Changelog / `affected_importers` 依赖级联 | 多服务架构演进机制；其内核（声明受影响范围 + 框架校验）已被 M3 / M4 覆盖 |
| `reviewerType` 跨 Agent 复审调度 | 单 Agent 下评审可由同一引擎在 verify 阶段完成（见 M5） |

---

## 6. 验收总表

| 修改项 | 核心验收点 | 落点文件 |
|---|---|---|
| M1 | 工具裁剪保持 opt-in（默认全量），受限场景安全集经评审 | `dynamic-prompt.ts` L160 / L130 / L145 / L34 / L7-11；`defs.ts` L58 |
| M2 | SkillResolver 按阶段解析静态技能文档并注入 I-Context，无残留 | 新增 `context/src/skill-resolver.ts`；新增 `context/src/skills/*.md`；`manager.ts` L97 |
| M3 | 编辑后框架层自动 tsc / lint / test，结果写回 D-Context | `harness.ts` L266 / L300；`manager.ts` L159 |
| M4 | 现有 `events` 订阅者写结构化 observation，驱动淘汰 / 审计 / M3 通道 | `struct-agent.ts` L153 / L203 / L803；`manager.ts` L1069 / L862 |
| M5 | 五阶段各有 `exitChecklist`，框架校验后切换并触发 M2 注入 | `struct-agent.ts` 阶段切换；`dynamic-prompt.ts` L40 / L15 |
| M6 | `ask_user` 工具 + 主循环暂停 / 恢复，歧义时主动澄清 | `defs.ts` L58 / L71；`struct-agent.ts` L349-438 |

---

> 附：本 PDR 所有文件:行号引用均已对 StructAgent 当前代码核实（grep 核对 `dynamic-prompt.ts`、`harness.ts`、`manager.ts`、`budget.ts`、`struct-agent.ts`、`defs.ts`）。思想萃取来源见 `SKILL_SYSTEM_MIGRATION.md`。新增模块（`skill-resolver.ts`、`skills/*.md`、`ask_user` 工具）为规划落点，实现时再落地。
