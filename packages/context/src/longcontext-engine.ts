// @structfocus/context — LongContext Engine：独立长上下文管理引擎 (2026-07-19)
//
// 「不是压缩，是概括→胶囊→指针→召回」
//
// 与 autoManage（窗口内管理）互补，专注于跨会话/跨任务的长上下文生命周期：
//   积累 → LLM 概括 → 打包胶囊 → 指针留存 → 语义召回
//
// 独立于任何 Agent 框架，只需注入 LLM 调用函数即可工作。
// 设计约束：
//   - 零框架依赖（不依赖 StructFocus / OpenClaw / CodeX）
//   - 磁盘持久化（ContentStore + CapsuleStore）
//   - LLM 摘要引擎通过注入接入（GLM-4 / DeepSeek / Claude 均可）
//   - 召回时按语义搜索，不按 ID 盲捞
//
// 使用示例：
//   const engine = new LongContextEngine({
//     llmCall: async (prompt) => callGLM4(prompt),
//     summarizeInterval: 50_000, // 每 50K tokens 触发一次概括
//   });
//   engine.feed("user: 这个 bug 怎么修？");
//   engine.feed("tool: Error: OOM at line 42 in cache.ts");
//   engine.feed("assistant: 问题是 Redis 连接池未设置上限");
//   await engine.flush(); // 手动触发概括
//   const result = await engine.recall("Redis OOM 问题"); // 语义召回

import { ContextManager } from "./manager.js";
import { ContentStore, type StoredContent } from "./content-store.js";
import { CapsuleStore, type Capsule } from "./capsule.js";
import type { SummarizeOutput } from "./summarize.js";
import type { ManagementPolicy } from "./types.js";


// ─── 配置 ───────────────────────────────────────────────

export interface LongContextEngineOptions {
  /** LLM 调用函数（可选；省略则概括走确定性回退） */
  llmCall?: (prompt: string) => Promise<string>;
  /** 每积累多少 tokens 自动触发概括（默认 50000） */
  summarizeInterval?: number;
  /** 概括时保留最近多少条活跃条目（默认 20） */
  keepRecent?: number;
  /** 存储根路径 */
  storeRoot?: string;
  /** 胶囊存储根路径 */
  capsuleRoot?: string;
  /** 最大上下文窗口（传给 ContextManager，默认取模型窗口） */
  maxWindow?: number;
  /** 概括的最小条目数（低于此数跳过概括，默认 10） */
  minEntriesForSummarize?: number;
  /** 自动概括是否启用（默认 true） */
  autoSummarize?: boolean;
  /** 胶囊数量上限（默认 50，0 表示不限制）。超限时按 createdAt 踢最旧胶囊 */
  capsuleMaxCount?: number;
  /** 磁盘存储上限（MB），0 表示不限制；默认 512，可用 STRUCT_STORE_MAX_MB 覆盖 */
  storeMaxMB?: number;
  /** 日志函数 */
  logger?: (msg: string) => void;
}

export interface RecallResult {
  capsules: Capsule[];
  entries: StoredContent[];
  summary: string;
  /** 建议注入的 L0 摘要文本 */
  injectText: string;
}

export interface EngineStats {
  totalFed: number;
  totalSummarized: number;
  capsuleCount: number;
  activeEntries: number;
  storedEntries: number;
  lastSummarizeAt: number | null;
  /** ContentStore 磁盘占用统计（LRU 上限相关） */
  storeStats: {
    usedBytes: number;
    maxBytes: number;
    entryCount: number;
    atCapacity: boolean;
  };
}

// ─── 引擎 ───────────────────────────────────────────────

export class LongContextEngine {
  private readonly cm: ContextManager;
  private readonly options: LongContextEngineOptions;
  private totalFed = 0;
  private totalSummarized = 0;
  private lastSummarizeAt: number | null = null;
  private llmCall: ((prompt: string) => Promise<string>) | null;

