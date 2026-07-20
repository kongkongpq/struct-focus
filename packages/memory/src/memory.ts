// @structfocus/memory - Memory 核心类（五层记忆 + 侧车语义）

import { type MemoryRecord, type MemoryKind, type KnowledgeCapsule, type ContextPointer, type EnvironmentPackage, type RetrievedMemory, createId, now } from "@structfocus/framework";
import { JsonlEngine } from "./engine.js";
import { CapsuleManager, type CapsuleInput } from "./capsule.js";
import { PointerManager, type PointerInput } from "./pointer.js";
import { EnvironmentManager } from "./environment.js";
import { OnboardingManager } from "./onboarding.js";
import * as path from "node:path";

export interface MemoryOptions {
  readonly rootPath: string;
  readonly storageDir?: string;
}

function ensureRoot(p: string): string {
  return p;
}

/**
 * Memory：五层记忆 + 侧车语义。
 *
 * 五层：瞬时(上下文指针) → 工作(会话状态) → 情节(胶囊/记录) → 项目(环境包/ONBOARDING) → 语义(外部 RAG 预留)
 *
 * 侧车时序：
 * - T1 同步检索 200ms 超时（不阻塞主流程）
 * - T3 异步写入 fire-and-forget（失败重试）
 * - T5 后台维护（智能驱逐/衰减，预留）
 */
export class Memory {
  readonly rootPath: string;
  readonly storageDir: string;
  readonly backupDir: string;

  private readonly recordEngine: JsonlEngine<MemoryRecord>;
  private readonly capsuleEngine: JsonlEngine<KnowledgeCapsule>;
  private readonly pointerEngine: JsonlEngine<ContextPointer>;
  private readonly capsuleMgr: CapsuleManager;
  private readonly pointerMgr: PointerManager;
  private readonly envMgr: EnvironmentManager;
  private readonly onboardingMgr: OnboardingManager;

  private initialized = false;

