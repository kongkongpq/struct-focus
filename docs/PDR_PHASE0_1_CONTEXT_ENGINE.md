# PDR: Phase 0-1 上下文引擎改造

> 目标：激活现有机制，使框架接管注意力管理
> 改动文件：manager.ts / budget.ts / struct-agent.ts
> 工期：10-14 天（单人）

---

## 总览

| # | 文件 | 改什么 | 难度 | 工期 |
|---|---|---|---|---|
| P0-1 | manager.ts | manage() 重构：主动管理替代被动止损 | ⭐⭐ | 2d |
| P0-2 | manager.ts | 工具结果预处理：截噪声、过滤重复 | ⭐ | 1d |
| P0-3 | budget.ts | cache 感知布局：可缓存前缀排布 | ⭐ | 1d |
| P1-1 | struct-agent.ts | 框架接管 focus/forget/reflect（核心） | ⭐⭐⭐ | 3d |
| P1-2 | struct-agent.ts | remember/recall 框架自动触发 | ⭐⭐ | 2d |
| P1-3 | manager.ts | 任务相关性驱逐 | ⭐⭐⭐ | 3d |
| P1-4 | budget.ts | 清死代码：EVICTION_ORDER 复核 | ⭐ | 0.5d |

---

## P0-1: manage() 重构 — 主动管理替代被动止损

**文件：** `packages/context/src/manager.ts` L831-849

### 现状
```
manage(): 软限→compressOldEntries / 硬限→evictLowValue / 始终→truncateLongEntries
```
问题：引擎只在"溢出"时才反应，此时信息已损。

### 改动：引入三级主动策略

```ts
// L831-849 替换为：

manage(): ContextManagementReport {
  const tokensBefore = this.tokens().total;

  // ── 层 0：超过 70% 软限时主动驱逐（不再等硬限爆破） ──
  let evicted = 0;
  if (tokensBefore > this.softLimit * 0.7) {
    evicted = this.evictLowValue(this.softLimit);
  }

  // ── 层 1：超过 85% 时压缩旧工具输出（保留信息，精简体积） ──
  let compressed = 0;
  if (this.tokens().total > this.softLimit * 0.85) {
    compressed = this.compressOldEntries();
  }

  // ── 层 2：硬限最后防线（应极少触发） ──
  let hardEvicted = 0;
  if (this.tokens().total > this.hardLimit) {
    hardEvicted = this.evictLowValue(this.hardLimit);
  }

  // ── 层 3：单条超长截断（始终执行） ──
  const truncated = this.truncateLongEntries();

  return {
    compressed,
    evicted: evicted + hardEvicted,
    truncated,
    tokensBefore,
    tokensAfter: this.tokens().total,
  };
}
```

### 关键变化
1. **70% 就开始驱逐**，不在 100% 才反应
2. **驱逐先于压缩**：扔掉垃圾比压缩信息更省 token
3. **压缩只做 tool 输出**：不改 `compressOldEntries` 逻辑，只改调用时机
4. 硬限保留为最后防线，正常跑应永不触发

### 新增：注意力浪费度量（P0-1 附带）

在 `reflect()` 方法（L757）的返回值中加一个字段：

```ts
// reflect() 返回对象加：
attentionWaste: { unusedTokens: number; unusedRatio: number; topWaster: string | null }
```

实现：遍历当前活跃条目，每条打标记 `metadata.lastReferenced`，在 `reflect()` 时计算窗口内从未被引用的 token 占比。

### 验收
- 125K 预算下同任务峰值 token 下降 ≥15%
- 硬限驱逐触发次数从"每次都触发"变为"几乎不触发"
- reflect() 能报告注意力浪费率

---

## P0-2: 工具结果预处理

**文件：** `packages/context/src/manager.ts` 新增方法

### 现状
工具输出直接原样写入 D-Context。尤其是 shell 输出，几千行日志全进上下文。

### 改动

