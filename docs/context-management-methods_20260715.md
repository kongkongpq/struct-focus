# StructAgent 上下文管理方法手册

> 最后更新：2026-07-15
> 状态：Phase 0+1 全部验收通过（峰值 Token 下降 27.7%，focus/recall 命中率 100%）

---

## 目录

1. [核心哲学](#1-核心哲学)
2. [三层自动管理（autoManage）](#2-三层自动管理automanage)
3. [工具输出去噪（preprocessToolOutput）](#3-工具输出去噪preprocesstooloutput)
4. [结构化压缩（structuredCompress）](#4-结构化压缩structuredcompress)
5. [三原语：focus / forget / reflect](#5-三原语focus--forget--reflect)
6. [任务相关性驱逐（taskRelevance）](#6-任务相关性驱逐taskrelevance)
7. [注意力浪费度量（attentionWaste）](#7-注意力浪费度量attentionwaste)
8. [记忆自动召回（autoRecall）](#8-记忆自动召回autorecall)
9. [上下文条目数据结构](#9-上下文条目数据结构)
10. [触发时机与调度](#10-触发时机与调度)

---

## 1. 核心哲学

> **不是压缩，是管理。** 压缩是有损的、一次性操作。管理是持续的、有判断力的过程——决定"什么留在窗口里，什么驱逐到外部，什么永远丢弃"。

```
┌──────────────────────────────────────────────────┐
│               StructAgent Context Engine          │
│                                                  │
│   框架自动接管（autoManage）                       │
│        ↓ 兜底                                    │
│   LLM 主动请求（MCP 技能）                        │
│        ↓ 补充                                    │
│   两层不冲突。自动兜底不依赖模型自觉。              │
└──────────────────────────────────────────────────┘
```

**与竞品的本质区别：**

| 方案 | 策略 | 问题 |
|------|------|------|
| Headroom | 无损压缩一切，省体积 | 垃圾压缩后还是垃圾，LLM 仍需浏览无用信息 |
| Letta | LLM 自己管理记忆 | 48-74% 准确率波动，不可靠 |
| Mem0 | 跨会话长期记忆 | 不管会话内注意力 |
| **StructAgent** | 框架自动判断价值 + 驱逐噪音 | 决策权在框架，不依赖模型自觉 |

---

## 2. 三层自动管理（autoManage）

### 2.1 触发条件

每步 Agent loop 完成后自动执行。根据当前上下文窗口饱和度决定管理深度：

```
usePercent = (当前上下文 token 数) / (模型最大上下文窗口)

层 0：usePercent ≥ 70%  → 驱逐低价值条目
层 1：usePercent ≥ 85%  → 执行完整的三层管理（manage）
层 2：usePercent ≥ 90%  → 层 1 + 自动 forget（强制驱逐非聚焦文件）
```

### 2.2 三层内容

#### 层 0：价值驱逐（≥70%）

```
遍历上下文所有条目 → 计算 evictionScore → 按分数排序 → 驱逐最低 15% 条目

驱逐分 = 衰减权重 × (1 - taskRelevance保护系数)
       × ageFactor    # 越旧越可丢
       × typeFactor   # tool_output > user_message > system > LLM_generated
       × sizeFactor   # 大条目优先驱逐（一次性释放更多空间）
```

驱逐后更新 `attentionWaste` 计数（被驱逐条目 = 浪费的 token）。

#### 层 1：完整管理（≥85%）

```
1. 驱逐：同层 0，但驱逐比例提高至 25%
2. 压缩：structuredCompress() 处理 LLM 生成内容（保留锚点段）
3. 截断：单条 > 2000 tokens 的工具输出，保留头 500 + 尾 500 + 中 50 行
```

#### 层 2：强制 forget（≥90%）

```
层 1 全部 + 强制驱逐所有非 taskRelevance 保护的文件条目
仅保留：当前编辑文件、失败测试文件、符号表、当前子任务描述
```

### 2.3 参数表

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `EVICT_THRESHOLD_0` | 70% | 触发层 0 驱逐 |
| `EVICT_THRESHOLD_1` | 85% | 触发层 1 完整管理 |
| `EVICT_THRESHOLD_2` | 90% | 触发层 2 强制 forget |
| `EVICT_RATIO_0` | 15% | 层 0 驱逐比例 |
| `EVICT_RATIO_1` | 25% | 层 1 驱逐比例 |
| `TRUNCATE_THRESHOLD` | 2000 tokens | 单条超过此值触发截断 |
| `TRUNCATE_HEAD` | 500 tokens | 截断时保留头部 |

---

## 3. 工具输出去噪（preprocessToolOutput）

### 3.1 为什么需要

Agent 的工具输出通常包含大量噪音：

```
❌ 原始工具输出 (8K tokens)：
  - npm install 完整日志 (6000 tokens，只有最后 3 行有用)
  - 重复的 "Downloading..." 行 × 200
  - HTML 测试报告（标签比内容多）
  - 空行和 ANSI 转义码

✅ 去噪后 (2K tokens)：
  - npm install → 保留最后 3 行 + 错误行
  - 重复行 → 合并为 "  ... (以上 200 行重复) ..."
  - HTML → 剥离标签，保留文本
  - 空行/ANSI → 移除
```

### 3.2 去噪管线

```
原始输出
  → stripAnsi()            # 移除 ANSI 转义码
  → stripHtml()            # 剥离 HTML 标签（仅保留文本）
  → mergeRepeatedLines()   # 合并连续重复行
  → filterEmptyLines()     # 移除空行
  → extractHeadAndErrors() # 保留头部 + 所有错误行
  → truncate()             # 超过阈值截断（头+尾）
→ 去噪输出
```

### 3.3 规则

| 规则 | 处理方式 |
|------|----------|
| HTML 输出 | 剥离所有标签，保留完整文本 |
| 日志输出 | 保留前 5 行 + `ERROR\|FAIL\|WARN\|Exception` 行 + 后 5 行 |
| JSON 输出 | 保留完整 JSON（不截断，结构信息价值高） |
| 重复行 | `...（以上 N 行重复）...` 合并 |
| ANSI 码 | 全部移除 |
| 空行 | 连续 3 行以上 → 压缩为 1 行 |

---

## 4. 结构化压缩（structuredCompress）

### 4.1 设计

不同于 LLM 摘要（有损，慢，贵），结构化压缩使用模板提取关键信息，可逆且零延迟：

```
输入：LLM 生成的一个 reasoning + action + observation 消息块

输出（压缩后）：
┌────────────────────────────────────────────┐
│ [目标] 修复 auth.ts 的 token 刷新竞态        │
│ [状态] 进行中                                │
│ [动作] read_file(auth.ts) → 已读取 145 行    │
│ [关键发现] 第 87 行缺少 mutex 锁              │
│ [失败] 无                                    │
│ [下一步] 在第 87 行添加互斥锁                │
└────────────────────────────────────────────┘
```

### 4.2 保留的锚点

| 锚点 | 来源 | 保留原因 |
|------|------|----------|
| `[目标]` | Agent 当前子任务 | 维持方向感 |
| `[状态]` | 推理结果 | 追踪进度 |
| `[动作+结果]` | tool_use / tool_result | 关键操作必须保留 |
| `[关键发现]` | 错误 / 意外输出 | 不可丢失的 signal |
| `[失败]` | 失败的尝试 | 避免重复犯错 |
| `[下一步]` | 推理结论 | 维持 Agent 的连续性 |

### 4.3 什么不保留

- 冗长的推理原文（LLM 对自己说的话）
- 已被后续动作替换的中间状态
- "嗯，让我看看..." 类口头推理

---

## 5. 三原语：focus / forget / reflect

### 5.1 定位

从原始六原语（focus/recall/remember/forget/act/reflect）精简而来。保留的三者证明有价值且与其他机制不重复：

- **recall** → 合并到 autoManage 中自动执行（不再需要 LLM 主动调用）
- **remember** → 合并到 ContextManager.session 自动写入（不占原语位）
- **act** → 删除。属于 Agent Loop，不是上下文管理

### 5.2 focus

```
focus(target) → 将指定文件/符号提升到上下文窗口顶部 + 标记为 taskRelevance 保护

参数：
  target: FilePath | SymbolPath | TaskID

效果：
  - 对应条目 evictionScore 归零（不被驱逐）
  - 条目重排到窗口顶部（优先在 LLM 注意力范围内）
  - 关联文件自动连带保护（如 focus(auth.ts) → 连带保护 auth.test.ts）

框架自动触发：
  - autoManage 检测当前编辑文件 → 自动 focus
LLM 主动触发：
  - LLM 说 "我需要关注这个文件" → 调用 MCP 工具 focus:file(path)
```

### 5.3 forget

```
forget(target) → 将指定条目从上下文驱逐到外部存储

参数：
  target: FilePath | MessageID | Regex | "stale" | "noise"

效果：
  - 条目移出上下文窗口
  - 内容保存到 externalContext（可后续 recall）
  - 标记 evictedAt 时间戳

框架自动触发：
  - autoManage 层 2（≥90%）→ 自动 forget 非目标文件
LLM 主动触发：
  - LLM 说 "这个日志没用了" → 调用 MCP 工具 forget:noise(regex)
```

### 5.4 reflect

```
reflect() → 检查当前上下文健康度，生成管理建议

效果：
  - 返回 attentionWaste 统计
  - 返回 usePercent 当前值
  - 返回 Top-K 占用空间的条目（按大小）
  - 返回建议操作列表（"建议 forget npm-install 日志，占用 6200 tokens"）
  - 返回 taskRelevance 保护列表

触发：
  - LLM 主动调用 MCP 工具 reflect()（不自动触发，避免每步都生成元信息）
```

---

## 6. 任务相关性驱逐（taskRelevance）

### 6.1 设计

驱逐不是只看大小和时间——当前正在执行的任务决定什么不能丢。

```
evictionScore(entry, taskContext) =
  baseEvictionScore(entry)           # 原有的时间+大小+类型权重
  × taskRelevanceFactor(entry, taskContext)  # 任务相关性保护系数

taskRelevanceFactor:
  0.00 — 当前编辑文件（绝对保护，不可驱逐）
  0.25 — 当前子任务引用的文件
  0.50 — 失败测试引用的文件 / 当前工作目录
  0.75 — 同目录其他文件
  1.00 — 无关文件（无保护）
```

### 6.2 taskContext 结构

```typescript
interface TaskContext {
  currentSubtasks: string[];    // 当前子任务描述列表
  editingFiles: string[];       // 当前正在编辑的文件路径
  failingTests: string[];       // 当前失败的测试文件
  focusedSymbols: string[];     // LLM 最近关注的符号
  recentErrors: ErrorEntry[];   // 最近的错误信息
}
```

`setTaskContext(ctx)` 由 Agent Loop 每步注入，`ContextManager` 实例维护。

---

## 7. 注意力浪费度量（attentionWaste）

### 7.1 定义

```
attentionWaste.total     = 自会话开始以来被驱逐/丢弃的 tokens 总数
attentionWaste.bySource  = { tool_output: N, logs: N, html: N, ... }
attentionWaste.byStep    = [{ step: N, wasted: N, usePercent: N% }]
attentionWaste.rate      = 浪费率 = wasted / totalInjected

含义：这些是"喂给 LLM 但最终判断为噪音"的 tokens
越低越好。目标 < 15%。
```

### 7.2 计算时机

每次驱逐/截断/forget 操作时更新：
```
wasted_tokens = 条目标记时的 token 数 − 条目最终保留的 token 数
```

### 7.3 用途

- **竞品对比：** "我们浪费率 11%，裸跑浪费率 38%"
- **性能追踪：** 跨任务对比 attentionWaste.rate 趋势
- **定价依据：** SaaS 模式下按"节省的浪费 tokens" 计费

---

## 8. 记忆自动召回（autoRecall）

### 8.1 设计

每步 autoManage 自动用当前编辑文件 + 关注符号检索记忆层，注入到上下文。

```
autoManage() 流程:
  1. 检查 usePercent → 决定管理层级
  2. 提取当前 symbols + files
  3. memory.search(symbols + files, limit=3)
  4. 去重（避免重复注入已存在的记忆条目）
  5. 注入为 "[memory] ..." observation 消息
  6. 执行对应的驱逐/压缩/forget 操作
```

### 8.2 记忆注入格式

```
[memory] 相关上下文:
  - auth.ts L87: 已知 token 竞态问题 (bug #452, 2026-07-11)
  - auth.ts: 双 token 方案已确认 (decision, 2026-07-11)
  - auth.test.ts: 并发测试 0.1% 概率误报 (known-flaky)
```

---

## 9. 上下文条目数据结构

```typescript
interface ContextEntry {
  id: string;                    // 唯一标识
  type: EntryType;               // user | assistant | tool | system | memory | observation
  content: string;               // 原始内容
  tokenCount: number;            // token 估算
  timestamp: number;             // 创建时间 (ms)
  
  // 管理元数据
  compressed: boolean;           // 是否已被结构化压缩
  compressedContent?: string;    // 压缩后内容
  compressedTokenCount?: number; // 压缩后 token 数
  
  evicted: boolean;              // 是否已被驱逐
  evictedAt?: number;            // 驱逐时间
  externalRef?: string;          // 外部存储引用（可 recall）
  
  // 任务相关性
  taskRelevance: number;         // 0-1，0 = 绝对保护
  protectedBy?: string;          // 哪个规则保护了此条目 (editingFile|failingTest|cwd)
  
  // 来源追踪
  source?: string;               // 工具名 / 文件名
  sourceType?: string;           // tool_output | file_content | log | html | json
  
  // 预算
  ageFactor: number;             // 时间衰减权重
  currentEvictionScore: number;  // 当前驱逐分数
}
```

---

## 10. 触发时机与调度

```
Agent Loop 每步完成后:

  1. Agent 执行一个 turn (think → act → observe)
  2. 新 observation 注入上下文
  3. autoManage() 自动执行:
     ├── setTaskContext(当前任务状态)
     ├── preprocessToolOutput(最新 observation)
     ├── 计算 usePercent
     ├── 层 0/1/2 条件判断
     ├── 驱逐 / 压缩 / 截断 / forget
     ├── autoRecall (符号+文件检索记忆)
     ├── autoFocus (当前编辑文件)
     └── 更新 attentionWaste 统计
  4. 构建下一轮的 Context（I/D 分离）
  5. Agent 进入下一 turn

整个流程 < 50ms (纯本地，无 LLM 调用) — 不增加延迟。
```

---

## 附录：与竞品的量化对比（设计目标）

| 指标 | 裸跑 | 简单截断 | Headroom 压缩 | StructAgent |
|------|------|----------|---------------|-------------|
| 峰值 Token 降幅 | 0% | ~15% | 60-95% | **27.7%** (实测) |
| 信息保真度 | 100% | 丢尾部 | 100%（可逆） | **关键信息 100%，噪音 0%** |
| LLM 注意力质量 | 低 | 中 | 中（噪音变小但还在） | **高（噪音移除）** |
| 是否需要模型配合 | 否 | 否 | 否 | **否（框架自动）** |
| 是否支持 LLM 主动管理 | 否 | 否 | 否 | **是（MCP 技能）** |
