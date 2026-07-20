// @structfocus/harness - StateManager（L7 原子写入 + Checkpoint）

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createId } from "@structfocus/framework";

export interface Checkpoint {
  readonly id: string;
  readonly timestamp: string;
  readonly files: readonly { path: string; hash: string }[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * StateManager：L7 原子写入 + 文件锁 + Checkpoint。
 * - 原子写入：tmp → fsync → rename
 * - Checkpoint：记录文件状态快照，支持回滚
 */
export class StateManager {
  private readonly stateDir: string;
  private readonly checkpointDir: string;
  private readonly lockFile: string;
  private locked = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.checkpointDir = path.join(stateDir, "checkpoints");
    this.lockFile = path.join(stateDir, ".lock");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.checkpointDir, { recursive: true });
  }

  /** 原子写入：tmp → fsync → rename */
  async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + ".tmp." + createId("tmp");
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const fd = await fs.open(tmpPath, "w");
    try {
      await fd.writeFile(content, "utf-8");
      await fd.sync(); // fsync
    } finally {
      await fd.close();
    }

    // rename（原子操作）
    await fs.rename(tmpPath, filePath);
  }

  /** 创建 Checkpoint */
  async createCheckpoint(
    files: readonly string[],
    metadata?: Record<string, unknown>,
  ): Promise<Checkpoint> {
    const id = createId("ckpt");
    const timestamp = new Date().toISOString();
    const fileHashes: { path: string; hash: string }[] = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(file);
        const hash = await this.simpleHash(content.toString("utf-8"));
        fileHashes.push({ path: file, hash });
      } catch {
        // 文件不存在
      }
    }

    const checkpoint: Checkpoint = { id, timestamp, files: fileHashes, metadata };
    const ckptPath = path.join(this.checkpointDir, `${id}.json`);
    await this.atomicWrite(ckptPath, JSON.stringify(checkpoint, null, 2));
    return checkpoint;
  }

  /** 获取 Checkpoint */
  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    try {
      const content = await fs.readFile(
        path.join(this.checkpointDir, `${id}.json`),
        "utf-8",
      );
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /** 列出所有 Checkpoint */
  async listCheckpoints(): Promise<Checkpoint[]> {
    try {
      const files = await fs.readdir(this.checkpointDir);
      const checkpoints: Checkpoint[] = [];
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const content = await fs.readFile(
              path.join(this.checkpointDir, file),
              "utf-8",
            );
            checkpoints.push(JSON.parse(content));
          } catch {
            // 跳过损坏的
          }
        }
      }
      return checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }

  /** 获取文件锁 */
  async acquireLock(): Promise<boolean> {
    if (this.locked) return false;
    try {
      await fs.writeFile(this.lockFile, String(process.pid), { flag: "wx" });
      this.locked = true;
      return true;
    } catch {
      // 锁文件已存在
      return false;
    }
  }

  /** 释放文件锁 */
  async releaseLock(): Promise<void> {
    if (!this.locked) return;
    try {
      await fs.unlink(this.lockFile);
    } catch {
      // 锁文件不存在
    }
    this.locked = false;
  }

  /** 简单 hash（非加密，用于变更检测） */
  private async simpleHash(text: string): Promise<string> {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(16);
  }
}
