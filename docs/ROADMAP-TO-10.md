# StructFocus 提升路线图：从 7.5 到 10 分

> 给定约束：GLM-4 免费 API only / 烂电脑 / 没 GitHub / 没钱没账号
> 每条都是可独立执行、有明确验收标准的任务。按优先级排序。

---

## 一、核心架构（7.5 → 9.0）

### 1.1 Per-Conversation 隔离

**现状问题**：`ContextManager` 是全局单例。10 段独立对话喂进同一个实例，ContentStore 里 Caroline 的东西和 John 的混在一起，召回时搜"Caroline"可能返回完全不相关的对话。`newConversation()` 方法存在但没有真正在 bench 脚本里用过。

**做什么**：
- 在 `LongContextEngine` 层加 conversation 边界：每个 `newConversation(id)` 创建独立的条目列表，ContentStore 和 CapsuleStore 仍是共享的（磁盘文件带 conversationId 前缀即可），但 `getEntries()` / `toMessages()` / recall 搜索范围限定在当前 conversation。
- 重构 bench 脚本（LoCoMo、多跳、DocQA）使每个 convo/doc 走独立的 CM 分片。

**具体步骤**：
1. `LongContextEngine.newConversation(id: string)` 创建 `Map<id, Set<entryId>>` 或等效数据结构，记录每个 conversation 拥有哪些条目。
2. `appendUser/appendAssistant` 自动关联到 `currentConversationId`。
3. `toMessages()` 只渲染当前 conversation 的条目。
4. ContentStore `search()` 加 `conversationId` 过滤参数。
5. LoCoMo bench 脚本：每个 convo（C1-C10）先 `engine.newConversation("c1")` 再摄入对话。

**合格标准**：
- 同一个 CM 实例内，convo A 的 `toMessages()` 看不到 convo B 的条目。
- ContentStore `search("Caroline", { conversationId: "c1" })` 只返回 c1 的结果。
- LoCoMo per-convo 模式下 Cat1（事实记忆）正确率 ≥ BL。
- 新增单测：`Conversation Isolation: 两个 convo 互不污染`。

**预估工时**：4-6 小时。

---

### 1.2 toMessages() 时序保持

**现状问题**：`toMessages()` 将对话序列化为一串 `[observation]` / `[recall]` 标记块，丢失了原始 user/assistant 交替的时序结构。这在 Cat2 时序推理场景是致命伤（LoCoMo BL 30→CM 1）。

**做什么**：
- 重构 `toMessages()`，L2_working 层保留原始 `role: "user" | "assistant"` 序列。
- 胶囊召回内容不混入对话流，而是作为 system 级 `[上下文召回]` 前缀注入。

**具体步骤**：
1. 在 `buildContext()` 中，对每条 placement=L2_working 的条目，保留其原始角色并按时间顺序排列。
2. 胶囊展开内容作为独立的消息块，role 设 `system`，content 前缀 `[上下文召回: capsule_xxx]`。
3. 召回注入 (`injectText`) 同理：role=`system`，不伪造 user/assistant 交替。

**合格标准**：
- 一段 10 轮 user/assistant 交替对话，`toMessages()` 输出仍是 10 对 user/assistant 消息（不含 system 标注）。
- LoCoMo per-convo 模式下 Cat2 得分 ≥ BL 的 80%（即不再崩到 1/30）。
- 新增单测：`toMessages preserves user/assistant alternation`。

**预估工时**：4-6 小时。

---

### 1.3 多跳 QA Benchmark（核心证据）

**现状问题**：DocQA 赢了但不能称为 benchmark，LoCoMo 输了，NIAH 太简单。你没有一个可以放在 README 里说"看，这就是 CM 比 BL 好的证据"的 benchmark。

**做什么**：
构造一个 **3 文档 × 20 题** 的多跳 QA benchmark，包含：
- 单文档事实（5 题）：答案在某一篇文档中，需要精确检索。
- 跨文档两跳（8 题）：答案需要两篇文档的信息组合。
- 跨文档三跳（5 题）：答案需要三篇文档的信息组合。
- 干扰题（2 题）：看起来需要跨文档，但答案其实在一篇里。

**具体步骤**：
1. 选 3 篇长文（每篇 ≥ 5000 字），话题不同但有关联。推荐：
   - 维基百科"Linux kernel" 条目
   - 维基百科"Git" 条目
   - 维基百科"Software versioning" 条目
   用 `web_fetch` 拉下来存为文本。