在 `manager.ts` 加一个工具结果写入前处理管道，挂在 `appendToolResult` 前面或作为其内部第一步。

```ts
// 新增私有方法，在 appendToolResult 内部调用
private preprocessToolOutput(content: string, toolName: string): string {
  // 规则 1：超过 maxToolOutputTokens 的，取头 + 尾 + 错误行
  if (BudgetManager.estimateTokens(content) > this.maxToolOutputTokens) {
    const lines = content.split("\n");
    const head = lines.slice(0, 50).join("\n");
    const errors = lines.filter(l => /\b(error|fail|exception|panic|abort)\b/i.test(l)).join("\n");
    const tail = lines.slice(-30).join("\n");
    content = `${head}\n\n--- [${lines.length - 80} 行已省略] ---\n\n## 错误信息\n${errors || "(无)"}\n\n## 末尾输出\n${tail}`;
  }

  // 规则 2：HTML 输出去掉标签，只留文本和 class/id
  if (/<[a-z][\s\S]*?>/i.test(content) && content.length > 2000) {
    content = content.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, "\n").trim();
  }

  // 规则 3：连续重复行去重（编译输出的重复 warning）
  const lines = content.split("\n");
  const deduped: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < 2 || lines[i] !== lines[i-1] || lines[i] !== lines[i-2]) {
      deduped.push(lines[i]);
    }
  }
  if (deduped.length < lines.length) {
    content = deduped.join("\n") + `\n[${lines.length - deduped.length} 行重复已合并]`;
  }

  return content;
}
```

然后在 `appendToolResult` 中，先调 `preprocessToolOutput` 再写入。

### 验收
- HTML 输出不超 2000 tokens
- 重复 warning 被合并
- 文件路径/错误行号不丢失

---

## P0-3: Cache 感知布局

**文件：** `packages/context/src/budget.ts` + `manager.ts` I-Context 构造处

### 现状
I-Context 和 D-Context 混排，系统 Prompt 没放到最稳定的位置，影响 API 前缀缓存命中率。

### 改动

不改代码逻辑，只改 `toMessages()`（manager.ts）里的消息排布顺序：

```
当前顺序：                                改后顺序：
[system] ← I-Context（固定前缀）          [system] ← 纯 system prompt（稳定，可缓存）
[user]   ← 记忆注入                       [user]   ← 记忆注入（次稳定）
[user]   ← onboarding                     [user]   ← onboarding
[user]   ← 阶段指令                       [user]   ← 阶段指令
[assistant] ← D-Context 条目1              [assistant] ← D-Context 条目1
[user]   ← D-Context 条目2                [user]     ← D-Context 条目2
...                                        ...
```

**关键改动**：确保 system prompt 是 messages[0]，且其内容在任务执行过程中不变（不往里面追加动态指令，动态指令走独立 user 消息）。

具体：`struct-agent.ts` L279 `onboarding` 不拼入 system prompt，而是作为独立 user 消息插在 system 之后。

同时给 system 消息打 cache 断点标记（智谱 GLM 格式 `cache_control: { type: "ephemeral" }`，DeepSeek 自动前缀缓存无需标记）。

### 验收
- system prompt 内容在单次任务中不变
- 智谱接口日志中出现 `cached_tokens > 0`
- 不加额外 token 代价

---

## P1-1: 框架接管 focus/forget/reflect（最核心改动）

**文件：** `packages/agent/src/agent/struct-agent.ts` L525-555

### 现状
```
每步：
  manage()           ← 被动止损（压缩/驱逐/截断）
  budgetPct ≥ 80%?   ← push 提醒，等模型自觉调 focus/forget
  fitToWindow()
  LLM 调用
```

问题：模型不是每次都听提醒。提醒只是"建议"，框架从不强制执行。

### 改动

```ts
// L525-555 区域替换为：

// ★ 框架接管上下文注意力（升级 4，替代原有的纯提醒模式）
const budgetPct = this.contextManager.reflect().budgetPct;

