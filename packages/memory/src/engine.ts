// @struct/memory - JSONL 读写引擎

import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * JSONL 引擎：append-only 写入 + scan 读取 + string-match 搜索。
 * - 每行一个 JSON 对象
 * - 写入后异步备份到 .agent/backup/（保留 N 份 / 7 天滚动）
 * - 启动时完整性校验，损坏回退最近备份
 */
export class JsonlEngine<T extends { id: string; timestamp: string }> {
  private readonly filePath: string;
  private readonly backupDir: string;
  private readonly maxBackups: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private backupQueue: Promise<void> = Promise.resolve();
  private cache: T[] | null = null;
  private writeCount = 0;
  private readonly backupInterval: number;

  constructor(
    filePath: string,
    backupDir: string,
    maxBackups = 7,
    backupInterval = 5,
  ) {
    this.filePath = filePath;
    this.backupDir = backupDir;
    this.maxBackups = maxBackups;
    this.backupInterval = backupInterval;
  }

  /** Windows EBUSY 重试 */
  private async retryOnBusy<T2>(fn: () => Promise<T2>, retries = 3): Promise<T2> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EBUSY" || code === "EPERM") {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
    return fn();
  }

  /** 初始化：创建目录 + 完整性校验 + 加载缓存 */
  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.mkdir(this.backupDir, { recursive: true });
    await this.validateAndRepair();
    this.cache = await this.scanAll();
  }

  /** 追加一条记录 */
  async append(record: T): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const line = JSON.stringify(record) + "\n";
      await this.retryOnBusy(() => fs.appendFile(this.filePath, line, "utf-8"));
      if (this.cache) {
        this.cache.push(record);
      }
      this.writeCount++;
      // 每 N 次写入才备份一次（减少 Windows 文件锁冲突）
      if (this.writeCount % this.backupInterval === 0) {
        this.scheduleBackup();
      }
    });
    await this.writeQueue;
  }

  /** 批量追加 */
  async appendBatch(records: readonly T[]): Promise<void> {
    if (records.length === 0) return;
    this.writeQueue = this.writeQueue.then(async () => {
      const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await this.retryOnBusy(() => fs.appendFile(this.filePath, lines, "utf-8"));
      if (this.cache) {
        this.cache.push(...records);
      }
      this.writeCount += records.length;
      this.scheduleBackup();
    });
    await this.writeQueue;
  }

  /** 读取全部记录（从缓存） */
  getAll(): T[] {
    return this.cache ? [...this.cache] : [];
  }

  /** 按 ID 查找 */
  getById(id: string): T | undefined {
    return this.cache?.find((r) => r.id === id);
  }

  /** 字符串匹配搜索（O(N×M)，<10000 条可接受） */
  search(
    query: string,
    opts?: { limit?: number; filter?: (r: T) => boolean },
  ): T[] {
    if (!this.cache) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const results: { record: T; score: number }[] = [];
    for (const record of this.cache) {
      if (opts?.filter && !opts.filter(record)) continue;
      const text = JSON.stringify(record).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score++;
      }
      if (score > 0) {
        results.push({ record, score });
      }
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.record.timestamp.localeCompare(a.record.timestamp);
    });

    const limit = opts?.limit ?? 50;
    return results.slice(0, limit).map((r) => r.record);
  }

  /** 带超时的搜索（侧车同步检索 T1 200ms 超时） */
  searchSync(query: string, timeoutMs = 200, opts?: { limit?: number }): T[] {
    try {
      const start = Date.now();
      const results = this.search(query, opts);
      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs) {
        // 超时：返回空（不阻塞主流程）
        return [];
      }
      return results;
    } catch {
      return [];
    }
  }

  /** 扫描全部记录（从磁盘） */
  private async scanAll(): Promise<T[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const records: T[] = [];
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as T);
        } catch {
          // 跳过损坏行
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /** 完整性校验 + 损坏回退 */
  private async validateAndRepair(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        JSON.parse(line); // 校验每行
      }
    } catch {
      // 文件损坏，尝试从备份恢复
      const restored = await this.restoreFromBackup();
      if (!restored) {
        // 无备份，重置文件
        await fs.writeFile(this.filePath, "", "utf-8");
      }
    }
  }

  /** 调度异步备份（独立队列，不阻塞写入） */
  private scheduleBackup(): void {
    this.backupQueue = this.backupQueue
      .then(() => this.backup())
      .catch(() => {});
  }

  /** 异步备份当前文件 */
  private async backup(): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(
        this.backupDir,
        `${path.basename(this.filePath)}.${stamp}`,
      );
      await this.retryOnBusy(() => fs.copyFile(this.filePath, backupPath));
      await this.rotateBackups();
    } catch {
      // 备份失败不阻塞主流程
    }
  }

  /** 滚动清理旧备份（保留 N 份 / 7 天） */
  private async rotateBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.backupDir);
      const basename = path.basename(this.filePath);
      const backups = files
        .filter((f) => f.startsWith(basename))
        .sort()
        .reverse();

      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;

      for (let i = 0; i < backups.length; i++) {
        const file = backups[i]!;
        const filePath = path.join(this.backupDir, file);
        const stat = await fs.stat(filePath);
        const age = now - stat.mtimeMs;

        // 超过 N 份 或 超过 7 天 → 删除
        if (i >= this.maxBackups || age > sevenDays) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    } catch {
      // 清理失败不阻塞
    }
  }

  /** 从最近备份恢复 */
  private async restoreFromBackup(): Promise<boolean> {
    try {
      const files = await fs.readdir(this.backupDir);
      const basename = path.basename(this.filePath);
      const backups = files
        .filter((f: string) => f.startsWith(basename))
        .sort()
        .reverse();

      for (const file of backups) {
        const backupPath = path.join(this.backupDir, file);
        try {
          const content = await fs.readFile(backupPath, "utf-8");
          // 验证备份完整性
          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            JSON.parse(line);
          }
          // 恢复
          await fs.copyFile(backupPath, this.filePath);
          return true;
        } catch {
          continue; // 备份也损坏，尝试下一个
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 导出为 JSON */
  async exportJSON(): Promise<string> {
    const records = this.cache ?? (await this.scanAll());
    return JSON.stringify(records, null, 2);
  }

  /** 导出为 Markdown */
  async exportMarkdown(): Promise<string> {
    const records = this.cache ?? (await this.scanAll());
    const lines: string[] = ["# Memory Export", ""];
    for (const r of records) {
      lines.push(`## ${r.id}`, "");
      lines.push("```json", JSON.stringify(r, null, 2), "```", "");
    }
    return lines.join("\n");
  }

  /** 刷新缓存 */
  async flush(): Promise<void> {
    this.cache = await this.scanAll();
  }

  /** 关闭：等待写入和备份队列完成 */
  async close(): Promise<void> {
    await this.writeQueue;
    await this.backupQueue;
  }
}