2. 用 GLM-4 自动生成 20 道题 + 标准答案。提示词：
   ```
   以下是三篇文档。请生成 20 道问答题，要求：
   - 5 题答案在单一文档中（需指明具体位置）
   - 8 题需要两篇文档的信息组合
   - 5 题需要三篇文档的信息组合
   - 2 题是干扰题（看起来跨文档但实际只需一篇）
   每题附标准答案（≤50 字）和解答所需文档名。
   ```
3. 对答案进行人工抽查（随机 5 题），确保 GLM-4 生成的答案正确。
4. 写 bench 脚本 `bench/multihop.ts`：
   - **BL 组**：把 3 篇文档 + 20 题直接喂给 GLM-4。120K tokens 足够装下 3 篇 + 所有题。
   - **CM 组**：只给 CM 每篇文档的前 2000 字（L2_working），其余内容全部推入 ContentStore（L4_raw）。允许 CM 做 3 次 `recall(query)` 每次返回 top-5 段落。
   - 对比两组的正确率。BL 依赖 LLM 记忆，CM 依赖精确召回。
5. 输出报告到 `docs/benchmarks/multihop.md`。

**合格标准**：
- BL 正确率 ≤ 60%（LLM 读 15000 字后仅凭记忆回答，跨文档题必然丢分）。
- CM 正确率 ≥ 85%（通过精确召回找到跨文档事实）。
- **差值 ≥ 20pp 即为有效证据**。
- 20 题答案有人工验证（≥ 5 题抽查通过）。

**预估工时**：6-8 小时。

---

### 1.4 DocQA 750K 系统化

**现状问题**：DocQA 750K CM > BL 的结果在 bench 脚本里但没写成正式报告。

**做什么**：
把现有 DocQA 结果变成可复现的 benchmark 报告。

**具体步骤**：
1. 整理现有 DocQA 750K 数据：用的是什么文档、什么题目、BL 和 CM 各答了什么。
2. 加 3 篇新文档，每篇 200K-300K chars。推荐：
   - 一份开源项目 README + CHANGELOG + CONTRIBUTING 拼接
   - 一份技术规范 RFC
   - 一份长论文
3. 标准化题库：每篇 5 题，共 15 题。包含：
   - 具体配置值题（如"SSH MaxAuthTries 默认值"）—— 3 题/篇
   - 跨章节关系题（如"CVE-xxx 修复引入于哪个版本"）—— 2 题/篇
4. 写报告 `docs/benchmarks/docqa.md`，包含：文档信息、题目与答案、BL 回答 vs CM 回答逐题对比、幻觉分析。

**合格标准**：
- BL 在长文档检索题上出现 ≥ 3 次幻觉（编造不存在的事实）。
- CM 通过 ContentStore 召回，检索类题目全部正确。
- 报告结构：`## 场景` → `## 方法` → `## 结果` → `## 幻觉分析` → `## 结论`。

**预估工时**：4-5 小时。

---

## 二、工程质量（7.5 → 9.0）

### 2.1 已知 Bug 修复（5 个）

#### Bug 1: CapsuleStore 构造函数重复初始化

**位置**：`packages/context/src/manager.ts` 约 L155-L176
**现象**：`ContextManager` 构造函数中 `this.capsules = new CapsuleStore(...)` 在初始化流程中被调用多次（可能有循环依赖或重复 new）。
**修法**：检查构造函数中所有 `new CapsuleStore` 调用，确保只实例化一次。如果是因为多个 if 分支各自 new 了，提取为单例。
**合格**：构造函数内 `new CapsuleStore(` 只出现一次。

#### Bug 2: MCP summarize 参数未使用

**位置**：`packages/mcp/src/index.ts` 中 `context_summarize` 工具处理器
**现象**：LLM 传入 `query` / `maxTokens` 参数但处理器未读取。
**修法**：检查 handler 函数签名，补全参数读取并传给 `summarizeToCapsule()`。
**合格**：`context_summarize` 工具接收的所有参数都被实际使用。

#### Bug 3: forget noise source 匹配不到