// ── 70%：自动驱逐低价值条目（不等模型反应） ──
if (budgetPct >= 70) {
  const { evicted } = this.contextManager.manage();
  if (evicted > 0) this.logger.debug(`auto-evict: ${evicted} entries, budget ${budgetPct}%`);
}

// ── 85%：框架强制 forget 非焦点文件 + push 提醒 ──
if (budgetPct >= 85) {
  const focused = this.contextManager.reflect().focusedFiles;
  const allFiles = this.contextManager.getAllFocusedFiles(); // 新增方法：列出所有已加载文件
  const toForget = allFiles.filter(f => !focused.includes(f));
  // 只 forget 非焦点文件（焦点文件保持不丢）
  for (const f of toForget.slice(0, 3)) {
    this.contextManager.forgetFile(f);
  }
  this.logger.debug(`auto-forget: ${toForget.length} unfocused files`);
}

// ── 90%：最后一次 push 提醒（最高级警报） ──
if (budgetPct >= 90 && !this.budgetCriticalAlerted) {
  this.budgetCriticalAlerted = true;
  this.contextManager.appendUser(
    `⚠️⚠️ 上下文预算严重不足（${budgetPct}%）。系统已自动卸载非焦点文件。` +
    `请用 focus 仅保留关键文件，或用 forget 手动释放不需要的上下文。`,
  );
} else if (budgetPct < 60) {
  this.budgetAlerted = false;
  this.budgetCriticalAlerted = false;
}

// ── 每 5 步自动 reflect 一次（保持注意力透明度） ──
if (this.stepCount % 5 === 0) {
  const s = this.contextManager.reflect();
  this.contextManager.appendSystem({
    type: "attention_audit",
    content: `[注意力审计 #${this.stepCount}] ${s.total} tokens (${s.budgetPct}%), ${s.entries} 条目, ` +
      `未引用 token 占比: ${s.attentionWaste?.unusedRatio ? Math.round(s.attentionWaste.unusedRatio * 100) + "%" : "N/A"}`,
  });
}
```

### 新增辅助方法

在 `manager.ts` 加：
```ts
/** 列出当前 D-Context 中所有已加载的文件（用于自动 forget 决策） */
getAllFocusedFiles(): string[] {
  const liveEntries = this.branch ? this.data.getEntriesOnBranch(this.branch) : this.data.getEntries();
  const files = new Set<string>();
  for (const e of liveEntries) {
    if (e.type === "file" && e.metadata.file) files.add(e.metadata.file);
  }
  return [...files];
}
```

### 在 ContextEntry metadata 加字段

```ts
// metadata 接口加：
lastReferenced?: number;  // 最后被模型引用的时间戳
```

在 `toMessages()` 构造消息时，对每条被引用条目更新 `lastReferenced = Date.now()`。被引用的判断：当前步的 assistant 消息如果包含/引用了该条目的内容（模糊：该条目在消息中且非最近一条）。

简化实现：`toMessages()` 中，所有非最后一条 assistant 的关联条目更新 `lastReferenced`。

### 验收
- 不调任何上下文工具时，引擎自动驱逐 + 自动 forget
- 80% 预算提醒从"每次任务必触发"变为"极少触发"
- reflect 审计日志出现在每 5 步

---

## P1-2: remember/recall 框架自动触发

**文件：** `packages/agent/src/agent/struct-agent.ts`

### 现状
remember/recall 是模型手动工具，模型不一定主动调。

### 改动 1：自动 remember — 重要决策后

在每次 LLM 返回后、处理 tool_calls 之前，检测是否需要自动 remember：

```ts
// 在 LLM 响应处理处（~L570 附近）加：

