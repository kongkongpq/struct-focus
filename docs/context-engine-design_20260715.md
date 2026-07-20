# StructFocus Context Engine 完整设计

> 日期：2026-07-15
> 状态：Phase 0+1 验收通过（峰值 Token 降 27.7%）

---

## 目录

1. [定位](#1-定位)
2. [架构总览](#2-架构总览)
3. [Context Builder：六层 Pipeline](#3-context-builder六层-pipeline)
4. [ContextManager 完整 API](#4-contextmanager-完整-api)
5. [Budget Manager：从五桶到简化](#5-budget-manager从五桶到简化)
6. [哈佛架构：I/D 上下文分离](#6-哈佛架构id-上下文分离)
7. [MCP 技能清单](#7-mcp-技能清单)
8. [A/B 基准测试](#8-ab-基准测试)

---

## 1. 定位

> StructFocus Context Engine = 上下文中间层。做在 Agent 下面、模型上面的那一层。

```
┌─────────────────────────────────────────────┐
│  Agent (Claude Code / Cursor / 自定义)       │
│    ↕                                         │
│  Context Engine ← 我们做这一层                │
│    ↕                                         │
│  LLM (DeepSeek / OpenAI / Anthropic / GLM)   │
└─────────────────────────────────────────────┘
```

**不做的事：**
- 不做代码生成（那是模型的事）
- 不做 IDE（那是 Cursor 的事）
- 不做长期记忆（那是 Mem0 的事，但能覆盖）

**做的事：**
- 决定 LLM 的注意力该放在哪
- 驱逐噪音、保护关键信息
- 追踪上下文的健康度（浪费了多少注意力）
- 管理 I/D 分离、Git 版本化上下文

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────┐
│                 Context Engine                    │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ Context    │  │ Budget     │  │ Context    │ │
│  │ Builder    │  │ Manager    │  │ Manager    │ │
│  │ (Pipeline) │  │ (估算)     │  │ (管理核心)  │ │
│  └────────────┘  └────────────┘  └────────────┘ │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  ContextManager (管理核心)                │   │
│  │                                          │   │
│  │  自动管理（autoManage）                   │   │
│  │  ├── 层 0: 价值驱逐 (≥70%)               │   │
│  │  ├── 层 1: 完整管理 (≥85%)               │   │
│  │  │   ├── 驱逐                             │   │
│  │  │   ├── structuredCompress               │   │
│  │  │   └── 截断                             │   │
│  │  └── 层 2: 强制 forget (≥90%)            │   │
│  │                                          │   │
│  │  MCP 技能（LLM 主动）                     │   │
│  │  ├── focus:file / focus:symbol            │   │
│  │  ├── forget:noise / forget:file            │   │
│  │  ├── recall:memory / recall:context        │   │
│  │  ├── summarize:recent                     │   │
│  │  └── reflect / stats                      │   │
│  │                                          │   │
│  │  预处理与度量                             │   │
│  │  ├── preprocessToolOutput (去噪)           │   │
│  │  ├── attentionWaste (度量)                 │   │
│  │  └── taskRelevance (驱逐加权)              │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ I-Context  │  │ D-Context  │  │ Git 版本化  │ │
│  │ (指令)     │  │ (数据)     │  │ (审计)      │ │
│  └────────────┘  └────────────┘  └────────────┘ │
└──────────────────────────────────────────────────┘
```

---

## 3. Context Builder：六层 Pipeline

每次 Agent turn 完成后，Context Builder 组装下一轮输入：

```
Layer 1: System Prompt (指令层)
  ├── 静态 System Prompt（角色、能力、工具描述）
  ├── 动态裁剪（根据当前子任务只包含相关工具）
  └── 节省：~2K tokens/步

Layer 2: Git Context (环境层)
  ├── 当前分支、最近 commits
  ├── 工作区状态（modified/staged/untracked）
  └── 项目结构摘要

Layer 3: Task Context (任务层)
  ├── 当前子任务描述
  ├── 进度追踪（已完成/进行中/待做）
  └── taskContext 对象注入

Layer 4: Focused Context (焦点层)
  ├── 当前编辑文件内容（D-Context 核心）
  ├── 失败测试输出
  ├── 关键错误信息
  └── taskRelevance 保护的条目

Layer 5: Recent History (历史层)
  ├── 最近 N 步的交互历史
  ├── 已压缩的历史摘要（replace 原始长篇）
  └── 记忆检索结果（[memory] observation）

Layer 6: Budget Check (预算层)
  ├── 总计 tokens 估算
  ├── 各层占比
  └── usePercent 计算 → 触发 autoManage
```

### 各层 Token 预算分配（200K 窗口目标）

| 层 | 目标 Token | 占比 | 说明 |
|----|-----------|------|------|
| L1 System Prompt | 8-15K | 4-8% | 动态裁剪后 |
| L2 Git Context | 1-2K | 0.5-1% | 固定 |
| L3 Task Context | 1-3K | 0.5-1.5% | 子任务描述 |
| L4 Focused | 40-80K | 20-40% | 核心工作区 |
| L5 History | 60-100K | 30-50% | 对话 + 压缩 |
| L6 Budget 余量 | 0-20K | 0-10% | 安全缓冲 |

---

## 4. ContextManager 完整 API

### 4.1 核心方法

```typescript
class ContextManager {
  // === 自动管理 ===
  async autoManage(): Promise<AutoManageReport>;
  // 每步自动调用。根据 usePercent 决定管理深度

  // === 三层管理（autoManage 内部调用）===
  private manage(): ManageResult;
  // 执行驱逐 + 压缩 + 截断

  private evictEntries(ratio: number, taskContext: TaskContext): EvictResult;
  // 按 evictionScore 驱逐最低分条目

  // === 预处理 ===
  private preprocessToolOutput(output: string, sourceType: string): string;
  // 六阶段去噪管线

  // === 结构化压缩 ===
  private structuredCompress(entry: ContextEntry): ContextEntry;
  // 提取锚点段，保留关键信息

  private compressOldEntries(): void;
  // 对 staled 条目批量压缩

  private summarizeLongEntries(content: string): string;
  // LLM 摘要钩子（可选，Phase 1 保留未启用）

  // === 焦点管理 ===
  focusFile(path: string, symbols?: string[]): void;
  // 将文件标记为焦点，taskRelevance = 0

  forgetFile(path: string): void;
  // 将文件从上下文驱逐到外部存储

  // === 记忆 ===
  async recall(query: string, limit?: number): Promise<MemoryEntry[]>;
  // 从记忆层检索

  async rememberFromContent(content: string): Promise<void>;
  // 从内容中自动提取关键信息写入记忆

  // === 任务 ===
  setTaskContext(ctx: TaskContext): void;
  // 注入当前任务状态

  // === 统计 ===
  getStats(): ContextStats;
  // 返回 usePercent, attentionWaste, 条目统计

  getReflection(): ReflectionReport;
  // 返回健康报告 + 建议操作

  // === 状态 ===
  getEntries(): ContextEntry[];
  getAllEntries(): ContextEntry[]; // 含已被驱逐的
}
```

### 4.2 数据结构

```typescript
interface ContextEntry {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'memory' | 'observation';
  content: string;
  tokenCount: number;
  timestamp: number;
  compressed: boolean;
  compressedContent?: string;
  compressedTokenCount?: number;
  evicted: boolean;
  evictedAt?: number;
  externalRef?: string;
  taskRelevance: number;      // 0 = 绝对保护, 1 = 可驱逐
  protectedBy?: string;        // 'editingFile' | 'failingTest' | 'cwd' | 'llm'
  source?: string;
  sourceType?: string;         // 'tool_output' | 'file_content' | 'log' | 'html' | 'json'
  currentEvictionScore: number;
}

interface TaskContext {
  currentSubtasks: string[];
  editingFiles: string[];
  failingTests: string[];
  focusedSymbols: string[];
  recentErrors: { message: string; file?: string }[];
}

interface AutoManageReport {
  usePercent: number;
  triggerLevel: 0 | 1 | 2 | -1;  // -1 = 未触发
  evictedCount: number;
  evictedTokens: number;
  compressedCount: number;
  truncatedCount: number;
  focusedFiles: string[];
  recalledMemories: number;
}

interface ReflectionReport {
  usePercent: number;
  attentionWaste: { total: number; rate: number; bySource: Record<string, number> };
  topSpaceHogs: { id: string; tokens: number; summary: string }[];
  protectedEntries: { id: string; tokens: number; protectedBy: string }[];
  suggestions: string[];  // 如 "建议 forget npm-install 日志 (6200 tokens)"
}
```

---

## 5. Budget Manager：从五桶到简化

### 5.1 演进历史

```
v1 (被舍弃): 五桶预算模型
  ├── Task Bucket (任务定义)
  ├── Context Bucket (当前上下文)
  ├── History Bucket (对话历史)
  ├── Memory Bucket (记忆检索)
  └── Tool Bucket (工具输出)
  
  问题: 桶之间交叉引用复杂，驱逐时不知道"这条 tool_output 属于哪个任务"。
  最优预算分配是 NP-hard 问题。

v2 (当前): 简化估算
  └── BudgetManager 仅保留 static estimateTokens(text: string): number
      └── 基于模型的 tokenizer 估算（tiktoken / GLM tokenizer）
      └── 桶模型已删除，PointerRegistry 已移出公共导出并标记 @deprecated
```

### 5.2 为什么会存在五桶模型

在原始设计中，五桶模型的动机是：

> "不同来源的上下文应该分配不同的 token 预算，Agent 选择性地填充每个桶"

实际上这个需求被 `taskRelevance` + `evictionScore` 更优雅地解决了。不需要显式分桶——相关性自动保护该保护的条目，驱逐自动清理该清理的。

---

## 6. 哈佛架构：I/D 上下文分离

### 6.1 概念

```
CPU 哈佛架构的类比:
  Instruction Memory (只读, 存指令)  ≠  Data Memory (读写, 存数据)
  
Agent 上下文:
  I-Context (指令)                   D-Context (数据)
  ├── System Prompt                  ├── 文件内容
  ├── 工具描述                        ├── 工具输出
  ├── 任务描述                        ├── 测试结果
  └── 规则/约束                       └── 对话历史
```

### 6.2 分离的好处

| | I/D 合并 (传统) | I/D 分离 (哈佛) |
|---|---|---|
| System Prompt 缓存 | 每次重传整个 prompt | 仅 I-Context 需缓存，可复用 KV Cache |
| 压缩时 | 不小心压缩了指令 | 只压缩 D-Context，指令不碰 |
| Git 版本化 | 一坨 | D-Context 独立版本化，可 diff |
| 多 Agent 路由 | 全量复制 | I-Context 不同，D-Context 共享 |

### 6.3 实现

```
I-Context (System + Tool + Task)
  → System Prompt (静态部分，可缓存)
  → Tool Schema (动态裁剪)
  → Task Description (当前子任务)
  → 总计 ~15K tokens

D-Context (Data + History)
  → 文件内容 + 符号表
  → 工具输出（去噪后）
  → 对话历史（压缩后）
  → Memory 注入
  → 总计 ~170K tokens（200K 窗口内）

两者在物理上是同一 context，但在管理逻辑上分开处理。
```

### 6.4 Git 版本化

D-Context 有变更历史：
```
git log --oneline context/
  a1b2c3d  compress turn 8-15
  e4f5g6h  evict middleware.ts analysis
  i7j8k9l  autoRecall: auth token decision (2026-07-11)
```

每个管理操作（驱逐/压缩/forget）作为一个 commit，可回溯审计。

---

## 7. MCP 技能清单

共 16 个 MCP 工具，分 4 组：

### 7.1 focus（3 个）

| 工具 | 参数 | 描述 |
|------|------|------|
| `focus:file` | `path: string` | 聚焦文件，标记 taskRelevance=0 |
| `focus:symbol` | `symbol: string, file?: string` | 聚焦符号 |
| `focus:task` | `taskId: string` | 切换当前子任务 |

### 7.2 forget（3 个）

| 工具 | 参数 | 描述 |
|------|------|------|
| `forget:file` | `path: string` | 驱逐文件到外部存储 |
| `forget:noise` | `pattern: string` | 正则批量移除噪音条目 |
| `forget:older_than` | `steps: number` | 驱逐 N 步前的非保护条目 |

### 7.3 recall（3 个）

| 工具 | 参数 | 描述 |
|------|------|------|
| `recall:file` | `path: string` | 恢复被 forget 的文件 |
| `recall:memory` | `query: string` | 记忆检索 |
| `recall:context` | `ctxId: string` | 展开知识胶囊 |

### 7.4 summarize（3 个）

| 工具 | 参数 | 描述 |
|------|------|------|
| `summarize:recent` | `steps: number` | 压缩最近 N 步 |
| `summarize:conversation` | `since: string` | 压缩对话历史 |
| `summarize:file` | `path: string` | 压缩文件摘要 |

### 7.5 元技能（4 个）

| 工具 | 参数 | 描述 |
|------|------|------|
| `reflect` | — | 返回上下文健康报告 |
| `stats` | — | 返回统计信息 |
| `budget` | — | 返回预算分配 |
| `dump` | `format: 'json'` | 导出当前上下文（调试用） |

---

## 8. A/B 基准测试

### 8.1 测试方法

```
A 组 (朴素基线): 裸跑，不启用 Context Engine
B 组 (引擎): 启用 Context Engine (autoManage + preprocessToolOutput)

同一模型 (DeepSeek V4 Flash)
同一工具集
同一 3 个任务 (medium complexity)

度量: 峰值 token 数、总 token 消耗、pass rate
```

### 8.2 测试结果（2026-07-15）

```
                    A 组 (基线)    B 组 (引擎)    变化
                    ──────────    ──────────    ──────
峰值 Token 数        45.2K          32.7K       -27.7%  ✅ ≥15%
总 Token 消耗        189K           148K        -21.7%
pass rate            3/3 (100%)     3/3 (100%)  相同
focus 命中率         —              100%        ✅
recall 命中率        —              100%        ✅
```

### 8.3 节省分解

```
节省来源:
  preprocessToolOutput     → ~5K/步 (HTML剥标签、日志截断)
  structuredCompress       → ~3K/步 (保留锚点，去推理原文)
  价值驱逐                  → ~4K/步 (长期无用条目)
  taskRelevance 保护        → 防止驱逐关键信息 (间接贡献)
  ─────────────────────────────────
  合计                      → ~12K/步
```

---

## 附录：与 Headroom 的量化对比（设计目标）

| 维度 | Headroom | StructFocus |
|------|----------|-------------|
| 策略 | 无损压缩所有内容 | 按价值分级管理 |
| 压缩/管理比 | 60-95% token 减少 | **27.7%** token 减少 (实测) |
| 噪音处理 | 噪音被压小但仍在 | **噪音被移除** |
| 信息保真 | 100% (可逆) | 关键信息 100%，噪音 0% |
| LLM 注意力质量 | 中（需浏览压缩后内容） | **高**（只看有价值内容） |
| 是否需要模型配合 | 否 | **否**（框架自动兜底） |
| 支持 LLM 主动请求 | 否 | **是**（MCP 技能） |
| 部署方式 | `headroom wrap` | Electron App / VS Code 插件 |
| 成熟度 | v0.23, 1649 commits | Phase 0+1 验收 |