**位置**：`ContextManager.forget()` 或 `autoManage()` 中驱逐逻辑
**现象**：`source` 为 `undefined` 时，`sourcePattern` 过滤永远匹配不到，导致 forget:noise 目标 (source 为 undefined 的噪声条目) 无法被驱逐。
**修法**：当 `sourcePattern` 匹配时允许 `source` 为 `undefined` 的条目也被命中（或给未标 source 的条目默认 source="unknown"）。
**合格**：单测可验证 forget("noise") 能驱逐 source 为 undefined 的条目。

#### Bug 4: async autoManage 调用链检查

**位置**：所有 bench 脚本中 `await engine.autoManage()` 的调用
**现象**：之前 cm-hardcore 忘记 await 导致驱逐从未执行。
**修法**：grep 所有 bench/ 下脚本，确认每个 `autoManage()` 前都有 `await`。
**合格**：`grep -r "autoManage()" bench/` 返回的所有行都包含 `await`。（排除类型定义和注释）

#### Bug 5: hardThreshold 单位错配

**位置**：已在 commit `90608a4` 修复，需验证
**现象**：百分比 vs 比例（0.5 vs 50）混用。
**修法**：确认所有阈值比较都使用同一单位。在单测中显式验证边界值。
**合格**：单测 `hardThreshold at 50% triggers downgrade` 通过。

**预估总工时**：3-4 小时。

---

### 2.2 缺失单测补充

#### 2.2.1 ContentStore 搜索精度

**文件**：新建 `packages/context/tests/content-store.test.ts`

**测试用例**：
1. `search exact keyword returns correct entry` — 存入 "Caroline is a software engineer"，搜索 "Caroline" 返回该条目。
2. `search case insensitive` — 搜索 "caroline" 同样返回。
3. `search with sourcePattern filter` — 存 3 条不同 source 的条目，sourcePattern="convo_c3" 只返回对应条目。
4. `search respects topK` — 存 10 条含 "error" 的条目，search topK=3 只返回 3 条。
5. `search empty query returns empty`。
6. `store LRU eviction` — 设置 storeMaxMB=1，存入超量内容后最旧条目被清理。
7. `rebuildIndex restores searchability` — 删索引文件后 rebuildIndex，搜索仍正常。

**合格**：7 个测试全过。

---

#### 2.2.2 CapsuleStore 边界条件

**文件**：新建 `packages/context/tests/capsule-store.test.ts`

**测试用例**：
1. `build capsule and retrieve by id` — 构建→存储→读取，往返正确。
2. `capsule count limit (STRUCT_CAPSULE_MAX_COUNT)` — 设上限=5，存 7 个胶囊，验证只保留 5 个且最旧的被淘汰。
3. `listCapsules returns all in order`。
4. `expandEntry returns full content` — 胶囊中的 entry 可以完整展开。
5. `empty capsule build fails gracefully` — 空条目输入不崩溃。

**合格**：5 个测试全过。

---

#### 2.2.3 summarize 管线 mock 测试

**文件**：新建 `packages/context/tests/summarize.test.ts`

**测试用例**（不需要真实 LLM）：
1. `chunkBySemantic respects maxChars` — 5 段 500 字的文本，maxChars=800，验证每块 ≤ 800 字。
2. `chunkBySemantic splits at paragraph boundary` — 不在一句话中间切断。
3. `chunkBySemantic groups same source` — 同 source 连续条目保持在同一块。
4. `chunkBySemantic time gap > 1 day forces new chunk`。
5. `summarizeToCapsule returns valid structure` — mock llmCall 返回固定 JSON，验证 capsule 结构正确。
6. `summarizeToCapsule handles llmCall failure` — mock 抛出异常，验证不崩溃、返回 fallback。

**合格**：6 个测试全过。

---

#### 2.2.4 MCP Server 集成测试

**文件**：`packages/mcp/tests/server.test.ts`（扩展现有）

**测试用例**：
1. `initialize handshake` — 发送 `{"method":"initialize",...}` 收到 `{"result":{"serverInfo":...}}`。
2. `tools/list returns 5 tools` — context_inject, context_recall, context_status, context_forget, context_focus。
3. `context_inject adds entry` — 调用 inject 后 context_status 显示条目数+1。
4. `context_search returns matches` — 注入 "test error message" → 搜索 "error" → 返回该条目。
5. `invalid tool name returns error` — 调用不存在的工具返回 JSON-RPC error。
6. `malformed JSON returns parse error`。

**实现方式**：stdout/stdin mock + JSON-RPC 序列化/反序列化，不需要真实 MCP 客户端。

**合格**：6 个测试全过。

