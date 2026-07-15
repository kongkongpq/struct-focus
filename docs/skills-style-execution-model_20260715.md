# Skills 风格上下文管理：执行模型提案

> 日期：2026-07-15
> 状态：设计提案（未实现）

---

## 1. 什么是"Skills 风格"

在 Claude Code / Anthropic Agent Skills 生态中，一个 Skill 是：

```
skills/
  my-skill/
    SKILL.md          ← 告诉 Agent "什么时候、怎么用这个能力"
    scripts/          ← 可执行脚本
    references/       ← 参考文档
```

Agent 读取 `SKILL.md` → 理解自己可以调用什么 → 主动决策是否调用。

**用户的直觉：** 上下文管理也可以这样做——LLM 感觉上下文太挤了，就主动说"给我压缩一下"。

---

## 2. 核心问题：为什么要两种模式

```
┌──────────────────────────────────────────────────┐
│                                                  │
│   🛡️ 自动管理（autoManage）                       │
│   框架兜底。每步执行，不依赖模型自觉。             │
│   → 模型忘了管、不知道要管、懒得管 → 框架接管     │
│                                                  │
│   ✨ 主动管理（MCP 技能）                          │
│   LLM 主动调用。更精准，更符合当前意图。           │
│   → 模型说 "这个文件我不需要再看了" → 精准驱逐    │
│                                                  │
│   两层互补，不冲突。                               │
└──────────────────────────────────────────────────┘
```

**为什么不能只靠自动管理？**
自动管理基于规则（文件是否正在编辑、token 数是否超阈值）。它不知道 LLM 脑子里在想什么——LLM 可能已经放弃了一个方案但没有明确说。

**为什么不能只靠 LLM 主动管理？**
Letta 的 48-74% 准确率已经证明了：LLM 自我管理记忆不可靠。它会在不该忘的时候忘，在该驱逐的时候犹豫。

---

## 3. MCP 技能清单

### 3.1 `focus:*` — 聚焦注意力

```
focus:file(path: string)
  → 将文件提升到上下文顶部 + 标记为 taskRelevance 保护（不被驱逐）
  → 自动连带保护关联文件（如 .test.ts）

focus:symbol(symbol: string, file?: string)
  → 聚焦特定符号（函数/类/变量）

focus:task(taskId: string)
  → 切换当前聚焦的子任务，更新 taskContext
```

### 3.2 `forget:*` — 主动驱逐

```
forget:file(path: string)
  → 将文件内容从上下文驱逐到外部存储

forget:noise(pattern: string)
  → 批量移除匹配模式的噪音条目（如 "npm.*log", "html.*report"）

forget:older_than(steps: number)
  → 驱逐 N 步之前的所有非保护条目
```

### 3.3 `recall:*` — 恢复上下文

```
recall:file(path: string)
  → 从外部存储恢复被 forget 的文件内容

recall:memory(query: string)
  → 从记忆层检索相关历史并注入上下文

recall:context(ctxId: string)
  → 展开指定知识胶囊或上下文包
```

### 3.4 `summarize:*` — 请求压缩

```
summarize:recent(steps: number)
  → 将最近 N 步压缩为结构化摘要

summarize:conversation(since: string)
  → 将对话历史压缩（保留关键决策和错误）
```

### 3.5 元技能

```
reflect()
  → 返回上下文健康报告
  → attentionWaste / usePercent / Top-K 占用条目 / 建议操作

stats()
  → 返回当前上下文统计信息
  → 条目数 / 总 tokens / 各类占比 / 保护条目列表
```

---

## 4. 调用流程

### 4.1 典型编码 Agent 轨迹

```
Turn 1   LLM: "我来看一下项目结构"  → ls, read_file(README.md)
              [autoManage: usePercent 12%, 无需操作]

Turn 2   LLM: "需要理解 auth 模块"  → read_file(auth.ts), read_file(auth.test.ts)
              [autoManage: usePercent 25%, 无需操作]

Turn 3   LLM: "有个 bug，看看这个报错" → exec(npm test)
              → 测试输出 15K tokens (HTML 报告 + 堆栈)
              [autoManage: usePercent 68%]
              [preprocessToolOutput: HTML 剥标签, 15K → 4.2K]
              [autoFocus: auth.ts, auth.test.ts]

Turn 4   LLM: 调用 focus:file(auth.ts)  ← LLM 主动确保焦点正确

Turn 5   LLM: "让我看看另一个文件" → read_file(middleware.ts)
              [autoManage: usePercent 72%, 触发层 0 驱逐]
              → 驱逐 npm install 日志条目 (5.2K), 警告条目 (1.8K)

Turn 6   LLM: 调用 forget:noise("npm.*log|html.*report")
              ← LLM 主动清理刚才注意到的噪音

Turn 7   LLM: "修复方案确定了，继续" → edit_file(auth.ts)
              [autoManage: usePercent 58%, 无需操作]

Turn 8   LLM: "我需要回顾之前的讨论" → recall:memory("token refresh mutex")
              → 注入 [memory] auth.ts token 刷新决策 (2026-07-11)

Turn 9   LLM: "提交代码" → exec(git commit)
              [autoManage: usePercent 65%, 无需操作]

Turn 10  LLM: 调用 reflect()
              → 返回: usePercent 65%, attentionWaste 12%, 建议 forget middleware.ts
              LLM: 调用 forget:file(middleware.ts)

Turn 11  LLM: 调用 summarize:recent(10)
              → 压缩 Turn 1-10 为结构化摘要
              [注入摘要 → 上下文从 65% 降到 35%]
              LLM: "下一个任务..."
```

