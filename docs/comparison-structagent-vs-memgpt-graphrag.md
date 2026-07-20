# StructFocus vs MemGPT / Letta vs GraphRAG — 详细对比（重点：测试与评测）

> 目的：把 StructFocus 放到"长期记忆 / 长上下文"这条赛道里，和它最常被人拿来比的三个系统做一个**有出处、有数字**的对比。
> 核心结论先说：**这三者其实不在同一个层上竞争**——StructFocus 与 MemGPT/Letta 争的是"agent 运行时记忆"，GraphRAG 争的是"语料级知识问答"。但在 StructFocus 最在意的"长对话会不会忘"这一轴上，三套**测试方法**的差别，比它们的结果更值得讲清楚。

---

## 0. 一句话定位

| 系统 | 一句话 | 它解决的是哪一层 |
|------|--------|------------------|
| **StructFocus** (`@structfocus/context`) | 长上下文的"透明代理"：**概括→胶囊→指针→语义召回**，不压缩、不丢、可溯源 | Agent / 对话**运行时**记忆，防 FIFO 截断遗忘 |
| **MemGPT / Letta** | 把 LLM 当操作系统：主上下文 + 外存，靠 LLM **自主函数调用**分页调度 | 通用 agent **长期 / 跨会话**记忆 |
| **GraphRAG** (Microsoft) | 把语料建成知识图谱 + 层级社区摘要，专门答"全局性"问题 | **大规模语料**知识问答（语料级，非对话级） |

> 一句话区分：StructFocus = 给对话装一个"不会忘的秘书"；MemGPT = 给 agent 装一套"虚拟内存操作系统"；GraphRAG = 给一堆文档建一棵"能全局总结的知识树"。

---

## 1. 核心机制对比

### StructFocus — 概括 → 胶囊 → 指针 → 语义召回
- **摄入（feed）**：每条消息进 ContentStore，做智能分词（CJK 弱）。
- **压缩（flush）**：达到阈值后用 LLM（缺失时走**确定性回退** `deterministicSummary`）把若干轮对话压缩成一个**胶囊（capsule）**，胶囊里保留：摘要 + 任务ID + 涉及文件 + **chunkSummaries（块级摘要）**。
- **指针**：胶囊本身进入上下文，原文留在存储；需要时通过**语义召回（recall）**把原文片段拉回。
- **关键特性**：胶囊可**磁盘持久化**（跨进程/跨会话加载）；召回是"整体匹配摘要+块摘要全文"，不是只匹配元数据——这是我们对 CJK 查询召回做的修复点。
- **定位**：**不是压缩，是"带指针的摘要"**。原文永远可回溯。

### MemGPT / Letta — OS 虚拟内存隐喻
- **主上下文（RAM）**：系统指令 + 工作上下文（可读写的核心事实）+ **FIFO 队列**（滚动消息历史）。
- **外存（磁盘）**：Recall Storage（可搜的历史消息库，pgvector/HNSW）+ Archival Storage（任意文本仓库）。
- **调度**：上下文快满时触发"内存压力"事件，LLM 通过**函数调用自主决定**把什么换出、生成什么摘要、用什么键找回。
- **递归摘要**：换出时递归总结，是有损的。
- **争议点**：把记忆管理决策权完全交给 LLM，"分页策略"没有正式优化，淘汰误判会丢关键状态。

### GraphRAG — 知识图谱 + 层级社区摘要
- **索引（建图，昂贵）**：分块 → LLM 提取**实体/关系** → Leiden 社区检测 → 每个社区 LLM 生成**社区摘要**（自底向上）。
- **查询**：
  - **Local Search**：定位实体 → 图遍历邻居 → 取源块 + 社区摘要回答（类增强版向量 RAG）。
  - **Global Search**：把查询广播到所有社区摘要（Map-Reduce），答"整个语料的主题是什么"——这是向量 RAG 做不到的。
- **关键特性**：结构化、可多跳推理、可溯源到社区→源块；但**建图成本极高**，且实体提取是概率过程，会带入误差。

---

## 2. 测试 / 评测方法详细对比（本文重点）

测试哲学的差别，比结果数字更关键：

- **StructFocus** = 工程可量化：**"截断遗忘曲线"**——关键词是否进了上下文 + token 预算占用（最硬、最可复现、最快）。
- **MemGPT / Letta** = 行为级：**"记忆是否真能用"**——跨会话事实召回准确率、长期对话榜总分（贴近用户体验，但依赖 LLM judge / 人工，对底座模型敏感）。
- **GraphRAG** = 质量级：**"全局综合是否全面"**——LLM-as-judge 头对头胜率（主观，但有结构化 claim 指标补充）。

### 2.1 StructFocus 的测试（我们刚搭的 A/B/C 三线对照）

