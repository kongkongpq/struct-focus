# Context Skill：统一上下文中间层 v3

> 日期：2026-07-16
> 状态：融合 Skills 执行模型 + 推挽双轨 → 统一设计
> 触发：用户要求优化注入方案，回想 Skills 风格文档

---

## 0. 这是什么

```
┌─────────────────────────────────────────────┐
│                                             │
│  一个 Skill，运行在 Agent 和 LLM 之间。       │
│  它不代表模型说话，也不代表用户操作。         │
│  它只在背后做一件事：                        │
│                                             │
│  让 LLM 每一步看到的上下文，                  │
│  恰好是该看的东西。不多不少。                 │
│                                             │
│  就像眼睛只聚焦你盯着的东西，                │
│  余光里的东西模糊但你知道在哪里，             │
│  忘了的东西在你需要的时候会自己回来。         │
│                                             │
└─────────────────────────────────────────────┘
```

两个文档讲的是同一件事的两面，这次合为一体。

---

## 1. 统一架构：三层 × 双轨

```
                    ┌──────────────────────────────────────┐
                    │          Context Skill               │
                    │                                     │
   ┌────────────────┼─────────────────────────────────┐   │
   │                │                                 │   │
   │   🛡️ 守护轨 (Guard Rail)     ✨ 互动轨 (MCP Tools) │   │
   │   框架每步自动执行。          LLM 按需主动调用。    │   │
   │   不占 LLM token。           占 LLM 一次 tool_call。│   │
   │   不让 LLM 偷懒。            不让框架猜错意图。     │   │
   │                │                                 │   │
   │   ├── autoFocus             ├── focus:*           │   │
   │   ├── autoRecall            ├── forget:*          │   │
   │   ├── autoInquiry (质询)    ├── recall:*          │   │
   │   ├── preprocessOutput      ├── summarize:*       │   │
   │   └── compressHistory       └── reflect/stats     │   │
   │                                                     │
   └─────────────────────────────────────────────────────┘
```

---

## 2. 三层上下文

```
L0: IMMUTABLE (I-Context) — 永远不动，约 8-15K
    角色 · 工具 · 规则 · 主机环境 · 开发偏好 · 用户画像

L1: ACTIVE (Hot Window) — 当前正在用的，约 20-50K
    编辑中的文件 · 当前子任务 · 最近错误 · git diff · 关联胶囊摘要

L2: COMPRESSED ARCHIVE (温历史) — 已完成但可能在看的，约 5-10K
    结构化历史步 · 胶囊指针 · 记忆注入

L3: EXTERNAL CAPSULES — 不在窗口，在磁盘
    完整上下文可展开。框架按规则自动推摘要到 L1。
```

---

## 3. 守护轨 (每步自动执行，不占 LLM token)

### 3.1 流程

```
每步 autoManage() 执行:

  1. preprocessToolOutput()          ← 已有。去噪：HTML剥标签、日志截断、重复行合并
  2. autoFocus()                     ← 已有。taskContext.currentFiles 中未聚焦的 → 自动拉入
  3. autoRecall()                    ← 已有。按 taskContext 检索记忆 → inject observation
  4. autoInquiry()                   ← NEW。冲突/缺口/一致性检测 → inject observation
  5. compressHistory()               ← 已有。旧条目结构化压缩
  6. checkBudget()                   ← 降级为安全网。仅在 >85% 时紧急压缩
```

### 3.2 autoInquiry — 质询注入

```
runInquiry(lastAction, lastResponse):
  
  ┌─ 冲突检测 ─────────────────────────────────────────┐
  │  LLM 刚才的方案是否与已知胶囊中放弃的方案冲突？     │
  │  → 是 → injectConflictWarning()                    │
  │    示例: "⚠️ 你正在使用全局锁方案处理 token 刷新。   │
  │           capsule:fix_token_refresh (07-11) 已评估  │
  │           并放弃该方案。原因: 耦合太强。             │
  │           如果情况已变化，请说明。"                   │
  └───────────────────────────────────────────────────┘
  
  ┌─ 缺口检测 ─────────────────────────────────────────┐
  │  LLM 编辑了文件 F，F 有 N 个关联胶囊。              │
  │  LLM 是否引用了其中任何一个？                       │
  │  → 否 → injectCapsuleHint()                        │
  │    示例: "💡 关于 auth.ts 有 2 条历史上下文:         │
  │           · capsule:fix_token_refresh — 并发刷新竞态 │
  │           · capsule:migrate_oauth — OAuth flow 迁移  │
  │           调用 recall:context(id) 查看完整记录"      │
  └───────────────────────────────────────────────────┘
  
  ┌─ 一致性检测 ───────────────────────────────────────┐
  │  修改触及了某胶囊标记的 KNOWN_BUG / MANDATORY_RULE? │
  │  → 是 → injectConstraintWarning()                  │
  │    示例: "⚠️ 你修改的 auth.ts:L87-L95 在             │
  │           capsule:fix_token_refresh 中标记了         │
  │           已知限制：0.1% 概率竞态。修改后请确认。    │
  │                                                     │
  │    示例: "🔒 MANDATORY: token 缓存 ≥ 5 分钟          │
  │           (capsule:fix_token_refresh → auth.ts:L156)  │
  │           违反 → 速率限制接口拒绝。不可违背。"        │
  └───────────────────────────────────────────────────┘
```