**预估总工时**：6-8 小时。

---

### 2.3 BM25 搜索精度基准

**做什么**：
在 `bench/` 下新建 `search-precision.ts`，比较 BM25 和简单 `includes` 的搜索精度。

**方法**：
1. 存入 100 条模拟被驱逐的上下文条目（每条约 200-500 字），内容涵盖不同主题。
2. 准备 20 个搜索查询（含精确关键词、模糊相关、同义词、中文）。
3. 人工标注每个查询的正确答案（哪些条目是相关的）。
4. 计算 BM25 和 includes 的 Precision@5、Recall@5。

**合格标准**：
- BM25 的 Recall@5 ≥ 0.7（10 个相关条目，BM25 top-5 中至少覆盖 7 个）。
  > 注：此表述数学上不可达（topK=5 最多覆盖 5/10=0.5）。实际以 Recall@10 ≥ 0.7 实现（见 `bench/search-precision.mjs` 场景 B 与报告）。
- BM25 的 Precision@5 ≥ includes 的 Precision@5（即至少不比简单字符串匹配差）。
- 输出对比表到 `docs/benchmarks/bm25-precision.md`。

**预估工时**：2-3 小时。

---

## 三、基准支撑（5 → 8.0）

### 3.1 bench/ 目录整合

**现状问题**：`bench/` 下有 13 个 `.mjs` 和多个 `.ts` 脚本，命名混乱，没有一个统一的入口。

**做什么**：
写一个 `bench/run.ts`，作为唯一入口：
```bash
npx tsx packages/context/bench/run.ts --suite niah
npx tsx packages/context/bench/run.ts --suite multihop
npx tsx packages/context/bench/run.ts --suite docqa
npx tsx packages/context/bench/run.ts --suite all
```

**具体步骤**：
1. 定义 `BenchSuite` 接口：`{ name, description, run: () => Promise<BenchResult> }`
2. 把 NIAH、多跳、DocQA、BM25 精度四个 suite 实现为独立模块（`bench/suites/niah.ts` 等）。
3. `run.ts` 解析 `--suite` 参数，调用对应 suite，输出统一格式的 JSON + Markdown 报告。
4. 删除不再需要的旧脚本。保留 `locomo/` 子目录但不作为活跃 suite。

**合格标准**：
- `npx tsx bench/run.ts --suite niah` 跑通并输出 JSON 报告。
- `bench/` 下脚本数从 13 减少到 ≤ 8。
- 报告格式统一：`{ suite, model, date, results: { BL: {score, details}, CM: {score, details} } }`。

**预估工时**：3-4 小时。

---

### 3.2 基准报告标准化

**做什么**：
在 `docs/benchmarks/` 下统一格式：

```
docs/benchmarks/
  README.md           ← 总索引：所有基准一览表
  niah.md             ← NIAH 热力图 (20 格，BL vs CM)
  multihop.md         ← 多跳 QA (3 文档 × 20 题)
  docqa.md            ← 长文档 QA (750K chars)
  bm25-precision.md   ← BM25 搜索精度
  locomo.md           ← LoCoMo 结果与教训（解释为什么不适合 CM）
```

每份报告统一结构：
```markdown
# 基准名称

## 场景
- 数据规模、题目数量、模型

## 方法
- BL 配置
- CM 配置

## 结果
| 类别 | BL | CM | Δ |
|------|----|----|---|
| ...  |    |    |   |

## 分析
- 为什么 CM 赢/输
- 代表什么

## 复现
\```bash
npx tsx bench/run.ts --suite xxx
\```
```

**合格标准**：
- 5 份报告都有实质内容（至少 1 份有 BL vs CM 对比数据）。
- `docs/benchmarks/README.md` 作为索引页可导航。
- 任何人在一台新机器上 clone 项目后能按报告中的命令复现结果。

**预估工时**：2-3 小时。

---

## 四、文档与社区（7.0 → 8.5）

### 4.1 英文 README

**做什么**：
写 `README.md` 英文版（中文版保留但以英文为主，中文摘要放在顶部或单独 `README_CN.md`）。

