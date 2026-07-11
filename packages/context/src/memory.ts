// @struct/context - 记忆后端（recall/remember 的存储与检索，缺口 A 修复）
//
// 默认 InMemoryBackend（零依赖，分词逐词匹配 + 命中次数相关性排序）；
// 可替换为 SqliteFtsBackend（FTS5，见 memory-sqlite.ts）实现持久化与更精准检索。
// ContextManager 通过构造参数 memory 注入后端，缺省为内存后端。

export interface MemoryEntry {
  readonly kind: string;
  content: string;
  tags: string[];
  confidence: number;
  timestamp: number;
}

export interface MemoryBackend {
  /** 写入一条记忆 */
  add(entry: MemoryEntry): void;
  /** 检索与 query 相关的记忆，按相关性降序，最多返回 limit 条 */
  search(query: string, limit: number): MemoryEntry[];
  /** 全部记忆（只读） */
  all(): readonly MemoryEntry[];
}

function normalize(s: string): string {
  return s.toLowerCase();
}

/**
 * 查询分词：去标点、按空白切分；中文长词再拆 2-gram 提升无词边界语言的召回。
 * 这样长查询会被拆成多个词逐词匹配，避免原实现「超长子串 includes」几乎不命中的问题。
 */
export function tokenizeQuery(query: string): string[] {
  const lower = normalize(query);
  const raw = lower
    .replace(/[，。！？、；：,.;:!?（）()【】\[\]"'`\n\r\t]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  const tokens: string[] = [];
  for (const w of raw) {
    tokens.push(w);
    // 中文长词无词边界，拆成相邻 2-gram 作为额外匹配单元
    if (/[一-鿿]/.test(w) && w.length > 2) {
      for (let i = 0; i + 2 <= w.length; i++) tokens.push(w.slice(i, i + 2));
    }
  }
  return Array.from(new Set(tokens));
}

/** 计算单条记忆对查询 tokens 的命中情况（命中次数 + 置信度） */
function scoreEntry(entry: MemoryEntry, tokens: string[]): { hits: number; confidence: number } {
  const content = normalize(entry.content);
  const tags = entry.tags.map(normalize);
  let hits = 0;
  for (const t of tokens) {
    const inContent = content.includes(t);
    const inTags = tags.some((tag) => tag.includes(t) || t.includes(tag));
    if (inContent || inTags) hits++;
  }
  return { hits, confidence: entry.confidence };
}

/**
 * 内存记忆后端（默认）。分词逐词匹配 + 命中次数降序排序，
 * 长查询退化为整体子串匹配，保证非空查询至少能命中。
 */
export class InMemoryBackend implements MemoryBackend {
  private readonly store: MemoryEntry[] = [];

  add(entry: MemoryEntry): void {
    this.store.push(entry);
  }

  all(): readonly MemoryEntry[] {
    return this.store;
  }

  search(query: string, limit: number): MemoryEntry[] {
    const tokens = tokenizeQuery(query);
    // 空分词（如单字符/纯标点查询）退化为整体子串匹配
    if (tokens.length === 0) {
      const q = normalize(query);
      return this.store
        .filter((m) => m.content.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q)))
        .slice(-limit);
    }
    return this.store
      .map((m) => ({ m, score: scoreEntry(m, tokens) }))
      .filter((x) => x.score.hits > 0)
      .sort((a, b) => b.score.hits - a.score.hits || b.score.confidence - a.score.confidence)
      .slice(0, limit)
      .map((x) => x.m);
  }
}
