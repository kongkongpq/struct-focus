// @struct/context — ContentStore：外部存储，保存被截断/驱逐的原始内容
// 零外部依赖。磁盘文件按 entry id 哈希分片，支持 FTS5 全文搜索、回想、展开、审计。
// ContextManager 在 truncate/ evict/ forget 时调用 save()，
// 在 expand/ recall 时调用 load() / search()。
//
// 2026-07-19 LongContextRecall 扩展：+search() / +searchMulti() / +rebuildIndex() / +indexEntry()

import { promises as fs } from "node:fs";
import path from "node:path";

export interface StoredContent {
  entryId: string;
  originalContent: string;
  originalTokenCount: number;
  savedAt: number;
  reason: "truncate" | "evict" | "forget" | "auto-remember" | "summarize" | "new-conversation" | "downgrade_L4";
  source?: string;
  sourceType?: string;
  capsuleSummary?: string;
  /** 关联的 capsule id */
  capsuleId?: string;
}

export interface SearchResult {
  entry: StoredContent;
  score: number;
  matchField: string;
  snippet: string;
}

export interface SearchOptions {
  mode: "fts5" | "hybrid";
  topK: number;
  minScore?: number;
  savedAfter?: number;
  savedBefore?: number;
  sourcePattern?: string;
  capsuleId?: string;
}

// ─── 简易内存 FTS5 全文索引 ─────────────────────────────

interface IndexEntry {
  entryId: string;
  tokens: Map<string, number>; // token → frequency
  source: string;
  savedAt: number;
}

