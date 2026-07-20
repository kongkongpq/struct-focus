# StructFocus Context Skill — 上下文中间层

你运行在一个有上下文窗口限制的环境中。本 Skill 帮助你管理注意力：
当前需要的东西始终在眼前，不需要的东西自动消失，
忘记的东西需要时会回来。

## 三层上下文

| 层 | 内容 | 管理方式 |
|----|------|----------|
| **L0** 指令 | 你是谁、能做什么、遵循什么规则 | 框架初始化，不变 |
| **L1** 活跃 | 当前编辑的文件、聚焦的上下文 | 框架自动维护 |
| **L2** 历史 | 已压缩的旧步骤、胶囊指针 | 框架自动压缩 |
| **L3** 存档 | 完整上下文在磁盘、知识胶囊 | 推挽双轨自动可见 |

## 你不需要手动管理的事

框架每步 **autoManage** 自动执行（你不费 token）：

| 守护行为 | 触发条件 |
|----------|----------|
| 🔍 自动聚焦 | 当你编辑新文件时 |
| 🧹 自动驱逐 | 窗口 ≥ 70% → 驱逐低价值条目 |
| 📦 自动压缩 | 窗口 ≥ 85% → 压缩旧工具输出 |
| ⚡ 强制清理 | 窗口 ≥ 90% → forget 非焦文件 |
| 🧠 自动回忆 | 记忆与当前文件/符号匹配时注入 |
| ⚠️ 冲突告警 | 你的方案触及已知放弃方案时 |
| 💡 历史提醒 | 编辑文件有历史胶囊时推摘要 |
| 🔒 限制告警 | 涉及文件有已知限制时提醒 |
| 📊 注意力审计 | 每 5 步报告 token 分布 |

## 你可以主动用的工具

### 聚焦 — "这个很重要"
- `focus:file(path)` — 文件提升到 L1，标记绝对保护
- `focus:symbol(sym, file?)` — 聚焦函数/类/变量

### 驱逐 — "这个不需要了"
- `forget:file(path)` — 文件移出上下文
- `forget:noise(pattern)` — 正则清理日志/报告类噪音
- `forget:older_than(N)` — 批量清理旧历史

### 恢复 — "我要看这个"
- `recall:file(path)` — 恢复被 forget 的文件
- `recall:memory(query)` — 检索长期记忆
- `recall:context(capsuleId)` — 展开完整知识胶囊
- `recall:dependency(path)` — 拉入文件依赖图

### 压缩 — "帮我把这些打包"
- `summarize:recent(N)` — 压缩最近 N 步为摘要
- `summarize:conversation(since)` — 压缩指定步骤之后的对话
- `pack:subtask(taskId)` — 子任务上下文全部打包为知识胶囊

### 元技能 — "看看状态"
- `reflect` — 健康度、注意力浪费、Top-K 占用、建议
- `stats` — 条目数、token 分布、保护条目、各层占比
- `budget` — 预算分配详情

## 原则

1. **编辑中的文件优先级最高** — 不确定就 `focus:file`
2. **看到噪音** (日志/编译输出/报告) — `forget:noise`
3. **完成子任务** — `pack:subtask` 然后继续下一个
4. **不确定时** — `reflect` 看看上下文健康度
5. **守护轨给的东西认真对待** — ⚠️/💡/🔒 是框架帮你发现的
6. **保护的文件框架不碰** — `focus:file` 的条目驱逐时跳过

## 工作原理

```
每步 Agent Loop:
┌──────────────────────────────────────────────┐
│  守护轨（框架自动，不占 LLM token）              │
│  ├─ autoFocus     → 编辑的文件自动入 L1         │
│  ├─ autoRecall    → 匹配记忆自动注入            │
│  ├─ autoManage    → 按阈值驱逐/压缩/截断         │
│  └─ runInquiry    → 冲突/缺口/限制检测→注入      │
├──────────────────────────────────────────────┤
│  组装 messages → 发送给 LLM                    │
├──────────────────────────────────────────────┤
│  LLM 决策 → 调用工具                           │
│  ├─ MCP context 工具 → 直接操作 ContextManager  │
│  │   focus:file / forget:noise / recall:…      │
│  │   → 影响下一轮守护轨行为                    │
│  └─ 普通工具 (read/write/exec)                 │
│      → 正常执行                                │
│      → 下一轮守护轨做 autoInquiry              │
└──────────────────────────────────────────────┘
```

## 一条信息的完整生命周期

```
Step 1: LLM 读入 auth.ts (15K)
  → 守护轨: preprocessToolOutput 去噪
  → 条目在 L1，完整保留

Step 5: LLM 不碰 auth.ts 了
  → 守护轨: 窗口≥70% → 可能被驱逐到 ContentStore

Step 8: 子任务完成
  → LLM 调用 pack:subtask("fix_token_refresh")
  → 框架打包: 决策+文件+测试结果 → 知识胶囊
  → L1 中原始大块条目压为指针

Step 12: LLM 再次编辑 auth.ts
  → 守护轨 runInquiry: 文件关联胶囊 fix_token_refresh
  → 注入: "💡 关于 auth.ts 有历史上下文..."
  → LLM 看到提示 → recall:context("fix_token_refresh")
  → 完整胶囊展开注入 L1

Step 15: LLM 准备用全局锁方案
  → 守护轨 runInquiry: 检测到方案在胶囊的已放弃列表中
  → 注入: "⚠️ 该方案已被放弃，原因: 耦合太强"
  → LLM 收到警告 → 重新考虑 → 避免了踩坑
```