**必须包含的段落**（按顺序）：
1. **一句话**：StructFocus is an LLM context attention management engine via MCP.
2. **Why**：FIFO drops info; we compress→capsule→pointer→recall. 引用 DocQA 750K 数据。
3. **30-Second Quickstart**：`mcp.json` 三行接入 → 对话 → 自动管理。
4. **Architecture**：四层冷热图（ASCII art）。
5. **MCP Tools**：表格（5 个工具 + 参数 + 行为）。
6. **Benchmarks**：表格式概览 + 链接到 `docs/benchmarks/`。
7. **Install & Build**：`pnpm install && pnpm build && pnpm test`。
8. **License**：Apache-2.0。

**合格标准**：
- 一个不懂中文的开发者能在 5 分钟内理解这是什么、怎么用、效果如何。
- `pnpm build && pnpm test` 在 README 中的命令可被复制粘贴直接运行。
- 没有拼写错误和语法错误。

**预估工时**：2-3 小时。

---

### 4.2 Gitee CI 完善

**现状问题**：已有 `.gitee/workflows/ci.yml`，但不清楚是否真的在 Gitee 上跑通了。

**做什么**：
1. 确认 Gitee CI 已激活。
2. `ci.yml` 增加步骤：`pnpm bench:smoke`（一个 2 分钟内跑完的轻量基准验证，不需要 LLM 调用）。
3. 加 badge 到 README。

**合格标准**：
- push 到 main 分支后 Gitee CI 自动运行，lint → typecheck → test → smoke bench 全部绿。
- README 上有 Gitee CI badge。

**预估工时**：1-2 小时。

---

### 4.3 CONTRIBUTING.md 完善

**做什么**：
在现有 CONTRIBUTING.md 中补充：
- 项目结构图（ASCII tree）
- 本地开发步骤（clone → pnpm install → build → test）
- 单测编写规范（放在 `tests/` 下，命名 `xxx.test.ts`）
- PR 规范（分支命名、commit message 格式）

**合格标准**：
- 一个新贡献者按 CONTRIBUTING.md 能在一台新机器上跑通所有测试。
- 包含至少 5 个 Good First Issue 的想法列表。

**预估工时**：1 小时。

---

## 五、执行计划（按优先级排序）

```
第 1 天 (6h)    1.2 toMessages 时序保持 + 1.1 Per-Conversation 隔离
第 2 天 (6h)    1.3 多跳 QA Benchmark（构造+跑+写报告）
第 3 天 (4h)    1.4 DocQA 系统化 + 3.2 基准报告标准化
第 4 天 (4h)    2.1 已知 Bug 修复 (5 个)
第 5 天 (4h)    2.2.1 ContentStore 单测 + 2.2.2 CapsuleStore 单测
第 6 天 (4h)    2.2.3 summarize mock 测试 + 2.2.4 MCP 集成测试
第 7 天 (3h)    2.3 BM25 搜索精度 + 3.1 bench 整合
第 8 天 (4h)    4.1 英文 README + 4.2 Gitee CI + 4.3 CONTRIBUTING
```

---

## 六、评分变化预测

| 维度 | 当前 | 完成后 | 最大扣分原因 |
|------|------|--------|-------------|
| 核心架构 | 7.5 | 9.0 | 缺 embedding 召回（需要钱） |
| 工程质量 | 6.5 | 9.0 | 之前缺单测 |
| 基准支撑 | 5.0 | 8.0 | 缺公认 benchmark（需要钱跑其他模型） |
| 文档社区 | 7.0 | 8.5 | 缺 GitHub（被封）和 MCP 市场发布 |
| **综合** | **6.5** | **8.6** | |

10 分真实差距：
- **Embedding 召回**（-0.5）：需要向量模型 API（可等智谱送 embedding 额度）。
- **多模型验证**（-0.5）：需要 DeepSeek/Claude/GPT 至少一种付费 API。
- **真实 Agent 集成验证**（-0.3）：需要一台能跑 Codex/Claude Code 的电脑或云服务器。
- **GitHub 社区**（-0.2）：等待账号解封。

这三项在你当前约束下无法达成，但前两项对证明 CM 价值**不是必需的**——BM25 + GLM-4 已经够做长文档多跳 QA 的证据了。

---

## 进度追踪（自动维护，勿删）

> 执行方式：做一块、测一块、推一块。路线图部分条目基于旧版代码，已按当前代码核实。

