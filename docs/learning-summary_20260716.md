# 五方对比与学习总结：StructFocus 的差距和方向

> 日期：2026-07-16
> 对比对象：腾讯 Agent Memory / Manus / OpenViking / Letta(MemGPT) / StructFocus(我们)

---

## 一、五方一句话定位

| 项目 | 一句话定位 | 核心隐喻 |
|---|---|---|
| **腾讯 Agent Memory** | Agent 的**记忆层**插件（短期卸载+长期分层） | 外接硬盘 |
| **Manus** | 完整 **Agent 产品**（规划+执行+验证+记忆） | 操作系统 |
| **OpenViking** | Agent 的**上下文数据库**（文件系统范式统一管理） | 文件系统 |
| **Letta (MemGPT)** | Agent 的**虚拟内存管理器**（OS 式分层分页） | 虚拟内存 |
| **StructFocus (我们)** | Agent 的**上下文调度中间层**（注意力+版本化+审计） | CPU 调度器 |

---

## 二、五方核心能力矩阵

| 能力 | 腾讯 Agent Memory | Manus | OpenViking | Letta | StructFocus |
|---|---|---|---|---|---|
| **上下文卸载到外部** | ✅ refs/*.md + node_id | ✅ 文件系统 | ✅ viking:// 虚拟FS | ✅ archival memory 分页 | ❌ forget 是删除 |
| **分层加载（L0/L1/L2）** | ⚠️ Mermaid 符号 vs 完整原文 | ❌ | ✅ 摘要/概览/全文三级 | ⚠️ core vs archival 两级 | ❌ |
| **任务状态符号化** | ✅ Mermaid 画布 | ⚠️ todo.md | ❌ | ❌ | ❌ |
| **长期记忆分层** | ✅ L0-L3 四层金字塔 | ✅ Working/Hot/Cold | ✅ 6 类自动提取+去重 | ✅ core/archival 两级 | ⚠️ 扁平 InMemory/SQLite |
| **LLM 自主记忆管理** | ❌ 系统侧拦截 | ⚠️ 手动写文件 | ✅ 自动提取 | ✅ LLM 自己决定 page in/out | ❌ 引擎自动 |
| **Git 版本化** | ❌ | ❌ | ⚠️ 版本追踪（非 Git） | ❌ | ✅ commit/branch/merge |
| **注意力审计/度量** | ❌ | ⚠️ todo.md 复述 | ❌ | ❌ | ✅ 条目级量化 |
| **prompt cache 友好** | ❌ | ✅ 稳定前缀纪律 | ❌ | ⚠️ core memory 稳定 | ✅ I-Context 架构隔离 |
| **检索方式** | 向量+node_id grep | 文件系统 grep | 目录递归+向量+意图分析 | 向量+LLM 自主搜索 | FTS5+中文 2-gram |
| **可观测性** | ⚠️ node_id 溯源 | ⚠️ 文件日志 | ✅ 可视化检索轨迹 | ⚠️ /dump 命令 | ✅ reflect 审计日志 |
| **实测数据** | ✅ -61% token | ✅ -80% 上下文 | ✅ -91% token | ✅ 突破窗口限制 | ⚠️ -27.7% |
| **生态适配** | ✅ OpenClaw+Hermes | ✅ 完整产品 | ✅ OpenClaw 插件 | ✅ SDK+REST API | ❌ MCP 有但无真实接入 |
| **多租户/企业级** | ⚠️ VectorDB 依赖 | ❌ | ✅ viking:// scope 隔离 | ⚠️ | ❌ |
| **协议** | MIT | 闭源 | Apache 2.0 | Apache 2.0 | Apache 2.0（计划） |

---

## 三、我们要学什么（按优先级排序）

### P0：必须学——核心方向修正

#### 1. 上下文卸载（Context Offloading）— 学腾讯/Manus/OpenViking

**问题**：我们的 `forget` 是把条目从 D-Context 删除，信息不可恢复。
**学什么**：
- 腾讯：原始内容写到 `refs/*.md` 外部文件，上下文留 node_id 索引
- Manus："可逆压缩"——保留 URL/路径即可删除网页内容，需要时重新读取
- OpenViking：L2 全文存外部，L0 摘要留上下文

**怎么落地**：
- `forget(file)` 不删除，而是：① 将完整内容写入 `refs/<hash>.md` ② 在 D-Context 保留 `ContextPointer`（含 contentRef、topic、importance） ③ 需要时 `expand(pointerId)` 还原
- 这正是 `PointerRegistry` 的设计初衷——**双向可逆指针**，比腾讯的单向 node_id grep 更强

#### 2. 分层加载（L0/L1/L2）— 学 OpenViking

**问题**：我们的 focus 只有 symbols/summary/full 三级粒度，但没有自动分层——每次 focus 都是全量加载或全量卸载。
**学什么**：
- OpenViking：L0 摘要 ~100 tokens（始终加载）、L1 概览 ~2k tokens（按需）、L2 全文（精确查询）
- 加载策略：先看 L0 判断相关性，再看 L1 获取结构，确实需要时才加载 L2

**怎么落地**：
- focus 时自动生成三级视图：L0 = 文件摘要+关键符号列表、L1 = 结构化大纲、L2 = 完整内容
- autoManage 在预算紧张时自动降级（L2→L1→L0），而非直接驱逐
- 这和 PointerRegistry 的"展开/压缩"是同一机制的两个面

#### 3. 恢复 PointerRegistry 并接入主循环

**问题**：PointerRegistry 被误标 deprecated，从导出移除。
**怎么落地**：
- 恢复导出
- `PointerRegistry` 接入 `forget`（自动创建指针）和 `recall`/`expand`（按需还原）
- 指针包含：`{ id, type, topic, files, keywords, importance, contentRef, summary }`
- 指针本身是轻量的（<200 tokens），可以在上下文中常驻

---

### P1：应该学——显著提升效果

#### 4. 任务状态符号化（Mermaid 画布）— 学腾讯

**问题**：D-Context 是线性 commit 序列，Agent 看不到任务拓扑结构。
**学什么**：
- 腾讯：把任务状态表示为 Mermaid 图，每个节点有 node_id，关联外部原文
- Agent 看着图谱推理，需要细节时按 node_id 下钻

**怎么落地**：
- D-Context 的每次 commit 可以序列化为 Mermaid 节点：`step_001["读取文件 X"] --> step_002["修改函数 Y"]`
- `toMessages()` 时，如果 D-Context 超过阈值，自动生成 Mermaid 摘要替代线性历史
- 这比纯文本截断节省更多 token，且结构信息不丢

#### 5. LLM 自主记忆管理 — 学 Letta

**问题**：我们的记忆管理是引擎侧自动的，LLM 没有发言权。
**学什么**：
- Letta：LLM 自己决定什么放进 core memory、什么 page out 到 archival、什么 recall 回来
- 类似 OS 的页面置换——但由 LLM 自己当"操作系统"

**怎么落地**：
- 在六原语基础上，允许 LLM 主动调用 `remember`/`recall`/`forget` 工具
- autoManage 仍然做兜底（预算超限时强制驱逐），但 LLM 可以优先级提示
- 这样 LLM 的"注意力"和引擎的"预算管理"形成双层决策

#### 6. 目录递归检索 — 学 OpenViking

**问题**：我们的 recall 是扁平 FTS5 搜索，没有目录/层级概念。
**学什么**：
- OpenViking：先定位高相关目录→目录内二次检索→递归子目录→聚合结果
- 比扁平向量搜索召回精度提升 ~40%

**怎么落地**：
- MemoryBackend 增加"目录"概念：按 topic/project/task 分目录存储
- recall 时先匹配目录名，再在目录内做 FTS5/向量搜索
- 这比纯全文搜索更精准，且天然支持多项目隔离

---

### P2：可以学——锦上添花

#### 7. KV cache 纪律 — 学 Manus

**问题**：I-Context 已经架构级保证了稳定性，但工具定义部分仍可能变动。
**学什么**：
- Manus：工具定义固化、仅追加不修改、显式 cache 断点
- 工具定义放 I-Context 前部，保持不变

**怎么落地**：
- 工具注册后生成 hash，hash 不变则不重新序列化
- 在 I-Context 中插入 `cacheControl` 断点（已有实现），补充"工具定义冻结"约束

#### 8. 可视化检索轨迹 — 学 OpenViking

**问题**：reflect 审计日志是文本，不够直观。
**学什么**：
- OpenViking：检索过程可视化——从哪个目录开始、经过哪些节点、最终加载了什么

**怎么落地**：
- reflect 增加 `retrievalTrace` 字段，记录 recall 的完整路径
- 可选：生成 Mermaid 图展示检索轨迹

#### 9. 自动记忆提取 — 学 OpenViking/腾讯

**问题**：我们的 remember 需要引擎手动触发或 LLM 显式调用。
**学什么**：
- OpenViking：会话结束时自动提取 6 类记忆（profile/preferences/entities/events/cases/patterns）
- 腾讯：L1 原子记忆自动抽取（事实/偏好/约束/阶段结论）

**怎么落地**：
- autoManage 在任务结束时自动扫描 D-Context，提取决策、错误、模式
- 写入 MemoryBackend 的对应分类（而非扁平存储）

#### 10. 多 Agent 记忆共享 — 学 Letta

**问题**：我们暂时没有多 Agent 协作场景。
**学什么**：
- Letta：跨 Agent 记忆同步、分布式存储、协作式检索

**怎么落地**：
- 后续 Phase 考虑：PointerRegistry 的 contentRef 可以指向共享存储
- D-Context 的 branch 机制天然支持子任务隔离和合并

---

## 四、不要学什么

| 不学 | 原因 |
|---|---|
| 腾讯的 VectorDB 依赖 | 我们不绑定特定基础设施 |
| Manus 的 CodeAct 执行引擎 | 我们是中间层，不做执行 |
| Manus 的 token logits 屏蔽 | 需要解码层介入，超出中间层职责 |
| OpenViking 的 VLM 依赖 | 摘要生成不应依赖视觉模型 |
| Letta 的完整 REST Server | 我们是 SDK/MCP，不是独立服务 |

---

## 五、学习优先级路线图

```
Phase 2（当前）：P0 三项
├── 1. Context Offloading（forget→外部文件+指针）
├── 2. 分层加载 L0/L1/L2（focus 三级视图+自动降级）
└── 3. PointerRegistry 恢复+接入主循环

Phase 3：P1 三项
├── 4. Mermaid 任务画布（D-Context→符号化）
├── 5. LLM 自主记忆管理（六原语作为工具暴露）
└── 6. 目录递归检索（MemoryBackend 分目录）

Phase 4+：P2 四项
├── 7. KV cache 纪律强化
├── 8. 可视化检索轨迹
├── 9. 自动记忆提取（6 类）
└── 10. 多 Agent 记忆共享
```

---

## 六、核心判断

**我们不是在重复造轮子。** 五方各有侧重：

- 腾讯 = 记忆层（跨会话+卸载）
- Manus = 完整 Agent（执行+成本优化）
- OpenViking = 上下文数据库（文件系统范式+分层加载）
- Letta = 虚拟内存（LLM 自主分页）
- 我们 = 上下文调度中间层（注意力+版本化+审计）

**我们的差异化**：哈佛架构（I/D 分离）、Git 版本化、注意力审计——这三样没有人做。

**但我们的短板很明显**：上下文卸载、分层加载、记忆分层、实测数据都不如四家。P0 三项是生存线，必须先补齐。