// ★ 自动 remember：检测是否包含重要决策信号
const decisionPatterns = [
  /决定采用\s*(.+)/,
  /最终方案[：:]\s*(.+)/,
  /约定[：:]\s*(.+)/,
  /确认使用\s*(.+)/,
  /架构决策[：:]\s*(.+)/,
];
for (const pattern of decisionPatterns) {
  const match = response.content.match(pattern);
  if (match) {
    const decision = match[1].slice(0, 200);
    await this.memory.record({
      kind: "decision",
      content: decision,
      tags: ["auto-remembered", `step-${this.stepCount}`],
      confidence: 0.85,
    });
    this.logger.debug(`auto-remember: "${decision.slice(0, 60)}"`);
    break; // 每步最多记一条，避免记忆膨胀
  }
}
```

### 改动 2：自动 recall — 任务启动时

在 `run()` 方法开始时（任务描述首次进入时），自动搜索相关记忆：

```ts
// 在 run() 入口、构造 I-Context 之前（~L260 附近）加：

if (this.options.enableAutoRecall !== false) {
  const taskHints = this.extractKeywords(task); // 简单提取：前 100 字中的名词/动词
  if (taskHints.length > 0) {
    const hits = await this.memory.searchHybrid(taskHints.join(" "), { limit: 3 });
    if (hits.length > 0) {
      this.contextManager.appendUser(
        `## 自动召回的相关记忆\n${hits.map((h, i) => `${i+1}. [${h.kind}] ${h.content}`).join("\n")}`
      );
      this.logger.debug(`auto-recall: ${hits.length} memories for task`);
    }
  }
}
```

辅助方法 `extractKeywords`：
```ts
private extractKeywords(text: string): string[] {
  // 简单实现：取前 100 字，分词，过滤停用词
  const clean = text.slice(0, 100).replace(/[，。！？、；：""''（）、\n]/g, " ");
  const words = clean.split(/\s+/).filter(w => w.length >= 2 && w.length <= 8);
  return [...new Set(words)].slice(0, 5);
}
```

并在 `StructAgentOptions` 加：
```ts
enableAutoRecall?: boolean; // 默认 true
```

### 验收
- 包含"决定采用 / 最终方案 / 约定" 的 LLM 回复自动触发 remember
- 任务启动时自动 recall，相关记忆注入 I-Context
- 日志可见 `[auto-remember]` / `[auto-recall]`

---

## P1-3: 任务相关性驱逐

**文件：** `packages/context/src/manager.ts` L1133 `evictionScore()`

### 现状
```ts
function evictionScore(entry: ContextEntry): number {
  // 只看：importance / accessCount / lastAccessed / tokens
  // 完全不知道当前子任务在做什么
}
```

问题：一个跟当前任务无关的"高重要性"条目可能赖着不走。

### 改动

在 `manager.ts` 加一个**任务状态上下文**：

```ts
// 新增：任务上下文（由 struct-agent 在每步开始前注入）
interface TaskContext {
  currentFiles: string[];   // 当前正在编辑/关注的文件
  currentSymbols: string[];  // 当前正在修改的函数/类名
  failedTests: string[];     // 最近失败的测试文件
  phase: string;             // 当前阶段
}

let currentTaskContext: TaskContext | null = null;