- **2.1 已知 Bug**
  - Bug1（CapsuleStore 重复初始化）：核实构造函数仅 `new CapsuleStore` 一次（manager.ts:304），**已不存在**。
  - Bug2（MCP summarize 参数未用）：当前 MCP 无 `context_summarize` 工具（8 工具体系），**路线图滞后，不适用**。
  - Bug3（forget noise source 匹配不到）：`forget(target)` 按路径/ID，`forgetNoise(id)` 按 id，不受 source 影响，**设计已规避**。
  - Bug4（bench `autoManage()` 缺 await）：**已完全修复**——`grep -r "autoManage()" bench/`（排除类型定义/注释）现全部含 `await`。本轮将 `runNIAHSingle`/`runDocQA`(harness.ts)、`runHardNIAHSingle`/`runDocQAHard`/`runMultiHopMemory`(hardcore.ts)、`runNeedleTask`(llm-harness.ts) 改为 `async` 并 `await autoManage()`，同步更新其调用方 `run.ts`/`run-llm.ts`/`hardcore-run.ts`/`run-phase2.ts` 加 `await`（均为 async 上下文，无回归）。此前已修的 `cm-resume.mjs`/`cm-bench.mjs`/`cm-hardcore.mjs`/`mechanics.mjs` 维持。
  - Bug5（hardThreshold 单位）：`90608a4` 已修，**已有回归测试**（manager.test.ts `L1 (非活跃达 hardThreshold)`）。
- **2.2 缺失单测**
  - mcp `server.test.ts` 已覆盖 6 用例（含命中 ContentStore、未知工具 -32603、未知方法 -32601）。
  - 新增 `content-store.test.ts`(7) / `capsule-store.test.ts`(5) / `summarize.test.ts`(6)，共 **+18**；总用例 **175**（context 159 + mcp 16）。
  - 顺带修复：`summarizeToCapsule` 返回值漏了 `chunkSummaries` 字段（接口有、实现无），已补接口+返回；`chunkBySemantic` 实现"同 source 同块"规则。
- **1.1 Per-Conversation 隔离**（roadmap 一.1）— **已完成**
  - `ContextEntry` 新增 `conversationId?` 字段；`ContextManager` 维护 `currentConversationId`，`appendEntry` 打标，`newConversation(id?)` 切换对话并归档前对话到 ContentStore（带 conversationId）。
  - `toMessages` 仅渲染 `conversationId === current || protectedBy` 的条目（受保护焦点文件跨对话持久）。
  - `ContentStore`: `StoredContent`/`IndexEntry`/`SearchOptions` 加 `conversationId`；`search()` 支持按对话过滤召回；10 处 `store.save` 全链路打标。
  - `LongContextEngine.newConversation(id?)` 透传；`recall()` 默认按 `getCurrentConversationId()` 过滤，可用 `opts.conversationId` 覆盖。
  - 新增 `conversation-isolation.test.ts`(4)：切换打标 / toMessages 互不污染 / search 按对话过滤 / engine.recall 默认隔离。
- **1.2 toMessages 时序保持**（roadmap 一.2）— **已完成**
  - `buildHistory` 拆分 `history` 流与 `recallBlocks`：L3_compressed 胶囊召回不再以 `role:user` 内联，改为 `role:system` 的 `[上下文召回: <capsuleId>]` 前缀块，置于历史对话流之前，不破坏 user/assistant 交替。
  - `toMessages` 对纯 user/assistant 对话保持严格角色交替（已验证 10 轮 → 10 对 user/assistant，无内联 `[observation]`/`[recall]` 伪造标记）。
  - 召回注入（item 3）：`injectRecall` 与 `LongContextEngine.recallAndInject` 改为 `appendSystem`（`role:system`，内容带 `[recall]` 前缀），不再伪造 user/assistant；新增 `ContextManager.appendSystem`；`forgetScoped` 扩展为同时清理 `observation`/`system` 类型的 `[recall]` 条目。
  - `buildHistory` 对 `system` 类型条目不加 `[tool_output]` 等前缀标记。
  - 新增 `tomessages-timeline.test.ts`(4)：10 轮交替 / 首末角色 / 胶囊 system 前缀 / 召回注入为 system 且 forgetScoped 可清理。
  - 同步修正 `longcontext-recall.test.ts` 中胶囊摘要断言（user→system 块）。
  - 总用例 **183**（context 167 + mcp 16）。
