// @struct/harness - 审计日志（只追加 JSONL）

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { now } from "@struct/framework";

export interface AuditEntry {
  readonly timestamp: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly result: "success" | "blocked" | "error";
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly reason?: string;
  readonly filesChanged?: string[];
}

/**
 * 只追加审计日志：所有工具调用都记录。
 */
export class AuditLog {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async append(entry: AuditEntry): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const line = JSON.stringify(entry) + "\n";
      await fs.appendFile(this.filePath, line, "utf-8");
    });
    await this.writeQueue;
  }

  async getLog(): Promise<AuditEntry[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    await fs.writeFile(this.filePath, "", "utf-8");
  }
}