  constructor(opts: LongContextEngineOptions) {
    this.llmCall = opts.llmCall ?? null;
    this.options = {
      llmCall: opts.llmCall,
      summarizeInterval: opts.summarizeInterval ?? 50_000,
      keepRecent: opts.keepRecent ?? 20,
      storeRoot: opts.storeRoot ?? ".longcontext/content-store",
      capsuleRoot: opts.capsuleRoot ?? ".longcontext/capsules",
      maxWindow: opts.maxWindow ?? 200_000,
      minEntriesForSummarize: opts.minEntriesForSummarize ?? 10,
      autoSummarize: opts.autoSummarize ?? true,
      capsuleMaxCount: opts.capsuleMaxCount ??
        parseInt(process.env.STRUCT_CAPSULE_MAX_COUNT ?? "50", 10),
      storeMaxMB: opts.storeMaxMB,
      logger: opts.logger ?? (() => {}),
    };
    this.llmCall = opts.llmCall ?? null;

    this.cm = new ContextManager({
      maxWindow: this.options.maxWindow,
      storeRoot: this.options.storeRoot,
      storeMaxMB: this.options.storeMaxMB,
      capsuleRoot: this.options.capsuleRoot,
    });

    if (this.llmCall) {
      this.cm.setLlmCall(this.llmCall);
    }
  }

  // ─── 注入 LLM ─────────────────────────────────────────

  /** 设置/更换 LLM 调用函数（GLM-4 / DeepSeek / Claude 等） */
  setLlmCall(fn: (prompt: string) => Promise<string>): void {
    this.llmCall = fn;
    this.cm.setLlmCall(fn);
  }

  // ─── 喂入上下文 ───────────────────────────────────────

  /**
   * 喂入一条上下文（对话、工具输出、日志等）。
   * 内部 appendUser / appendObservation，累积到阈值自动触发概括。
   *
   * @param content 文本内容
   * @param opts.source 来源（文件名、说话者等）
   * @param opts.type "user" | "tool" | "observation"
   */
  feed(
    content: string,
    opts?: { source?: string; type?: "user" | "tool" | "observation" },
  ): void {
    const type = opts?.type ?? "observation";
    switch (type) {
      case "user":
        this.cm.appendUser(content, { source: opts?.source });
        break;
      case "tool":
        this.cm.appendToolResult(content, { source: opts?.source });
        break;
      default:
        this.cm.appendObservation(content, { source: opts?.source });
    }
    this.totalFed += content.length;

    // 自动概括
    if (this.options.autoSummarize) {
      this.maybeAutoSummarize();
    }
  }

  /**
   * 批量喂入（数组形式）。
   */
  feedBatch(
    items: { content: string; source?: string; type?: "user" | "tool" | "observation" }[],
  ): void {
    for (const item of items) {
      this.feed(item.content, { source: item.source, type: item.type });
    }
  }

  // ─── 概括 → 胶囊 ──────────────────────────────────────

  /**
   * 手动触发概括：筛选超龄条目 → LLM 摘要 → 打包胶囊 → 指针化。
   *
   * @param opts.topic 概括主题（可选，自动从内容提取）
   * @param opts.keepRecent 保留最近 N 条不概括（覆盖全局配置）
   * @returns 概括结果（胶囊 + 摘要），无足够条目时返回 null
   */
  async summarize(opts?: {
    topic?: string;
    keepRecent?: number;
  }): Promise<SummarizeOutput | null> {
    if (!this.llmCall) {
      this.log("summarize: 未注入 LLM 调用，使用确定性回退");
    }

    const keepCount = opts?.keepRecent ?? this.options.keepRecent ?? 20;

    // 筛选可概括条目：跳过最近 keepCount 条、跳过已驱逐、跳过受保护
    // 注意 keepRecent=0 时不能 .slice(0, -0)（JS 中 -0===0，返回空数组）
    const allEntries = this.cm.getAllEntries();
    const filtered = allEntries.filter((e) => !e.evicted && !e.protectedBy && e.type !== "system");
    const summarizable = keepCount > 0 && keepCount < filtered.length
      ? filtered.slice(0, -keepCount)  // 保留最近 N 条
      : filtered;                       // keepRecent=0 → 全部概括

    if (summarizable.length < (this.options.minEntriesForSummarize ?? 10)) {
      this.log(`summarize: 可概括条目 ${summarizable.length} < ${this.options.minEntriesForSummarize ?? 10}，跳过`);
      return null;
    }

    const tokenCount = summarizable.reduce((s, e) => s + e.tokenCount, 0);
    this.log(`summarize: 概括 ${summarizable.length} 条目 (${tokenCount} tokens)`);

    // 调用 summarizeAndCapsule
    const topic = opts?.topic ?? `batch_${Date.now()}`;
    const result = await this.cm.summarizeAndCapsule(
      (e) => summarizable.some((s) => s.id === e.id),
      {
        taskId: topic,
        category: "conversation",
        summary: topic,
      },
    );

    if (result) {
      this.totalSummarized += tokenCount;
      this.lastSummarizeAt = Date.now();
      await this.enforceCapsuleLimit();
    }

    return result;
  }