设计来源：`docs/benchmark-guide.md`，已在 `packages/context/benchmark/` 落地并跑通。

| 项 | 内容 |
|----|------|
| **三线设计** | **A = 裸跑（上界）**：全量上下文；**B = FIFO 30K 截断（基线）**：只保留尾部，前端遗忘；**C = StructFocus（被测）**：概括→胶囊→指针→语义召回 |
| **数据集** | 12 个预写话题 × 多轮；**目标话题固定在对话最前端**（遗忘曲线：FIFO 保留尾部，越往后越忘最前面的） |
| **评测指标** | ① 召回率 = 关键词是否进入最终注入上下文的比例；② `token/prompt` 占用；③ 压缩比 = 1 − C_tokens / A_tokens |
| **两种模式** | **确定性 mock**（无 API Key，LLM 回显 prompt，评分 100% 可复现，用于管线自检）+ **真实 LLM**（需 `GLM_API_KEY`，待跑） |
| **已验证结果（mock，36 trials）** | A **100%** / B **83.3%** / C **100%**（C 追平上界 A，+16.7pp 超过 B）；遗忘曲线梯度：20→160 轮 C−B = +0/+0/+0/**+67pp**；C 压缩 **98%**，相对 A 省 **76%** token |
| **诚实局限** | ① 中文 BM25 分词弱（已缓解，真实 LLM 建议接中文分词器）；② mock 仅自检，正式结论需真实 LLM；③ 目前只覆盖了"近/远端话题"，未覆盖"知识更新 / 时间推理" |

> 这是三者里**最硬、最快、最可复现**的测试——它不依赖 LLM 当裁判，直接测量"信息有没有丢"和"花了多少 token"。

### 2.2 MemGPT / Letta 的测试

来源：Packer et al. 2023《MemGPT: Towards LLMs as Operating Systems》(arXiv 2310.08560)；Letta 2024-09 并入；LoCoMo 长期对话记忆榜（2025）。

原论文四个评测：

| 评测 | 测什么 | 结果（MemGPT vs 基线） | 与 StructFocus 的类比 |
|------|--------|------------------------|------------------------|
| **Deep Memory Retrieval (DMR)** | 跨 5 个先前会话的事实问答，基线只给有损摘要 | MemGPT+GPT-4 **93.4% acc** / ROUGE-L 0.827，vs GPT-4 基线 **32.1%** / 0.296（**+60pp**）；GPT-4 Turbo 版 93.4% | **最接近 StructFocus 的"遗忘曲线"**——压缩摘要丢细节，分页检索找回 |
| **Conversation Opener** | 开场白 persona 一致性 | CSIM-1 MemGPT **0.868** vs 人类 **0.800** | 个性化/参与度，StructFocus 未测 |
| **Document QA**（NaturalQuestions-Open） | 随文档数增加，截断基线退化 | MemGPT 稳定（分页=无限上下文），基线随文档增多准确率掉 | 类似"长文档不被窗口限制" |
| **Nested Key-Value Retrieval** | 多跳（0–4 层嵌套）查找 | 基线 GPT-4 在 3 层 **0%**，MemGPT 维持 **~100%** | 多跳推理，StructFocus 未直接测 |

**论文自陈局限**：① 无正式淘汰策略（eviction policy），LLM 误判重要性会丢关键数据；② 强依赖函数调用质量（GPT-3.5 远差于 GPT-4）；③ 延迟高（每轮 5–10 次推理）；④ 递归摘要有损。

**2025 年的基准争议（很重要）**：
- **LoCoMo 长期对话记忆榜**（2025）：Letta Filesystem **74.0%**，同台有 Mem0 66.9%、MemOS/Memobase ~75.8%、Zep(Graphiti) 75.1%、全文上下文 72.9%、RAG 基线 61.0%、OpenAI Memory 52.9%。
- Letta 团队 2025-08 公开**自曝**：仅把 LoCoMo 对话历史放进一个文件 + grep/语义搜索，就用 GPT-4o mini 拿到 **74.0%**，高于 Mem0 图模式 68.5%。他们据此**质疑"记忆基准测试是否真有意义"**——认为记忆更多取决于**上下文怎么管理**，而非用了什么检索机制。
- Letta 作者还公开**指控 Mem0 的 LoCoMo 测试"为营销造假、做无意义测试"**（未回填历史数据、无法复现）。

> 启示：MemGPT/Letta 的"行为级"测试**最受底座模型和评测设计影响**，且连作者自己都在质疑基准的有效性。这恰恰是 StructFocus 走"工程硬指标"路线的价值所在。

### 2.3 GraphRAG 的测试

来源：Microsoft《From Local to Global》(arXiv 2404.16130)；BenchmarkQED（Microsoft Research, 2025）；WildGraphBench（arXiv 2602.02053, 2026）。

**原论文评测设计**：

| 项 | 内容 |
|----|------|
| **数据集** | Podcast transcripts（~100 万 token，1669 块）+ News（~170 万 token，3197 块） |
| **对比条件** | GraphRAG（C0–C3 不同社区层级）/ TS（对源文本直接 Map-Reduce）/ SS（向量 RAG 基线） |
| **评估方法** | **LLM-as-judge** 头对头比较；生成 **125 个全局问题**；每个问题 × 每个指标**重复 5 次**，算平均胜率 |
| **指标** | 全面性（Comprehensiveness）/ 多样性（Diversity）/ 赋能性（Empowerment）/ 直接性（Directness，控制项） |
| **claim 分析（补强）** | 从答案抽事实 claim：GraphRAG/TS 的 claim 数显著高于 SS（News C0 34.18 vs SS 25.23；Podcast ~32 vs 26.50） |

**关键结果**：
- 全面性胜率：Podcast **72–83%**，News **72–80%**（相对向量 RAG SS）；多样性：Podcast 75–82%，News 62–71%。
- 向量 RAG 在"直接性"上更强（回答更短更直接）——全局综合本来就不是它的活。
- **成本（最被低估的部分）**：
  - 索引是昂贵步骤：1M token 语料需数百万 LLM 调用；社区基准 **full GraphRAG ~$10–20** 索引，LightRAG ~$3–5，LazyGraphRAG ~$0.10（延迟到查询时），向量 RAG ~$0.10。
  - 实测：32k 词书索引 ~$6–7（GPT-4o）；某真实企业语料一次索引 ~$33,000。
  - 每个 **Global 查询可烧数万 token**。
- **BenchmarkQED（2025）**：AutoQ（4 类查询合成）+ AutoE（LLM-judge 胜率）+ AutoD（数据集采样对齐）。LazyGraphRAG 在 96 个对比中**全胜**原始 GraphRAG，且对 **1M-token 窗口的向量 RAG 仍更高胜率**。
- **WildGraphBench（2026）**：Wikipedia 真实语料，1197 题（单事实/多事实/段落摘要），45.5M token。发现：**GraphRAG 在单事实查找上不一定优于 NaiveRAG/BM25（且更贵）**；多事实跨文档聚合最优（Microsoft GraphRAG global **47.64%**）；段落摘要类所有方法都低分。

> 启示：GraphRAG 的测试**最"软"**（LLM 当裁判，主观胜率），但**最贵**（建图 100× 于向量 RAG），且明确不擅长"长对话记忆/遗忘"——它解决的是另一个问题。

### 2.4 LongMemEval（ICLR 2025）— StructFocus 该去对标的主流硬仗

来源：UCLA + 腾讯 AI Lab；500 题，嵌入可扩展多会话对话历史。

| 维度 | 内容 |
|------|------|
| **五大能力** | 信息提取(IE) / 多会话推理(MR) / **知识更新(KU)** / **时间推理(TR)** / **弃权(ABS)** |
| **规模** | S：~115K token（~48 会话）；M：~1.5M token（~500 会话，超出现有上下文窗口） |
| **评测方法** | GPT-4o as judge（>97% 与人类一致）；检索指标 Recall@k / NDCG@k |
| **关键发现** | 长上下文 LLM 从 Oracle 到 S **掉 30–60%**；多会话推理最难（~83%）；**知识更新最易被旧事实骗**（相似度分不出新旧）；**即使完美召回，阅读理解仍有错** |

> 这是 StructFocus 目前**没覆盖、但最该补**的基准：它的 KU（用户改了公司，该答新的）、TR（时间推理）、ABS（不知道就该说不知道）三类，正是 StructFocus 当前 A/B/C 测试里缺的能力维度。

---

## 3. 测试维度逐项对比表

| 测试维度 | StructFocus | MemGPT / Letta | GraphRAG |
|----------|-------------|----------------|----------|
| **测试目标** | 长对话截断后信息是否丢 + token 预算 | 跨会话记忆是否真能用 | 全局综合是否全面 |
| **典型数据集** | 自造 12 话题 × 多轮（遗忘曲线） | MSC-DMR、LoCoMo、NaturalQuestions | Podcast/News、WildGraphBench |
| **评测指标** | 召回率（关键词进上下文%）/ token / 压缩比 | 准确率 / ROUGE-L / CSIM / 榜总分 | LLM-judge 胜率 / claim 数 |
| **是否定量、可复现** | ✅ 最强（确定性 mock，不依赖 judge） | ⚠️ 依赖 LLM judge / 底座模型敏感 | ⚠️ 主观胜率，但有 claim 补强 |
| **是否测"遗忘/截断"** | ✅ 核心（C−B 遗忘曲线梯度） | ✅（DMR 测跨会话找回） | ❌ 不测（语料级） |
| **是否测"知识更新/时间"** | ❌ 当前未覆盖 | ⚠️ 靠 LLM 自管理，无专门测 | ❌ |
| **成本度量** | ✅ token/prompt 直接给 | ⚠️ 论文未报延迟/成本 | ✅ 明确定价（建图 100×） |
| **可溯源** | ✅ 指针→原文（最强） | ⚠️ 召回可溯源，但自编辑摘要可能漂移 | ✅ 社区→源块（但提取有误差） |
| **社区认可度** | 自造基准，待主流背书 | 高（LoCoMo 榜、论文） | 高（论文 + BenchmarkQED） |

---

## 4. 关键差异与对 StructFocus 的启示

1. **工具而非对手**：StructFocus 与 MemGPT/Letta 在"agent 运行时记忆"层正面交锋；GraphRAG 在"语料知识问答"层，基本不重叠。**对比时应明确"比哪一层"**，否则数字没意义。

2. **测试哲学差异决定可信度**：
   - StructFocus 的"截断遗忘曲线"是三者里**最硬**的——它直接测"信息有没有丢"和"花了多少 token"，不请 LLM 当裁判，所以**最快、最便宜、最可复现**。
   - 但**样本自有、未被社区广泛认可**。MemGPT 的 DMR 93.4% 之所以有说服力，是因为它是公开数据集 + 公开基线。

3. **可溯源是 StructFocus 的差异化卖点**：指针→原文这条链路，比 MemGPT 的"自编辑摘要"和 GraphRAG 的"概率提取图谱"都更可信。README 应把这个讲透。

4. **成本模型 StructFocus 占优**：仅在摄入时摘要一次 + 语义召回（成本接近向量 RAG）；GraphRAG 建图贵 100×；MemGPT 每轮多次 LLM 调用（延迟高）。这点和 StructFocus "透明代理、token 预算可控"的定位一致。

---

## 5. 给 StructFocus 测试体系的增强建议（可执行）

按优先级：

1. **补齐真实 LLM 跑 `--full`**：mock 已验证管线，正式结论需 `export GLM_API_KEY=... && npx tsx packages/context/benchmark/index.ts --full`。README 已诚实标注"待跑"。
2. **对标 LongMemEval（ICLR 2025）**：这是主流长期记忆硬仗。重点补它的 **KU（知识更新）** 和 **TR（时间推理）**——当前 StructFocus 测试完全没覆盖这两类，而它们恰恰是真实 agent 最易翻车的地方。
3. **对标 MSC-DMR**：把 StructFocus 接到 MemGPT 的 Deep Memory Retrieval 数据集，直接对比 93.4% 那条线，最有对外说服力。
4. **加 `--sweep` 近端/中断/远端话题分布**：已支持，用于证明"无论目标话题在对话哪个位置，C 都不退化"。
5. **接中文分词器**：ContentStore BM25 对 CJK 弱，真实中文语料下召回会掉。
6. **跨会话持久化召回率做成 CI 前自测**：我们已经验证"flush→新实例加载同目录→recall 不变"，应固化成 `npm test` 一部分。
7. **报告诚实标注三件事**：① 确定性 vs 真实 LLM；② 召回率的定义（关键词进上下文比例）；③ 压缩比的定义（1 − C/A token）。

---

## 6. 一句话结论

> **StructFocus 的测试是三者里最"工程硬"的（量化遗忘曲线 + token 预算，可复现、零 judge 依赖），但样本与社区认可度不如 LoCoMo / LongMemEval；GraphRAG 的测试最"质量软"（LLM-judge 胜率）且成本最高；MemGPT/Letta 的测试介于两者之间，且因基准争议已自我质疑。** StructFocus 的下一步不是"再跑自己的 A/B/C"，而是**把遗忘曲线的方法论搬到 LongMemEval / MSC-DMR 上**，用社区认账的基准证明同一件事。

---

## 参考出处

- MemGPT 原论文：Packer et al., *MemGPT: Towards LLMs as Operating Systems*, arXiv 2310.08560 (2023)
- Letta / MemGPT 合并与 LoCoMo 争议：Letta Blog (2024-09, 2025-08)；CSDN LoCoMo 榜（2025）
- GraphRAG 原论文：Microsoft, *From Local to Global: A Graph RAG Approach to Query-Focused Summarization*, arXiv 2404.16130 (2024)
- BenchmarkQED：Microsoft Research Blog (2025) — AutoQ / AutoE / AutoD，LazyGraphRAG
- WildGraphBench：Wang et al., arXiv 2602.02053 (2026)
- LongMemEval：Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, ICLR 2025（UCLA + 腾讯 AI Lab）
- StructFocus 自身：本仓库 `docs/benchmark-guide.md`、`packages/context/benchmark/`（A/B/C 三线对照，mock 已验证 A 100% / B 83.3% / C 100%）