/** 简易 TF-IDF 分词器：按空格/标点分割，最小 2 字符，去停用词 */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "but", "in",
    "with", "to", "for", "of", "by", "from", "as", "be", "was", "are",
    "been", "were", "it", "its", "this", "that", "these", "those", "has",
    "have", "had", "not", "no", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "you", "your",
    "we", "our", "they", "their", "he", "she", "his", "her", "him",
    "if", "else", "then", "than", "so", "very", "just", "also", "about",
  ]);
  return text
    .toLowerCase()
    .split(/[\s,，。！？、；：""'「」『』()（）\[\]【】{}<>/\-–—|\\@#$%^&*+=~`\t\n\r]+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

/**
 * 中文感知分词：先走 Intl.Segmenter 拆词，再走空格/标点分割。
 * Intl.Segmenter 将 "数据库迁移" 拆为 ["数据", "库", "迁移"]，
 * 然后 2-gram 组合为 ["数据库", "库迁移"] 提升匹配。
 */
function tokenizeChinese(text: string): string[] {
  const stopWords = new Set([
    "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
    "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
    "自己", "这", "他", "她", "它", "们", "那", "这个", "那个", "什么", "怎么",
    "可以", "因为", "所以", "但是", "如果", "虽然", "而且", "或", "还是",
  ]);

  try {
    const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
    const segments = Array.from(segmenter.segment(text))
      .filter((s) => s.isWordLike)
      .map((s) => s.segment.toLowerCase().trim())
      .filter((w) => w.length >= 1 && !stopWords.has(w));

    // 生成 unigrams + bigrams（覆盖拆词不完整的情况）
    const tokens: string[] = [];
    for (const seg of segments) {
      if (seg.length >= 2 || /^[a-zA-Z0-9_]+$/.test(seg)) tokens.push(seg);
    }
    // bigram 组合相邻词 → "数据库迁移" → ["数据库", "库迁移"]
    for (let i = 0; i < segments.length - 1; i++) {
      const a = segments[i];
      const b = segments[i + 1];
      if (a && b) {
        const bigram = a + b;
        if (bigram.length >= 2) tokens.push(bigram);
      }
    }
    return tokens;
  } catch {
    // 退回到英文字符分割
    return tokenize(text);
  }
}

/**
 * 智能分词：如果文本含中文（CJK Range），走中文分词；否则走英文。
 */
function smartTokenize(text: string): string[] {
  const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
  return hasCJK ? tokenizeChinese(text) : tokenize(text);
}

/** BM25 相似度计算（简化版，k1=1.5, b=0.75） */
function bm25Score(
  queryTokens: string[],
  docTokens: Map<string, number>,
  docLength: number,
  avgDocLength: number,
  totalDocs: number,
  docFreq: Map<string, number>,
): number {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;
  for (const qt of queryTokens) {
    const tf = docTokens.get(qt) ?? 0;
    if (tf === 0) continue;
    const df = docFreq.get(qt) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
    score += idf * norm;
  }
  return score;
}

/** 生成匹配片段（~100 chars 上下文） */
function generateSnippet(content: string, queryTokens: string[]): string {
  const lower = content.toLowerCase();
  let bestIdx = 0;
  let bestHits = 0;
  // 滑动窗口 200 chars 找最高命中密度
  for (let i = 0; i < lower.length - 50; i += 50) {
    const window = lower.slice(i, i + 200);
    let hits = 0;
    for (const qt of queryTokens) {
      if (window.includes(qt)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestIdx = i;
    }
  }
  const start = Math.max(0, bestIdx - 20);
  const end = Math.min(content.length, bestIdx + 200);
  return (start > 0 ? "..." : "") + content.slice(start, end).replace(/\n/g, " ") + (end < content.length ? "..." : "");
}

/**
 * 磁盘内容存储。
 * 保存被截断/驱逐条目的完整原文，支持 FTS5 全文搜索召回。
 * 按 entry id 哈希分片 (shard 256) 写入独立文件，避免单文件膨胀。
 *
 * 设计约束：
 *   - 不放入 LLM 上下文窗口 — 仅框架侧读写
 *   - 搜索 → 返回 StoredContent[]，调用者决定是否注入
 *   - 存储路径：<root>/entries/<shard>/<entryId>.json
 */
export class ContentStore {
  private readonly root: string;
  private ready = false;
  /** FTS5 内存索引 */
  private index = new Map<string, IndexEntry>();
  private indexDirty = false;
  private totalIndexedDocs = 0;
  private totalIndexedTokens = 0;

  constructor(root: string) {
    this.root = root;
  }

  /** 确保存储目录存在 (惰性初始化) */
  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(this.root, { recursive: true });
    this.ready = true;
    // 惰性建索引
    await this.ensureIndex();
  }

  private shardOf(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) & 0xff;
    }
    return hash.toString(16).padStart(2, "0");
  }

  private entryPath(id: string): string {
    return path.join(this.root, "entries", this.shardOf(id), `${id}.json`);
  }

  async save(entry: StoredContent): Promise<void> {
    await this.ensureReady();
    const p = this.entryPath(entry.entryId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(entry, null, 2), "utf-8");
    // 更新索引
    this.indexEntry(entry);
  }

  async load(id: string): Promise<StoredContent | null> {
    try {
      const raw = await fs.readFile(this.entryPath(id), "utf-8");
      return JSON.parse(raw) as StoredContent;
    } catch {
      return null;
    }
  }

  async loadByFile(source: string): Promise<StoredContent[]> {
    await this.ensureReady();
    const entriesDir = path.join(this.root, "entries");
    const results: StoredContent[] = [];
    try {
      const shards = await fs.readdir(entriesDir);
      for (const shard of shards) {
        const shardDir = path.join(entriesDir, shard);
        const st = await fs.stat(shardDir);
        if (!st.isDirectory()) continue;
        const files = await fs.readdir(shardDir);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          const raw = await fs.readFile(path.join(shardDir, f), "utf-8");
          const entry = JSON.parse(raw) as StoredContent;
          if (entry.source === source) results.push(entry);
        }
      }
    } catch {
      // 目录尚未创建
    }
    return results;
  }

  // ─── FTS5 全文搜索 ───────────────────────────────────

  /** 将单条 StoredContent 加入内存索引 */
  private indexEntry(entry: StoredContent): void {
    const text = [
      entry.originalContent,
      entry.source ?? "",
      entry.capsuleSummary ?? "",
    ].join(" ");
    const tokens = smartTokenize(text);
    const tokenMap = new Map<string, number>();
    for (const t of tokens) {
      tokenMap.set(t, (tokenMap.get(t) ?? 0) + 1);
    }
    this.index.set(entry.entryId, {
      entryId: entry.entryId,
      tokens: tokenMap,
      source: entry.source ?? "",
      savedAt: entry.savedAt,
    });
    this.totalIndexedDocs++;
    this.totalIndexedTokens += tokens.length;
    this.indexDirty = true;
  }

  /** 惰性索引重建（从磁盘全部读取建立索引） */
  private async ensureIndex(): Promise<void> {
    if (this.index.size > 0 && !this.indexDirty) return;
    this.index.clear();
    this.totalIndexedDocs = 0;
    this.totalIndexedTokens = 0;
    const entriesDir = path.join(this.root, "entries");
    try {
      const shards = await fs.readdir(entriesDir);
      for (const shard of shards) {
        const shardDir = path.join(entriesDir, shard);
        const st = await fs.stat(shardDir);
        if (!st.isDirectory()) continue;
        const files = await fs.readdir(shardDir);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          try {
            const raw = await fs.readFile(path.join(shardDir, f), "utf-8");
            const entry = JSON.parse(raw) as StoredContent;
            this.indexEntry(entry);
          } catch {
            // 跳过损坏文件
          }
        }
      }
    } catch {
      // 目录尚未创建
    }
    this.indexDirty = false;
  }

  /**
   * 全文搜索。
   * 对查询分词 → 计算每个已索引文档的 BM25 评分 → 排序 → 返回 topK。
   */
  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    await this.ensureReady();
    const queryTokens = smartTokenize(query);
    if (!queryTokens.length) return [];

    const avgDocLength = this.totalIndexedDocs > 0
      ? this.totalIndexedTokens / this.totalIndexedDocs
      : 1;

    // 计算文档频率
    const docFreq = new Map<string, number>();
    for (const qt of queryTokens) {
      let count = 0;
      for (const [, ie] of this.index) {
        if (ie.tokens.has(qt)) count++;
      }
      docFreq.set(qt, count);
    }

    // 匹配所有文档并评分
    const scored: { entryId: string; score: number }[] = [];
    for (const [id, ie] of this.index) {
      // 时间过滤
      if (opts.savedAfter && ie.savedAt < opts.savedAfter) continue;
      if (opts.savedBefore && ie.savedAt > opts.savedBefore) continue;
      // 来源过滤
      if (opts.sourcePattern && !ie.source.includes(opts.sourcePattern)) continue;

      const docTokens = [...ie.tokens.values()].reduce((a, b) => a + b, 0);
      const score = bm25Score(
        queryTokens,
        ie.tokens,
        docTokens,
        avgDocLength,
        this.totalIndexedDocs,
        docFreq,
      );
      if (score <= 0) continue;
      if (opts.minScore && score < opts.minScore) continue;
      scored.push({ entryId: id, score });
    }

    // 排序
    scored.sort((a, b) => b.score - a.score);

    // 取 topK 并加载完整内容
    const results: SearchResult[] = [];
    for (const s of scored.slice(0, opts.topK)) {
      const entry = await this.load(s.entryId);
      if (!entry) continue;
      // 归一化 score 到 0..1
      const maxScore = scored[0]?.score ?? 1;
      const normScore = maxScore > 0 ? s.score / maxScore : 0;
      results.push({
        entry,
        score: Math.round(normScore * 1000) / 1000,
        matchField: "content",
        snippet: generateSnippet(entry.originalContent, queryTokens),
      });
    }
    return results;
  }

  /** 批量搜索（多 query 并发，合并去重排序） */
  async searchMulti(queries: string[], opts: SearchOptions): Promise<SearchResult[]> {
    const allResults = await Promise.all(queries.map((q) => this.search(q, opts)));
    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    for (const results of allResults) {
      for (const r of results) {
        if (seen.has(r.entry.entryId)) continue;
        seen.add(r.entry.entryId);
        merged.push(r);
      }
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, opts.topK);
  }

  /** 手动重建索引（全量扫描磁盘） */
  async rebuildIndex(): Promise<{ total: number; indexed: number; errors: number }> {
    this.index.clear();
    this.totalIndexedDocs = 0;
    this.totalIndexedTokens = 0;
    let total = 0;
    let indexed = 0;
    let errors = 0;
    const entriesDir = path.join(this.root, "entries");
    try {
      const shards = await fs.readdir(entriesDir);
      for (const shard of shards) {
        const shardDir = path.join(entriesDir, shard);
        const st = await fs.stat(shardDir);
        if (!st.isDirectory()) continue;
        const files = await fs.readdir(shardDir);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          total++;
          try {
            const raw = await fs.readFile(path.join(shardDir, f), "utf-8");
            const entry = JSON.parse(raw) as StoredContent;
            this.indexEntry(entry);
            indexed++;
          } catch {
            errors++;
          }
        }
      }
    } catch {
      // 目录未创建
    }
    this.indexDirty = false;
    return { total, indexed, errors };
  }

  /** 按胶囊 ID 搜索关联条目 */
  async searchByCapsule(capsuleId: string): Promise<StoredContent[]> {
    await this.ensureReady();
    const entriesDir = path.join(this.root, "entries");
    const results: StoredContent[] = [];
    try {
      const shards = await fs.readdir(entriesDir);
      for (const shard of shards) {
        const shardDir = path.join(entriesDir, shard);
        const st = await fs.stat(shardDir);
        if (!st.isDirectory()) continue;
        const files = await fs.readdir(shardDir);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          const raw = await fs.readFile(path.join(shardDir, f), "utf-8");
          const entry = JSON.parse(raw) as StoredContent;
          if (entry.capsuleId === capsuleId) results.push(entry);
        }
      }
    } catch {
      // 目录未创建
    }
    return results;
  }

  /**
   * 生成胶囊摘要：提取决策信号 + 已知限制 + 文件列表
   */
  static generateCapsuleSummary(entries: StoredContent[]): string {
    const files = [...new Set(entries.map(e => e.source).filter(Boolean))];
    const reasons = entries.map(e => e.reason).filter(Boolean);
    const totalTokens = entries.reduce((s, e) => s + e.originalTokenCount, 0);
    const desc = files.length > 0
      ? `涉及 ${files.length} 个文件 (${files.slice(0, 3).join(", ")}${files.length > 3 ? "..." : ""})`
      : `${entries.length} 条上下文`;
    return `📦 ${desc}，原始 ${totalTokens} tokens，${reasons.length > 0 ? `原因: ${reasons.join(", ")}` : ""}`;
  }
}