  /**
   * 胶囊数量上限保护：超限时按 createdAt 踢最旧胶囊（同时物理删除 JSON 文件）。
   * 防止 listCapsules / summaryTextL1 在 1000+ 胶囊时遍历全量、渲染慢且占大量 token。
   * 在 summarize() 生成新胶囊后调用。
   */
  private async enforceCapsuleLimit(): Promise<void> {
    const max = this.options.capsuleMaxCount ?? 50;
    if (max <= 0) return; // 0 = 不限制

    const all = await this.cm.listCapsules();
    if (all.length <= max) return;

    // 按 createdAt ASC 排序，踢超出的部分（最旧在前）
    const sorted = all.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sorted.slice(0, sorted.length - max);

    const capsuleStore = this.cm.getCapsuleStore();
    for (const c of toRemove) {
      await capsuleStore.delete(c.id);
    }
    this.log(`enforceCapsuleLimit: 移除最旧 ${toRemove.length} 个胶囊（保留最近 ${max} 个，现 ${sorted.length - toRemove.length} 个）`);
  }

  /**
   * 自动概括检查：累计 tokens 超过阈值时触发。
   * 由 feed() 内部调用，用户无需手动触发。
   */
  private maybeAutoSummarize(): void {
    const activeTokens = this.cm.getEntries().reduce((s, e) => s + e.tokenCount, 0);
    if (activeTokens < (this.options.summarizeInterval ?? 50_000)) return;

    // 节流：距离上次概括至少 30 秒
    if (this.lastSummarizeAt && Date.now() - this.lastSummarizeAt < 30_000) return;

    this.log(`autoSummarize: 活跃 ${activeTokens} tokens ≥ ${this.options.summarizeInterval}，触发概括`);
    // 异步触发，不阻塞 feed()
    this.summarize().catch((err) => {
      this.log(`autoSummarize 失败: ${String(err)}`);
    });
  }

  /**
   * 手动 flush：立即概括所有可概括条目。
   * 适用于会话结束时打包整个对话历史。
   */
  async flush(options?: { topic?: string }): Promise<SummarizeOutput | null> {
    return this.summarize({ ...options, keepRecent: 0 });
  }

  // ─── 语义召回 ─────────────────────────────────────────

  /**
   * 按查询语义召回相关胶囊 + ContentStore 条目。
   *
   * 两步：
   *   1. CapsuleStore 搜索（按文件/主题匹配胶囊）
   *   2. ContentStore FTS5 搜索（按内容匹配被驱逐的原文）
   *
   * @param query 自然语言查询
   * @param opts.topK 最多返回条数（默认 5）
   * @returns 召回结果（胶囊列表 + 条目列表 + 注入文本）
   */
  async recall(
    query: string,
    opts?: { topK?: number },
  ): Promise<RecallResult> {
    const topK = opts?.topK ?? 5;

    // 1. ContentStore FTS5 搜索
    const searchResults = await this.cm.getStore().search(query, {
      mode: "fts5",
      topK: topK * 2,
    });

    // 2. CapsuleStore 匹配（元数据 + chunkSummaries 全文）
    //    注意：只匹配 summary/taskId/files 会漏掉胶囊正文里的关键信息
    //    （尤其 CJK 场景下 taskId 被清洗、中文关键词只存在于 chunkSummaries）。
    //    因此第一轮就加载完整胶囊，对「元数据 + chunkSummaries」整体做关键词匹配。
    const allCapsules = await this.cm.listCapsules();
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);