export function setTaskContext(ctx: TaskContext | null): void {
  currentTaskContext = ctx;
}
```

修改 `evictionScore`：

```ts
function evictionScore(entry: ContextEntry): number {
  const { importance, accessCount, lastAccessed, tokens } = entry.metadata;
  const now = Date.now();

  const impScore = importance === "high" ? 1.0 : importance === "medium" ? 0.5 : 0.1;
  const freqScore = Math.log(accessCount + 1) / Math.log(10);
  const ageMs = now - lastAccessed;
  const recencyScore = Math.exp(-ageMs / (72 * 3600 * 1000));
  const sizeScore = Math.min(tokens / 1000, 1);

  // ★ 任务相关性加成：当前任务关注的文件/符号，强制不驱逐
  let taskRelevance = 0.0;
  if (currentTaskContext) {
    const file = entry.metadata.file ?? "";
    const content = entry.content ?? "";
    const isCurrentFile = currentTaskContext.currentFiles.some(f => file.includes(f) || f.includes(file));
    const hasCurrentSymbol = currentTaskContext.currentSymbols.some(s => content.includes(s));
    if (isCurrentFile || hasCurrentSymbol) {
      taskRelevance = 1.0; // 满分加成，几乎不驱逐
    }
    // 反方向：失败的测试文件，相关工具输出提权（可能是调试关键信息）
    const isFailedTestOutput = currentTaskContext.failedTests.some(f => file.includes(f));
    if (isFailedTestOutput && entry.type === "tool_output") {
      taskRelevance = 0.8;
    }
  }

  return impScore * 0.4 + freqScore * 0.15 + recencyScore * 0.15 - sizeScore * 0.1 + taskRelevance * 0.2;
}
```

在 `struct-agent.ts` 每步开始前注入任务上下文：

```ts
// 在循环体内、manage() 之前：
import { setTaskContext } from "@struct/context";
setTaskContext({
  currentFiles: this.contextManager.reflect().focusedFiles,
  currentSymbols: this.recentSymbols ?? [],  // 需从 LLM 响应中解析，或从文件变更推断
  failedTests: this.lastFailedTests ?? [],
  phase: this.currentPhase,
});
```

### 验收
- 当前编辑文件的条目不会在驱逐中消失
- 无关文件被优先清理
- 日志可见 `taskRelevance=1.0` 保护了关键条目

---

## P1-4: 清死代码

**文件：** `packages/context/src/budget.ts` + `manager.ts`

### 检查清单

| 位置 | 名称 | 状态 |
|------|------|------|
| budget.ts L43 | EVICTION_ORDER | ✅ 已在 evictionPriority() 中引用 |
| manager.ts L17 | EVICTION_PRIORITY | ✅ 正常使用 |
| manager.ts L936 | evictionPriority() 调用 | ✅ 已接入 |
| manager.ts L849 | evictIfNeeded() | ⚠️ 已被 manage() 替代，但仍有外部调用需检查 |

### 改动

1. 搜索 `evictIfNeeded` 的全量引用：
```sh
grep -r "evictIfNeeded" E:\Develop\SrcuctAgent\packages\
```
如果只在 manager.ts 内部使用且无外部调用，标记 `@deprecated` 并保留向后兼容 1 个版本。
如果有外部调用，改为调用 `manage()`。

2. 检查 `EVICTION_ORDER` 中的 6 个优先级是否全部有对应的条目类型映射：
- `old-tool-output` → ✅ tool_output + 旧（已由 compressOldEntries 处理过）
- `expanded-pointers` → ⚠️ pointer 类型的条目是否真的存在？查 `appendPointer` 方法
- `low-relevance-memory` → ✅ memory 类型 + importance=low
- `project-memory` → ✅ message/memory + importance=medium/high
- `active-code` → ✅ file 类型
- `system-prompt` → ✅ instruction 类型

验证：在代码库中搜索 `type.*pointer` 确认 pointer 条目类型是否被使用。

3. 如果 `expanded-pointers` 未被使用，从 EVICTION_ORDER 中移除以避免误导，或加注释 `// 预留：Phase 5 知识胶囊扩展后启用`。

### 验收
- `evictIfNeeded` 不再有新调用
- EVICTION_ORDER 与实际条目类型一一对应
- 废弃项有注释说明

---

## 依赖关系

```
P0-1(2d) ──→ P1-1(3d) ──→ P1-2(2d)
               ↓
P0-2(1d) ──→ P1-3(3d)
P0-3(1d)     P1-4(0.5d) ← 可在任何时候做

关键路径：P0-1 → P1-1 → P1-2 = 7d
并行路径：P0-2 + P0-3 可同时做 = 1d
追加路径：P1-3 = 3d, P1-4 = 0.5d
```

---

## 测试策略