  constructor(opts: MemoryOptions) {
    this.rootPath = ensureRoot(opts.rootPath);
    this.storageDir = opts.storageDir ?? path.join(this.rootPath, ".agent");
    this.backupDir = path.join(this.storageDir, "backup");

    const memDir = path.join(this.storageDir, "memory");
    this.recordEngine = new JsonlEngine<MemoryRecord>(
      path.join(memDir, "records.jsonl"),
      this.backupDir,
    );
    this.capsuleEngine = new JsonlEngine<KnowledgeCapsule>(
      path.join(memDir, "capsules.jsonl"),
      this.backupDir,
    );
    this.pointerEngine = new JsonlEngine<ContextPointer>(
      path.join(memDir, "pointers.jsonl"),
      this.backupDir,
    );

    this.capsuleMgr = new CapsuleManager(this.capsuleEngine);
    this.pointerMgr = new PointerManager(this.pointerEngine);
    this.envMgr = new EnvironmentManager(this.storageDir);
    this.onboardingMgr = new OnboardingManager(this.rootPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.recordEngine.init();
    await this.capsuleEngine.init();
    await this.pointerEngine.init();
    await this.envMgr.init();
    await this.onboardingMgr.init();
    this.initialized = true;
  }

  // ── 记忆记录（4 类） ──────────────────────────────────

  async record(input: {
    kind: MemoryKind;
    content: string;
    context?: Record<string, unknown>;
    tags?: string[];
    confidence?: number;
  }): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: createId<"memory">("mem"),
      kind: input.kind,
      content: input.content,
      context: input.context as Record<string, unknown> as any,
      tags: input.tags ?? [],
      timestamp: now(),
      confidence: input.confidence,
      deprecated: false,
    };
    await this.recordEngine.append(record);
    return record;
  }

  getRecords(kind?: MemoryKind): MemoryRecord[] {
    const all = this.recordEngine.getAll();
    return kind ? all.filter((r) => r.kind === kind) : all;
  }

  search(query: string, opts?: { limit?: number; kind?: MemoryKind }): MemoryRecord[] {
    return this.recordEngine.search(query, {
      limit: opts?.limit,
      filter: (r) => !r.deprecated && (!opts?.kind || r.kind === opts.kind),
    });
  }

  searchSync(query: string, timeoutMs = 200, opts?: { limit?: number }): RetrievedMemory[] {
    const records = this.recordEngine.searchSync(query, timeoutMs, opts);
    return records.map((r) => ({
      kind: r.kind,
      summary: r.content.slice(0, 200),
      relevance: 1.0,
    }));
  }

  // ── 胶囊 ─────────────────────────────────────────────

  async recordCapsule(input: CapsuleInput): Promise<KnowledgeCapsule> {
    return this.capsuleMgr.recordCapsule(input);
  }

  getCapsule(id: string): KnowledgeCapsule | undefined {
    return this.capsuleMgr.getCapsule(id);
  }

  searchCapsules(query: string, opts?: { limit?: number }): KnowledgeCapsule[] {
    return this.capsuleMgr.searchCapsules(query, opts);
  }

  getActiveCapsules(): KnowledgeCapsule[] {
    return this.capsuleMgr.getActiveCapsules();
  }

  async deprecateCapsule(id: string, reason?: string): Promise<void> {
    return this.capsuleMgr.deprecate(id, reason);
  }

  async processCapsuleRetryQueue(): Promise<void> {
    return this.capsuleMgr.processRetryQueue();
  }

  // ── 可逆指针 ─────────────────────────────────────────

  async createPointer(input: PointerInput): Promise<ContextPointer> {
    return this.pointerMgr.createPointer(input);
  }

  expandPointer(pointerId: string): string | null {
    return this.pointerMgr.expandPointer(pointerId);
  }

  getPointer(pointerId: string): ContextPointer | undefined {
    return this.pointerMgr.getPointer(pointerId);
  }

  findPointersByFile(file: string): ContextPointer[] {
    return this.pointerMgr.findByFile(file);
  }

  searchPointers(query: string, opts?: { limit?: number }): ContextPointer[] {
    return this.pointerMgr.searchPointers(query, opts);
  }

  async associatePointer(pointerId: string, capsuleId: string): Promise<void> {
    return this.pointerMgr.associate(pointerId, capsuleId);
  }

  getAllPointers(): ContextPointer[] {
    return this.pointerMgr.getAll();
  }

  // ── 环境打包 ─────────────────────────────────────────

  async recordEnvironment(projectName?: string): Promise<EnvironmentPackage> {
    return this.envMgr.recordEnvironment(projectName ?? "project", this.rootPath);
  }

  getEnvironment(): EnvironmentPackage | null {
    return this.envMgr.getEnvironment();
  }

  // ── ONBOARDING ───────────────────────────────────────

  getOnboarding(): string | null {
    return this.onboardingMgr.getOnboarding();
  }

  async generateOnboarding(): Promise<string> {
    return this.onboardingMgr.generateOnboarding();
  }

  // ── 导出 ─────────────────────────────────────────────

  async exportJSON(): Promise<{
    records: string;
    capsules: string;
    pointers: string;
  }> {
    return {
      records: await this.recordEngine.exportJSON(),
      capsules: await this.capsuleEngine.exportJSON(),
      pointers: await this.pointerEngine.exportJSON(),
    };
  }

  async exportMarkdown(): Promise<{
    records: string;
    capsules: string;
    pointers: string;
  }> {
    return {
      records: await this.recordEngine.exportMarkdown(),
      capsules: await this.capsuleEngine.exportMarkdown(),
      pointers: await this.pointerEngine.exportMarkdown(),
    };
  }

  // ── 汇报概况（记忆可见性命令） ─────────────────────────

  getSummary(): { capsules: number; decisions: number; errors: number; pointers: number } {
    return {
      capsules: this.getActiveCapsules().length,
      decisions: this.getRecords("decision").length,
      errors: this.getRecords("error").length,
      pointers: this.getAllPointers().length,
    };
  }

  // ── 关闭 ─────────────────────────────────────────────

  async close(): Promise<void> {
    await this.recordEngine.close();
    await this.capsuleEngine.close();
    await this.pointerEngine.close();
  }
}