### 3.3 注入实现 (直接用已有 API)

```typescript
// 守护轨注入 —— 全部走 appendObservation
private injectConflictWarning(capsule: Capsule): void {
  this.appendObservation(
    `⚠️ 冲突：你正在使用的方案与 capsule:${capsule.id} ` +
    `(${capsule.createdDate}) 中已放弃的方案相符。\n` +
    `放弃原因：${capsule.discardedAlternatives[0].reason}\n` +
    `如果情况有变，调用 recall:context("${capsule.id}") 复查完整记录，并说明为何重新采用。`,
    "high",
    { source: "auto-inquiry", kind: "conflict", capsuleId: capsule.id }
  );
}

private injectCapsuleHint(file: string, capsules: Capsule[]): void {
  const list = capsules
    .map(c => `  · capsule:${c.id} — ${c.summary.slice(0, 80)}`)
    .join("\n");
  this.appendObservation(
    `💡 关于 ${file} 有 ${capsules.length} 条历史上下文：\n${list}\n` +
    `调用 recall:context(id) 查看其中任意一条的完整记录。`,
    "medium",
    { source: "auto-inquiry", kind: "gap", file }
  );
}

private injectConstraintWarning(capsule: Capsule, constraint: Constraint): void {
  const prefix = constraint.type === "MANDATORY_RULE" ? "🔒 MANDATORY" : "⚠️ 已知限制";
  this.appendObservation(
    `${prefix}: ${constraint.description}\n` +
    `来源: capsule:${capsule.id} → ${constraint.location}\n` +
    (constraint.type === "MANDATORY_RULE" ? "此约束不可违背。" : "修改后请确认不受影响。"),
    constraint.type === "MANDATORY_RULE" ? "critical" : "high",
    { source: "auto-inquiry", kind: "constraint", capsuleId: capsule.id }
  );
}
```

**每次质询注入量：0-3 条 observation，每条约 60-200 tokens。总量约 0-500 tokens/步。**

---

## 4. 互动轨 (MCP 工具，LLM 主动调用)

### 4.1 设计原则

```
守护轨是"你不知道你需要知道的东西" → 框架推给你
互动轨是"你知道你需要的东西但不在眼前" → 你主动拿

守护轨不占 LLM token (框架后台执行)
互动轨占一个 tool_call (LLM 决策调用)
```

### 4.2 工具清单

聚焦 — 告诉框架"这个很重要"

| 工具 | 做什么 | 什么时候用 |
|------|--------|-----------|
| `focus:file(path)` | 文件提升到 L1，标记保护 | 确定接下来要反复参考 |
| `focus:symbol(sym, file?)` | 聚焦函数/类/变量 | 只关心一个符号 |
| `focus:task(taskId)` | 切换当前子任务 | 任务切换时 |

驱逐 — 告诉框架"这个不需要了"

| 工具 | 做什么 | 什么时候用 |
|------|--------|-----------|
| `forget:file(path)` | 文件移出上下文 | 文件看完了不再需要 |
| `forget:noise(pattern)` | 正则清理噪音条目 | `npm.*test.*output` 之类 |
| `forget:older_than(N)` | 驱逐 N 步前的非保护条目 | 批量清理旧历史 |

恢复 — 告诉框架"我要看这个"

| 工具 | 做什么 | 什么时候用 |
|------|--------|-----------|
| `recall:file(path)` | 恢复被 forget 的文件 | 又需要看了 |
| `recall:memory(query)` | 检索长期记忆 | 不确定是否讨论过 |
| `recall:context(capsuleId)` | 展开完整胶囊 | 需要看完整历史上下文 |
| `recall:dependency(path)` | 拉入文件的依赖图 | 要改一个被多处引用的模块 |

压缩 — 告诉框架"帮我把这些打包"

| 工具 | 做什么 | 什么时候用 |
|------|--------|-----------|
| `summarize:recent(N)` | 压缩最近 N 步为摘要 | 子阶段完成，准备下一步 |
| `summarize:conversation(since)` | 压缩对话历史 | 对话太长了 |
| `pack:subtask(taskId)` | 将子任务所有上下文打包胶囊 | 子任务完成 |

元技能 — 查看状态