    const capsuleResults: Capsule[] = [];
    for (const c of allCapsules) {
      const full = await this.cm.getCapsuleStore().load(c.id);
      if (!full) continue;
      const searchText = [
        c.summary,
        c.taskId,
        ...(c.files || []),
        ...(full.chunkSummaries ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (queryWords.some((w) => searchText.includes(w))) {
        capsuleResults.push(full);
      }
      if (capsuleResults.length >= topK * 2) break;
    }

    // 4. 合并去重 + 生成注入文本
    const activeIds = new Set(
      this.cm.getEntries().filter((e) => !e.evicted).map((e) => e.id),
    );
    const entryResults = searchResults
      .filter((r) => !activeIds.has(r.entry.entryId))
      .slice(0, topK)
      .map((r) => r.entry);

    const injectLines: string[] = [];

    if (capsuleResults.length > 0) {
      injectLines.push(`📦 相关胶囊 (${capsuleResults.length}):`);
      for (const c of capsuleResults) {
        injectLines.push(`  • ${c.id}: ${c.summary}`);
        // 注入 chunkSummaries 本体（召回价值的核心）
        if (c.chunkSummaries && c.chunkSummaries.length > 0) {
          for (const s of c.chunkSummaries) {
            injectLines.push(`    ${s.trim()}`);
          }
        }
        injectLines.push(`    调用 recall:context("${c.id}") 展开完整记录`);
      }
      injectLines.push("");
    }

    if (entryResults.length > 0) {
      injectLines.push(`📄 相关片段 (${entryResults.length}):`);
      for (const e of entryResults) {
        const snippet = e.originalContent.slice(0, 200).replace(/\n/g, " ");
        injectLines.push(`  • ${e.source ?? e.entryId}: ${snippet}...`);
      }
    }

    if (injectLines.length === 0) {
      injectLines.push(`未找到与 "${query}" 相关的历史记录。`);
    }

    const injectText = injectLines.join("\n");

    return {
      capsules: capsuleResults,
      entries: entryResults,
      summary: `${capsuleResults.length} 胶囊 + ${entryResults.length} 片段`,
      injectText,
    };
  }

  /**
   * 召回并注入到当前活跃上下文。
   * 注入的条目标记为 [recall]，可被 forgetScoped 清理。
   */
  async recallAndInject(
    query: string,
    opts?: { topK?: number },
  ): Promise<RecallResult> {
    const result = await this.recall(query, opts);
    if (result.injectText && !result.injectText.includes("未找到")) {
      this.cm.appendObservation(result.injectText, {
        source: `recall:${query.slice(0, 30)}`,
        sourceType: "tool_output",
        taskRelevance: 0.5,
      });
    }
    return result;
  }

  // ─── 清理 / 聚焦 ─────────────────────────────────────

  /** 清理上一次召回的注入条目 */
  forgetRecalled(): number {
    return this.cm.forgetScoped();
  }

  /**
   * 忘记（卸载）指定上下文。
   *
   * 如果 target 看起来像文件路径（含 '.' 或 '/'），按文件路径驱逐；
   * 否则按条目 ID 驱逐。
   *
   * @param target 文件路径 或 条目 ID
   * @returns 被移除的条目数
   */
  forget(target: string): number {
    // 路径判断：包含 '.' 或 '/' 的文件路径风格
    if (target.includes("/") || target.includes("\\") || target.includes(".")) {
      return this.cm.forgetFile(target);
    }
    return this.cm.forgetNoise(target) ? 1 : 0;
  }

  /**
   * 聚焦指定文件/目录到工作上下文。
   *
   * @param filePath 文件或目录路径
   * @param opts.symbols 关联的焦点符号
   * @param opts.level L0（元数据，~100t）/ L1（符号大纲，默认）/ L2（完整内容）
   * @returns 聚焦结果
   */
  async focus(
    filePath: string,
    opts?: { symbols?: string[]; level?: "L0" | "L1" | "L2" },
  ): Promise<{ ok: boolean; focused: string[]; output: string }> {
    return this.cm.focusFile(filePath, opts);
  }

  // ─── 状态查询 ─────────────────────────────────────────

  /** 获取引擎统计信息 */
  async getStats(): Promise<EngineStats> {
    const cmStats = this.cm.getStats();
    const capsules = await this.cm.listCapsules();
    const storeStats = await this.cm.getStore().getStorageStats();
    return {
      totalFed: this.totalFed,
      totalSummarized: this.totalSummarized,
      capsuleCount: capsules.length,
      activeEntries: cmStats.activeEntries,
      storedEntries: cmStats.evictedEntries,
      lastSummarizeAt: this.lastSummarizeAt,
      storeStats,
    };
  }

  /** 列出所有胶囊的摘要 */
  async listCapsules(): Promise<{ id: string; taskId: string; summary: string; files: string[]; createdAt: number }[]> {
    return this.cm.listCapsules();
  }

  /** 获取底层 ContextManager（高级用户，直接操作 entries/store/capsules） */
  getContextManager(): ContextManager {
    return this.cm;
  }

  /** 获取 ContentStore（高级用户，直接搜索/索引操作） */
  getStore(): ContentStore {
    return this.cm.getStore();
  }

  /** 获取 CapsuleStore（高级用户） */
  getCapsules(): CapsuleStore {
    return this.cm.getCapsuleStore();
  }

  // ─── 管理策略（热更新） ─────────────────────────────

  /**
   * 设置管理策略（热更新，立即生效）。
   * 可调整阈值与模式，例如开启保守模式：
   *   engine.setManagementPolicy({ conservative: true })
   * 保守模式下 emergencyThreshold 抬到 max(emergencyThreshold, 0.97)，
   * 只有接近满窗口时才把最冷 L3 内容落盘到 L4，避免可召回内容过早丢到磁盘。
   */
  setManagementPolicy(policy: Partial<ManagementPolicy>): void {
    this.cm.setManagementPolicy(policy);
  }

  /** 读取当前管理策略（含默认值与 conservative 标志） */
  getManagementPolicy(): ManagementPolicy {
    return this.cm.getManagementPolicy();
  }

  /** 运行 autoManage（窗口内三层管理 + 持续清理 + 质询） */
  async autoManage(): Promise<void> {
    await this.cm.autoManage();
  }

  /** 清空引擎（重置所有状态） */
  async reset(): Promise<void> {
    this.totalFed = 0;
    this.totalSummarized = 0;
    this.lastSummarizeAt = null;
    // ContextManager 重建
    const cm = new ContextManager({
      maxWindow: this.options.maxWindow,
      storeRoot: this.options.storeRoot,
      capsuleRoot: this.options.capsuleRoot,
    });
    if (this.llmCall) cm.setLlmCall(this.llmCall);
    // 替换内部引用（HACK: 用 any 绕过 readonly）
    (this as any).cm = cm;
  }

  /**
   * 开启新对话：清空活跃条目，保留 ContentStore/CapsuleStore。
   * 上一段对话的内容已概括/驱逐到存储中，可通过 recall 找回。
   */
  newConversation(): number {
    return this.cm.newConversation();
  }

  // ─── 内部 ─────────────────────────────────────────────

  private log(msg: string): void {
    (this.options.logger ?? (() => {}))(`[LongContext] ${msg}`);
  }
}
