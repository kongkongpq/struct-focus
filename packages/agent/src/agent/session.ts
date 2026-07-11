// struct-agent - 会话持久化与跨会话恢复

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createId, now } from "@struct/framework";
import type { Message } from "@struct/framework";

export interface SessionState {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: Message[];
  readonly pointers: readonly string[];
  readonly lastStep: number;
  readonly status: "active" | "paused" | "completed" | "aborted";
  readonly metadata?: Record<string, unknown>;
}

export class SessionManager {
  private readonly sessionDir: string;

  constructor(stateDir: string) {
    this.sessionDir = path.join(stateDir, "sessions");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  createSession(): SessionState {
    const id = createId("session");
    const ts = now();
    return { id, createdAt: ts, updatedAt: ts, messages: [], pointers: [], lastStep: 0, status: "active" };
  }

  async save(session: SessionState): Promise<void> {
    const updated = { ...session, updatedAt: now() };
    const filePath = path.join(this.sessionDir, `${session.id}.json`);
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  async load(sessionId: string): Promise<SessionState | null> {
    try {
      const content = await fs.readFile(path.join(this.sessionDir, `${sessionId}.json`), "utf-8");
      return JSON.parse(content);
    } catch { return null; }
  }

  async list(): Promise<SessionState[]> {
    try {
      const files = await fs.readdir(this.sessionDir);
      const sessions: SessionState[] = [];
      for (const file of files) {
        if (file.endsWith(".json")) {
          try { sessions.push(JSON.parse(await fs.readFile(path.join(this.sessionDir, file), "utf-8"))); } catch {}
        }
      }
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch { return []; }
  }

  async delete(sessionId: string): Promise<void> {
    await fs.unlink(path.join(this.sessionDir, `${sessionId}.json`)).catch(() => {});
  }

  async resume(sessionId: string): Promise<SessionState | null> {
    const session = await this.load(sessionId);
    if (!session) return null;
    return { ...session, status: "active" };
  }
}