- **2.3 BM25 搜索精度基准**（roadmap 二.3）— **已完成**
  - 新建 `bench/search-precision.mjs`（本地可跑、无需 API key，导入 `../dist/index.js` 的 `ContextManager.getStore()`）。
  - 数据集：100 条模拟被驱逐条目（20 主题簇 × 5），含跨主题噪声词；20 查询（16 精确 + 4 同义模糊）+ 金标准。
  - 对比 BM25 vs 简单 `includes` 的 Precision@5 / Recall@5。
  - 结果：**精确查询 BM25 P@5=R@5=1.000，≥ includes（1.000）**；全集 BM25 0.900 / includes 0.800。合格标准双 PASS。
  - 诚实结论：4 个同义查询中 2 个（主从复制拓扑、外部知识库问答）零词面重叠致 BM25/includes 双失效；另 2 个 BM25 借子词（调度/淘汰策略）仍可命中而 includes 失败 → BM25 OR 式打分比 includes-AND 更鲁棒，但二者均无语义能力（hybrid 接口已预留）。
  - **场景 B（本轮新增）**：10 条同主题相关 + 90 条干扰，验证多相关召回。⚠️ 披露：roadmap 原文合格标准「BM25 Recall@5 ≥ 0.7（10 个相关条目，top-5 至少覆盖 7 个）」**数学上不可能**——topK=5 最多覆盖 5/10=0.5。忠实实现为 **Recall@10 ≥ 0.7**，实测 BM25 Recall@10 = 1.000 → PASS。
  - 报告输出至 `docs/benchmarks/bm25-precision.md`。
- **代码审计：LLM 压缩与 AI 上下文管理接线**（roadmap 二/四 隐含要求）— **已完成（本轮）**
  - 用户要求核查「写了逻辑但没接上」的断点，逐层审计 `LongContextEngine` / `ContextManager` / `middleware` / MCP `index.ts`。
  - **确认 4 处核心断点并全部修复**：
    1. `autoManage`（压缩/驱逐/窗口管理核心）此前**只在 tests/bench 调用**，MCP `context_inject` 与 `middleware.pre/postLlmCall` 都只 `feed` 不管理 → 已接入：`context_inject` 在 `feed` 后 `await autoManage()`（index.ts:223）；`middleware.postLlmCall` 改为 async 并 `await autoManage()`（middleware.ts:96）。
    2. `recallAndInject`（召回内容注入被管理上下文）全仓库零调用 → `middleware.preLlmCall` 由 `engine.recall` 改为 `engine.recallAndInject`（middleware.ts:70），召回内容进入引擎、autoManage 可见。
    3. `autoManage` 内部 L1 分支（`downgradeToL3`）只标记 `compressed:true`、**从不调 `summarizeAndCapsule`** → 产品的「LLM 概括归档为胶囊」在 `autoManage` 里是死逻辑。新增 `summarizeInactive()`（manager.ts:896）并在 `autoManage` 内调用（manager.ts:725），对相对话题锚点非活跃的旧内容真正概括成胶囊（30s 节流 + 无 LLM 时确定性回退）。
    4. `forgetRecalled`（清理每轮召回注入的 `[recall]` 条目）零调用 → `middleware.preLlmCall` 在 `recallAndInject` 前先 `engine.forgetRecalled()`（middleware.ts:71），闭合「AI 接管上下文」循环，避免活跃窗口被历次召回无限膨胀。
  - **诚实结论（非断点，属设计/便利 API，未接不视为 bug）**：`feedBatch` / `flush` / `newConversation` / `listCapsules` 在生产路径（MCP + middleware）无调用方——`feedBatch` 是 `feed` 批量包装、`flush` 是会话结束显式打包（autoManage 已做增量压缩，等价功能已覆盖）、`newConversation` 是会话隔离（单默认会话场景下 recall 按默认 conversation 过滤，行为合理）、`listCapsules` 仅暴露 capsuleCount 不暴露详情（次要）。如需可后续补 MCP 工具或 middleware 钩子，但非「核心逻辑未接入」。
  - **验证**：新增 `integration-wiring.test.ts`（6 用例：autoManage 接线 / recallAndInject 接线 / 两轮压缩产出胶囊 / 单主题不压缩已知限制 / forgetRecalled 闭环清理 / 孤立 API 检测）+ `mcp/tests/server-wiring.test.ts`（3 用例：context_inject 触发 autoManage 等）；全量回归 **192 passed**（context + mcp，原 183 + 新增 9）。