### 4.2 调用模式

```
自动管理（每步）:
  ┌──────────────────┐
  │ autoManage()     │  ← 框架调用，不占 LLM token
  │  ├ 计算饱和度    │
  │  ├ 层 0/1/2 判断 │
  │  ├ 驱逐/压缩     │
  │  └ autoRecall    │
  └──────────────────┘

LLM 主动管理（按需）:
  ┌──────────────────┐
  │ MCP Tool Call    │  ← LLM 主动调用
  │  ├ focus:*       │     精准聚焦
  │  ├ forget:*      │     精准驱逐
  │  ├ recall:*      │     按需恢复
  │  ├ summarize:*   │     请求压缩
  │  └ reflect       │     检查健康度
  └──────────────────┘
```

---

## 5. SKILL.md 模板

如果作为独立 Skill 分发，`SKILL.md` 大概长这样：

```markdown
# Context Management — Agent 上下文管理技能

你是一个能主动管理自己上下文窗口的 Agent。你没有无限记忆，上下文空间有限。
当窗口拥挤时，你需要做出判断：保留什么、驱逐什么、何时压缩。

## 何时使用

- 上下文 token 数接近模型限制时
- 你注意到大量工具输出中只有很少部分有用
- 你切换了子任务，不再需要上一个任务的文件
- 你需要回顾之前讨论过但已压缩的决策

## 可用工具

### focus:file(path)
将文件标记为"焦点文件"，保护它不被自动驱逐。
用在你确定接下来需要反复参考的文件上。

### forget:noise(pattern)
批量移除匹配正则的噪音条目。例如：
- `npm.*(install|build|test).*output` → 构建日志
- `html.*report` → HTML 测试报告
- `Downloading.*` → 下载进度行

### recall:memory(query)
从长期记忆检索相关历史。当你不确定之前是否讨论过某个话题时使用。

### reflect()
检查当前上下文健康状态。返回哪些条目占了最多空间、建议驱逐什么。

### summarize:recent(N)
将最近 N 步压缩为结构化摘要。当你完成一个子阶段、准备开始下一个时使用。

## 原则

1. **当前正在编辑的文件优先级最高。** 不确定时就 focus 它。
2. **日志和报告优先驱逐。** LLM 不需要读这些。
3. **决策和错误必须保留。** 不管多旧。
4. **不确定时就 reflect。** 不要猜。
5. **不要过度管理。** usePercent < 60% 时一般不需要任何操作。
```

---

## 6. 与 autoManage 的优先级关系

```
autoManage（自动）               MCP 技能（LLM 主动）
────────────────────────────────────────────────────
执行频率: 每步                    执行频率: 按需
触发条件: usePercent ≥ 70%        触发条件: LLM 判断
权限: 可驱逐任何非保护条目         权限: 同 autoManage + 可 forget 保护条目
优先级: 低（基础保障）             优先级: 高（LLM 意图优先）

冲突解决:
  LLM 主动 focus 的条目 → 标记为 protectedBy="llm"
  → autoManage 不会驱逐 protectedBy="llm" 的条目
  → 但层 2（≥90%）可以覆盖（生存优先）

示例:
  autoManage 想驱逐 middleware.ts
  LLM 之前 focus:file(middleware.ts)
  → autoManage 跳过 middleware.ts，驱逐下一个
```

---

## 7. 实现成本估算

| 组件 | 工作量 | 说明 |
|------|--------|------|
| MCP Server 骨架 | 0.5 天 | 注册 16 个工具 |
| focus/forget/recall 实现 | 1 天 | 已有 evict/focusFile/recall 方法 |
| reflect/stats 实现 | 0.5 天 | 已有 attentionWaste 统计 |
| summarize 实现 | 1 天 | 已有 structuredCompress |
| SKILL.md 编写 | 0.5 天 | 文案 + 测试 |
| 集成测试 | 1 天 | 端到端轨迹验证 |
| **总计** | **4.5 天** | 全部基于已有代码 |

---

## 8. 跟 Anthropic Agent Skills 的差异

| 维度 | Anthropic Skills | 我们的方案 |
|------|------------------|-----------|
| 技能定义 | SKILL.md + scripts/ | MCP 工具集 |
| Agent 发现 | 启动时读取 skill 目录 | 连接时通过 MCP list_tools |
| 调用方式 | Agent 读 SKILL.md → 决定是否执行脚本 | Agent 直接调用 MCP 工具 |
| 状态管理 | 无状态（脚本执行完即结束） | 有状态（ContextManager 实例） |
| 适用场景 | 通用 Agent 扩展 | 上下文管理专用 |

---

## 9. 为什么不现在就做

Phase 0+1 已验收。自动管理已跑通，框架兜底已生效。
Skills 风格是增强层，不是基础层。优先级：

```
P1: 基准测试数据（跑出 Headroom vs StructAgent 对比）     ← 现在该做
P2: VS Code 插件分发（让用户能用）                       ← 尽快
P3: Skills 风格 MCP 工具（LLM 主动管理）                  ← 4.5 天，不急
```