| 测试 | 方法 |
|------|------|
| manage() 分级响应 | 构造 70%/85%/100% 三种 token 占用的测试数据，断言各层触发 |
| 自动 forget | 加载 5 个文件，仅 focus 2 个，模拟 budget=86%，断言非焦点文件被 forget |
| 任务相关性驱逐 | 设置 taskContext.currentFiles=["a.ts"]，驱逐时断言 a.ts 条目未被移除 |
| 自动 remember | 传入含"决定采用 xxx"的 LLM 回复，断言 memory.record 被调用 |
| 注意力浪费度量 | 3 步未引用 → reflect() 断言 attentionWaste.unusedRatio > 0 |

---

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 自动 forget 过于激进，丢了模型需要的东西 | 中 | forget 只移除非焦点文件，焦点文件保留；加上 forget 日志，出问题可回溯 |
| taskContext 注入时机错误（文件变更还未反映到 focusedFiles） | 中 | setTaskContext 放在每步 LLM 调用之后、下一步 manage 之前 |
| 注意力浪费度量不精确（"未引用"判断粗糙） | 高 | 第一版用启发式（非最后一条 assistant），Phase 3 做精确度量 |
| 自动 remember 触发过于频繁 | 中 | 每步最多记一条，tag 带 step 编号方便审计 |

---

## 实施结论（范围收敛）

本 PDR 已落地的实现与原始规划存在**范围收敛**，结论如下：

1. **hard limit 已被移除**：`manage()` 不再是「软限→压缩 / 硬限→驱逐 / 始终→截断」三层被动止损，而是纯主动三层——
   - 70% `softLimit` → 主动 `evictLowValue`
   - 85% → `compressOldEntries`
   - 始终 → `truncateLongEntries`
   
   原有的「层2 硬限最后防线」被动兜底层（PDR 中 `manage(): 软限→compressOldEntries / 硬限→evictLowValue`）已删除，`ContextManager` 构造去除了 `hardLimit` 参数，仅保留 `totalBudget` / `softLimit`。`reflect()` 的 `budgetPct` 改为以 `totalBudget` 为基准重算。

2. **自动接管已内聚进 `ContextManager`（不再依赖模型/harness）**：原 PDR 写在 `struct-agent.ts` 的 P1-1 / P1-2 逻辑（70%/85% 自动 evict / 自动 forget 非焦点文件 / 每 5 步 reflect 审计 / 重要决策自动 remember / 任务启动自动 recall）已整体移入 `packages/context/src/manager.ts`，由 `autoManage()` 承载。引擎变为**自洽中间件**，不再需要模型自觉触发。

3. **包级重构（彻底拆）**：`packages/agent`、`packages/harness`、`packages/framework`、`packages/memory` 整目录删除。原 `framework` 中被 context 实际引用的极小类型/工具内联进 `packages/context/src/types.ts`；原 `memory` 的 `remember/recall` 折叠为 `ContextManager` 内部 `memoryStore`。`pnpm-workspace.yaml` 收紧为仅 `packages/context` 与 `packages/app`。

4. **UI 重接**：Electron 控制台 `packages/app` 的 `main.ts` 不再 `import StructAgent`，改为直接创建并驱动 `ContextManager`，通过 IPC 暴露 `loadTask / focus / forget / reflect / autoManage / appendTool / appendMessage / setTaskContext` 等原语；前端 `ui/index.html` 改为「上下文引擎控制台」（注意力审计 / 条目聚焦 / 驱逐日志三屏）。

5. **验证**：`packages/context` 单测 62 项全过（含引擎分级管理 / 自动 forget / 任务相关性驱逐 / 注意力审计 共 10 项新增）；`context` + `app`（含 preload）独立 `tsc -b` 构建通过，无悬空依赖。

> 注：原 PDR 中 `struct-agent.ts` 的改动文件已随 agent 包删除而失效，相关逻辑以 `ContextManager.autoManage()` + `setTaskContext()` 的形式存在于 context 包内，语义等价。
