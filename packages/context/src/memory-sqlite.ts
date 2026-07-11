// @struct/context - SQLite FTS5 记忆后端（缺口 A 中期方案，可选模块）
//
// 通过 better-sqlite3（同步 API）实现 FTS5 全文检索 + 持久化，是 MemoryBackend 的一种实现。
// 注意：better-sqlite3 为原生模块，需在运行时可用。本文件不直接静态 import 该原生模块，
// 以保留 context 包对它的「可选」依赖特性（仅在注入 SqliteFtsBackend 时才需要）。
import { createRequire } from "node:module";
import { type MemoryBackend, type MemoryEntry } from "./memory.js";

interface SqliteStmt {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDb {
  pragma(source: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStmt;
  close(): unknown;
}

/**
 * 基于 SQLite FTS5 的记忆后端。FTS5 提供按词/前缀匹配与 rank 排序，
 * 比内存后端的子串匹配更精准，且可跨会话持久化（dbPath 指定文件）。
 */
export class SqliteFtsBackend implements MemoryBackend {
  private readonly db: SqliteDb;
  private readonly dbPath: string;

  constructor(dbPath = ":memory:") {
    this.dbPath = dbPath;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = req("better-sqlite3");
    const db = new Database(dbPath) as SqliteDb;
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        confidence REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags);
    `);
    this.db = db;
  }

  add(entry: MemoryEntry): void {
    const res = this.db
      .prepare("INSERT INTO memories (kind, content, tags, confidence, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(entry.kind, entry.content, JSON.stringify(entry.tags), entry.confidence, entry.timestamp) as {
      lastInsertRowid: number | bigint;
    };
    const rowid = Number(res.lastInsertRowid);
    this.db.prepare("INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)").run(rowid, entry.content, entry.tags.join(" "));
  }

  all(): readonly MemoryEntry[] {
    const rows = this.db.prepare("SELECT kind, content, tags, confidence, timestamp FROM memories").all();
    return rows.map((r) => this.rowToEntry(r));
  }

  search(query: string, limit: number): MemoryEntry[] {
    const tokens = query.toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean);
    if (tokens.length === 0) {
      return this.all().slice(-limit);
    }
    const match = tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT m.kind, m.content, m.tags, m.confidence, m.timestamp
         FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit);
    return rows.map((r) => this.rowToEntry(r));
  }

  private rowToEntry(r: Record<string, unknown>): MemoryEntry {
    return {
      kind: String(r.kind ?? "decision"),
      content: String(r.content ?? ""),
      tags: safeParseTags(r.tags),
      confidence: Number(r.confidence ?? 0.85),
      timestamp: Number(r.timestamp ?? 0),
    };
  }

  /** 关闭底层数据库连接（进程退出前调用） */
  close(): void {
    this.db.close();
  }
}

function safeParseTags(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