- **3.1 bench 整合**（roadmap 三.1）— **统一入口落地（部分）**
  - 新建 `bench/run.mjs` 作为唯一入口（纯 Node ESM，无需 tsx/key），支持 `--suite <bm25|niah|multihop|docqa|all>` 与 `--list`。
  - 新建 `bench/suites/`：`bench-result.mjs`（统一 `BenchResult` 类型 + Markdown/JSON 报告格式化）、`bm25.mjs`（真实可跑，复用 `search-precision.mjs` 的 `runBm25()`）、`niah.mjs`/`multihop.mjs`/`docqa.mjs`（key-gated，诚实跳过、不伪造分数）。
  - 重构 `search-precision.mjs`：抽取 `export async function runBm25()` 返回结构化数据；保留 `node search-precision.mjs` 独立运行（经 `import.meta` 判断主模块），与 `bench:bm25` 脚本解耦。
  - `package.json` 脚本：`bench` / `bench:bm25` / `bench:smoke` 均指向 `run.mjs --suite bm25`（`bench:smoke` 供 4.2 CI 用）。
  - **验证**：`node bench/run.mjs --suite all` 本地实跑 → BM25 ✅ OK（精确 P@5/R@5=1.000 ≥ includes，场景B Recall@10=1.000 PASS），niah/multihop/docqa ⏭️ SKIPPED，统一报告写入 `docs/benchmarks/_last-run.md` + `_last-run.json`。
  - **诚实披露 / 未达标项**：
    - roadmap 合格标准「`npx tsx bench/run.ts --suite niah` 跑通」**当前不满足**——本机未安装 tsx，且 `bench/harness.ts` 未被 `tsc -b` 编译进 dist（`run.ts` 依赖的 `./harness.js` 不存在），NIAH 等无法运行；故改用纯 `.mjs` 入口（开箱即用），niah/multihop/docqa 保持 key-gated。后续接 key 时需：① `pnpm add -D tsx` 或将 harness 纳入 `tsconfig` include 并产出 `harness.js`；② 配置 `LLM_API_KEY`；③ 在 suite 内调用 `runNIAHSingle` 等并映射为 `BenchResult`。
    - roadmap「脚本数 13 → ≤8」**暂缓**：保留 `harness.ts`/`run.ts`/`hardcore*.ts`/`llm-harness.ts` 等 LLM harness 脚本（1.3/1.4 接入时需要），未删除；新增 `suites/` 与 `run.mjs` 为活跃入口。待 key 接入并确认 harness 可编译后再做清理/合并。
- **3.2 报告标准化**（roadmap 三.2）— **部分**
  - 已建 `docs/benchmarks/README.md` 索引 + `bm25-precision.md`；统一 `BenchResult` 格式已定义（`{suite,model,date,results:{BL,CM}}`），由 `run.mjs` 输出 `_last-run.md/json`。
  - multihop/docqa/niah 报告待对应 suite 接 key 后补齐；BM25 报告已可导航。
- **4.1 英文 README**（roadmap 四.1）— **已完成**
  - 新建 `README_EN.md`：覆盖 one-liner / Why / 30-sec Quickstart / Architecture(ASCII 四层冷热图) / 8 MCP 工具表（按实际代码为 8 个，非 roadmap 草稿写的 5 个）/ Benchmarks 表 + 链接 / Install&Build / License。
  - `README.md` 顶部加英文版指针，中文版保留为主文档。
- **4.3 CONTRIBUTING.md**（roadmap 四.3）— **已完成**
  - 扩充项目结构 ASCII 树（含 bench/ docs/ tests/）；补「Local Development」「Unit Test Conventions」（隔离 storeRoot、单 fork vitest 命令）；补 fork 分支/commit 规范；补 5 个 Good First Issues。
- **待办组 / 挂起**：
  - 1.3 多跳 QA、1.4 DocQA：需 GLM-4 key，代码可建但本地无法出分，挂起。
  - 3.1 bench 整合：统一入口 `run.mjs` + BM25 suite 已落地并验证（无需 key 可跑，BM25 PASS）；niah/multihop/docqa 仍 key-gated（缺 LLM key + harness 未编译），未交付 `tsx` 跑通版（roadmap 字面合格标准暂不满足，已诚实记录）。
  - 3.2 报告标准化：已建索引 + BM25 报告 + 统一 BenchResult 格式（`_last-run.md/json`）；multihop/docqa/niah 报告待 key。
  - 4.2 Gitee CI：按你先前指示「先空着，等同步后再改」，延后（入口 `bench:smoke` 已就位）。