| 工具 | 做什么 |
|------|--------|
| `reflect` | 返回健康报告：usePercent, attentionWaste, Top-K 占用, 建议 |
| `stats` | 统计：条目数, token 分布, 保护条目, 各层占比 |
| `budget` | 预算分配详情 |

### 4.3 互动轨的实现

```typescript
// 每个 MCP 工具 = 一个已有方法 + 包装
// 不需要新建任何基础设施

focus:file(path) {
  // 已有: ContextManager.focusFile()
  const result = await this.ctx.focusFile(path, "full");
  // 副作用: 自动派生关联文件 (.test.ts, 同目录)
  for (const derived of this.deriveRelatedFiles(path)) {
    await this.ctx.focusFile(derived, "symbols");
  }
  return { ok: true, focused: [path, ...derived] };
}

forget:noise(pattern) {
  // 已有: ContextManager 的驱逐逻辑
  const regex = new RegExp(pattern);
  const live = this.ctx.getEntries();
  const toRemove = live.filter(e =>
    !e.metadata.file && // 不碰文件条目
    !this.isProtected(e) && // 不碰保护条目
    regex.test(e.content.slice(0, 200)) // 匹配内容前 200 字符
  );
  // 逐出到外部存储而非删除
  for (const e of toRemove) this.ctx.forgetEntry(e.id);
  return { ok: true, removed: toRemove.length, tokensFreed: ... };
}

recall:context(capsuleId) {
  // 从磁盘加载胶囊 → 展开为 observation → 注入 L1
  const capsule = this.loadCapsule(capsuleId);
  this.ctx.appendObservation(
    `📦 展开胶囊: ${capsule.summary}\n${capsule.fullContent}`,
    "high",
    { source: "llm-recall", capsuleId }
  );
  return { ok: true, tokens: ... };
}

pack:subtask(taskId) {
  // 找到该子任务的所有 entry → 打包胶囊 → 压缩 L2 entries → 移出 L3 条目
  // 自动生成 auto_push_rules
  const capsule = this.buildCapsule(taskId);
  this.saveCapsule(capsule);
  // 把原始 L2 entries 替换为指针
  this.replaceWithPointer(taskId, capsule.id);
  return { ok: true, capsuleId: capsule.id, originalTokens: ..., capsuleTokens: ... };
}
```

---

## 5. 两条轨如何不冲突

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  守护轨 先执行 (每步，不占 token)                     │
│    ├── autoInquiry → 注入 observation (如有冲突/缺口) │
│    ├── autoFocus → 拉入文件                           │
│    ├── autoRecall → 注入记忆                          │
│    └── compressHistory → 压缩旧条目                   │
│                                                     │
│  → 组装 messages → 发送给 LLM                        │
│                                                     │
│  LLM 看到上下文 + 守护轨注入的 observation             │
│  LLM 决策 → 调用工具                                  │
│    ├── 如果是 MCP context 工具:                       │
│    │   focus:file / forget:noise / recall:context ... │
│    │   → 直接操作 ContextManager 实例                  │
│    │   → 影响下一轮的守护轨行为                       │
│    ├── 如果是普通工具:                                │
│    │   read_file / edit_file / exec ...              │
│    │   → 正常执行                                     │
│    │   → 下一轮守护轨根据结果做 autoInquiry           │
│                                                     │
│  冲突解决:                                           │
│    LLM focus 的条目 → protectedBy = "llm"             │
│    → 守护轨不会驱逐 LLM 明确要保护的东西               │
│    但 critical 级别的 MANDATORY 警告 → 守护轨始终注   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 6. SKILL.md (Skill 自述文件)

```markdown
# Context Skill — 上下文中间层

你运行在一个有上下文窗口限制的环境中。本 Skill 帮助你管理注意力：
该看的东西始终在眼前，不需要的东西自动消失，忘了的东西需要时会回来。

## 三层上下文

L0 (指令) — 你是谁、能用什么工具、什么规则。这些不会变。
L1 (活跃) — 你正在用的文件和当前任务。框架自动维护。
L2 (历史) — 你之前做过的事，已压缩为摘要。指针指向完整记录。
L3 (存档) — 完整上下文在磁盘。框架在相关时自动推摘要到 L1。

## 你不需要手动管理

框架每步自动做这些事（你不费 token）：
- 你编辑文件 → 关联的历史胶囊摘要自动出现
- 你的方案跟已知放弃的方案冲突 → ⚠️ 告警自动出现
- 你编辑了标记 KNOWN_BUG 的代码 → ⚠️ 提醒自动出现
- 旧历史 → 自动压缩

## 你可以主动用这些工具

focus:file(path)      — 告诉框架"这个文件很重要，保护它"
forget:noise(pattern) — 批量清理日志/报告类噪音
recall:context(id)    — 展开一个完整的历史胶囊
recall:memory(query)  — 搜索长期记忆
summarize:recent(N)   — 子阶段完成，打包为摘要
reflect               — 查看上下文健康度
pack:subtask(id)      — 子任务完成，打包全部上下文为胶囊

## 原则

1. 编辑中的文件优先级最高 → 不确定就 focus:file
2. 看到噪音 (日志/报告/进度条) → forget:noise
3. 完成子阶段 → summarize:recent 然后继续
4. 感觉不确定时 → reflect 看看健康度
5. 守护轨给的东西 (⚠️/💡/🔒) 要认真对待，那是框架帮你发现的问题
```

