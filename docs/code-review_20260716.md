# 代码审查：用户修改后的 StructAgent

> 日期：2026-07-16
> 审查范围：全仓库 packages/context + packages/mcp + packages/app

---

## 一、用户改了什么（相比上次 7/15 的状态）

### 新增模块

1. **`ContentStore`**（`content-store.ts`）— 外部内容存储
   - 被截断/驱逐的条目完整原文写入磁盘（`.structagent/content-store/entries/<shard>/<id>.json`）
   - 按 entry id 哈希分 256 片，避免单目录文件膨胀
   - 支持 `save` / `load` / `loadByFile`（按文件路径批量恢复）
   - **这正是我们 P0 建议的"上下文卸载"的落地实现**

2. **`CapsuleStore`**（`capsule.ts`）— 知识胶囊系统
   - 子任务级别的完整上下文打包（文件/决策/约束/已放弃方案/原始条目 ID）
   - `CapsuleStore.buildCapsule()` 自动从内容中提取决策信号、已知限制、已放弃方案
   - `CapsuleStore.summaryText()` 生成轻量摘要（<200 tokens）用于注入
   - `findByFile()` 支持按文件路径查找关联胶囊
   - **这是"做完一件事后自动压缩打包成指针"愿景的落地**

3. **守护轨质询引擎**（`manager.ts` 中 `runInquiry()`）
   - 冲突检测：LLM 提议的方案是否触及已放弃方案（关键词匹配 ≥2 命中则告警）
   - 缺口检测：编辑文件有历史胶囊但未被引用 → 自动推入胶囊摘要
   - 一致性检测：编辑文件有已知限制 → 注入告警
   - 自动更新胶囊约束（检测到 UNHANDLED/DATA LOSS 时）
   - **这是腾讯/Manus 没有的差异化能力——框架主动帮 LLM 避坑**

4. **`pack:subtask` / `expandCapsule`** — 胶囊打包与展开
   - 收集活跃条目 → 构建胶囊 → 保存磁盘 → 压缩原始条目为指针 → 注入指针 observation
   - 展开时从磁盘加载完整胶囊 → 注入 L1

5. **可逆还原 API**：`expandEntry` / `recallFromStore` / `recallByFile` / `uncompressEntry`
   - 截断条目可通过 `expandEntry` 恢复 `originalContent`
   - 驱逐条目可通过 `recallFromStore` 从 ContentStore 加载
   - 按文件路径批量恢复 `recallByFile`

6. **MCP Server**（`packages/mcp/`）— 独立 MCP 包
   - 零依赖 JSON-RPC over stdio
   - 18 个工具（原 12 + 新增 forget:noise / recall:context / pack:subtask / summarize:recent / summarize:conversation / stats / budget）

7. **Context Skill v3 统一设计**（`SKILL.md` + `docs/context-skill-v3-unified_20260716.md`）
   - 四层上下文模型（L0 指令 / L1 活跃 / L2 历史 / L3 存档）
   - 守护轨（框架自动）+ 互动轨（LLM 主动调用）双轨设计
   - 信息生命周期完整描述（Step 1 进入 → Step 5 驱逐 → Step 8 打包 → Step 12 展开 → Step 15 冲突告警）

### 架构变化

- **`ContextEntry` 类型扩展**：新增 `originalContent`、`compressed`、`compressedContent`、`compressedTokenCount`、`evicted`、`evictedAt`、`externalRef` 字段
- **驱逐/截断变为非破坏式**：所有被驱逐/截断的内容都保存到 ContentStore，可随时还原
- **`autoManage()` 新增 `runInquiry()`**：每步末尾自动运行守护轨质询
- **`toMessages()` 仍走六层 Builder 管线**：但历史层渲染时优先用 `compressedContent`

---

## 二、测试状态

- **29 tests 全部通过**（6 个测试文件）
- 测试覆盖：基础追加/驱逐、三层管理（70%/85%/90%）、焦点保护、记忆 recall/remember、autoRecall 注入、preprocess 六阶段去噪、structuredCompress、预算估算
- **缺少测试**：ContentStore、CapsuleStore、runInquiry、packSubtask、expandEntry/recallFromStore——这些新模块没有单测

---

## 三、代码质量评估

### 做得好的

1. **P0 方向正确落地**：ContentStore 实现了上下文卸载，CapsuleStore 实现了指针压缩打包，`expandEntry`/`recallFromStore` 实现了可逆还原
2. **守护轨质询是真正的差异化**：没有竞品做这个（腾讯/Manus/OpenViking/Letta 都没有框架级冲突检测）
3. **SKILL.md 写得非常好**：信息生命周期图清晰，LLM 能看懂什么时候用 focus/forget/recall/pack
4. **零外部依赖原则保持**：ContentStore 用 `node:fs`，CapsuleStore 用 `node:fs`，MCP 用 `node:readline`

### 需要修的

#### P0 — Bug