---

## 7. 跟之前两个版本的关键区别

| | v1 应急驱逐 | v1.5 温度分层 | v2 推挽双轨 | **v3 Context Skill** |
|---|---|---|---|---|
| 框架判断 | 窗口满了才管 | 温度自然衰减 | 框架强制推 | **框架推 + 框架质询** |
| LLM 参与 | 不需要 | 期望但不强制 | 不需要 | **有 MCP 工具可选** |
| 注入路径 | manage() 内部压缩 | L1→L2→L3 迁移 | appendObservation | **appendObservation + MCP 工具** |
| 信息密度 | 追求最小 | 追求自然衰减 | 追求精准推入 | **追求 LLM 不费力就能看到** |
| 盲区风险 | 低 (驱逐丢数据) | 高 (L3 不可见) | 中 (推入规则盲区) | **低 (质询 + 互动两条线) |
| 作为 Skill 分发 | ❌ | ❌ | ❌ | **✅ 有 SKILL.md** |
| 总复杂度 | 低 | 中 | 高 | **中等偏高 (但基于已有代码)** |

---

## 8. 实现路径

基于现有 `E:\Develop\SrcuctAgent\packages\context\src\manager.ts`：

```
第 1 天: autoInquiry 质询引擎
  └── 在 autoManage() 末尾加 runInquiry()
  └── 冲突检测 / 缺口检测 / 一致性检测
  └── 用 appendObservation() 注入

第 2 天: MCP 工具集 (互动轨)
  └── 每个工具 = 包装已有方法
  └── focus:file → ContextManager.focusFile()
  └── forget:noise → 正则匹配 + forgetEntry
  └── recall:context → 加载胶囊 + appendObservation
  └── pack:subtask → buildCapsule + replaceWithPointer

第 3 天: 胶囊系统
  └── CapsuleStore (磁盘存储)
  └── buildCapsule / loadCapsule / saveCapsule
  └── auto_push_rules 生成

第 4 天: SKILL.md + 集成
  └── SKILL.md 编写
  └── 端到端测试: 守护轨 + 互动轨协作
  └── A/B 对比 (vs Phase 0-1 baseline)

总计: 4 天
```

---

## 9. 一条信息的完整生命周期

```
Step 1: LLM 读入 auth.ts
  → appendToolResult(read_file, 15K)
  → 守护轨: preprocessToolOutput (去掉注释噪音)
  → 条目在 L1，完整保留

Step 3: LLM 编辑 auth.ts，查了 auth.test.ts
  → auth.test.ts 进入 L1
  → auth.ts 仍被引用，保持在 L1

Step 5: LLM 不碰 auth.test.ts 了
  → 守护轨: compressHistory (auth.test.ts 不变，但原始入口在 L1)
  
Step 8: 子任务完成
  → LLM 调用 pack:subtask("fix_token_refresh")
  → 框架打包: auth.ts + auth.test.ts + 决策 + 测试结果 → capsule
  → L1 中移除原始大块内容
  → L2 中留下指针: 📦 capsule:fix_token_refresh (完整记录)
  → capsule 存磁盘

Step 12: LLM 再次编辑 auth.ts
  → 守护轨 autoInquiry: 文件 auth.ts 关联 capsule:fix_token_refresh
  → injectCapsuleHint: "💡 关于 auth.ts 有历史上下文 ..."
  → LLM 看到提示 → 如果细节不确定 → recall:context("fix_token_refresh")
  → 完整胶囊展开 → 注入 L1
  
Step 15: LLM 尝试用全局锁
  → 守护轨 autoInquiry: 检测到全局锁方案 ∈ capsule 已放弃方案
  → injectConflictWarning: "⚠️ 该方案已被放弃，原因: 耦合太强"
  → LLM 收到警告 → 重新考虑 → 避免了踩坑
```

---

## 10. 一句话

> Context Skill 不是一个工具集。它是一个在 Agent 和 LLM 之间运行的守护进程。
> 它不替 LLM 写代码，只替 LLM 做一件事：确保 LLM 的注意力花在该花的地方。
> 守护轨推的是"你不知道你需要知道的东西"。
> 互动轨拉的是"你知道你需要但不在眼前的东西"。
> 两条轨加起来 = LLM 永远不需要在垃圾堆里找钥匙。