1. **`manager.ts` 构造函数中 CapsuleStore 被重复初始化 11 次！**
   ```ts
   this.capsules = new CapsuleStore(...);  // 重复 11 次
   ```
   这是个明显的编辑错误，虽然不影响功能（最后一次覆盖），但非常难看且浪费。

2. **`evictEntries` 的 `_taskContext` 参数未使用**（标了下划线但仍在签名中），应移除或接入。

3. **MCP `summarize:recent` 实现不完整**：
   ```ts
   // 简化：直接调用 getReflection 后手动压缩
   const compressed = manager.compressOldEntries();
   ```
   没有真正按"最近 N 步"压缩，只是调了 `compressOldEntries()`（它压缩的是所有旧条目）。

4. **MCP `summarize:conversation` 同样不完整**：`sinceStep` 参数被接收但未使用。

5. **`forget:noise` 实现有 bug**：调用 `manager.forgetFile(e.source ?? ...)`)，但如果 `e.source` 是 `undefined`，会用 `noise-${e.id}` 作为 target，而 `forgetFile` 按 `source` 字段匹配，不会匹配到条目自身的 id。

#### P1 — 设计缺陷

6. **ContentStore `loadByFile` 是全盘扫描**：遍历所有 shard 目录的所有 JSON 文件。条目多了会非常慢。需要建索引（source → entryIds 的反向索引）。

7. **`CapsuleStore.findByFile` 同样全盘扫描**：遍历所有胶囊文件。需要建文件索引。

8. **`runInquiry` 每步调用 `capsules.list()` + `capsules.load()` 全盘扫描**：如果胶囊多了，每步都全盘扫描会很慢。建议在内存维护一个胶囊索引。

9. **`structuredCompress` 仍然是裁剪而非真正的指针压缩**：虽然锚点提取有价值，但它不生成外部指针。真正的指针压缩由 `packSubtask` + CapsuleStore 承担了，`structuredCompress` 退化为"锚点提取器"——这可以接受，但名字有误导性。

10. **没有 ContentStore/CapsuleStore 的单测**：新模块逻辑复杂（分片、序列化、胶囊构建、约束提取），缺测试是风险。

#### P2 — 优化建议

11. **ContextEntry 的 `originalContent` 和 ContentStore 存了双份**：截断时 `entry.originalContent = original` 又 `store.save({ originalContent: original })`。建议只存 ContentStore，`entry` 只保留 `externalRef` 指针。

12. **MCP `reset` 创建新 ContextManager 但不保留 storeRoot 配置**：reset 后 ContentStore/CapsuleStore 路径回到默认 `process.cwd()`。

13. **`focusFile` 不使用 ContentStore 恢复**：如果之前 forget 了某文件，focus 时不检查 ContentStore 是否有历史内容。

---

## 四、与学习总结的对照

| P0 建议 | 落地状态 | 备注 |
|---|---|---|
| 上下文卸载 | ✅ 已落地 | ContentStore 实现，forget/evict/truncate 都写入外部存储 |
| 分层加载 L0/L1/L2 | ⚠️ 部分落地 | CapsuleStore 有 summaryText（L0）和完整胶囊（L2），但没有 L1 概览层 |
| 恢复 PointerRegistry | ✅ 已落地 | 以 CapsuleStore + ContentStore 的形式实现，比原 PointerRegistry 更完整 |

| P1 建议 | 落地状态 | 备注 |
|---|---|---|
| Mermaid 任务画布 | ❌ 未落地 | D-Context 仍是线性序列 |
| LLM 自主记忆管理 | ⚠️ 部分 | MCP 暴露了 remember/recall 工具，但 LLM 不能自主 page in/out |
| 目录递归检索 | ❌ 未落地 | Memory 仍是扁平 FTS5 |

| 额外实现（不在学习总结中） | 状态 |
|---|---|
| 守护轨质询引擎 | ✅ 独有差异化 |
| 知识胶囊系统 | ✅ 比腾讯 refs/*.md 更完整 |
| 可逆还原 API | ✅ expandEntry + recallFromStore + recallByFile |

---

## 五、评分

**7.5/10**（比上次 7.4 略升）

- **方向修正到位**：P0 三项中两项完全落地，PointerRegistry 以更完整的形态回归
- **新模块缺测试**：ContentStore、CapsuleStore、runInquiry 都是复杂逻辑但零测试
- **构造函数 bug**：CapsuleStore 重复初始化 11 次是明显的编辑失误
- **MCP 工具半成品**：summarize:recent 和 summarize:conversation 没有真正实现
- **全盘扫描性能隐患**：ContentStore.loadByFile、CapsuleStore.findByFile、runInquiry 每步全盘扫描

**突破 8 分需要**：
1. 修复构造函数 bug
2. 补齐新模块单测（ContentStore/CapsuleStore/runInquiry/packSubtask/expandEntry）
3. 完成 summarize:recent/conversation 实现
4. 建索引解决全盘扫描性能问题
5. 补 L1 概览层（胶囊的中间摘要）
