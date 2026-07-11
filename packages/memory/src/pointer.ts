// @struct/memory - 上下文可逆指针管理

import type { ContextPointer, Importance, PointerType } from "@struct/framework";
import { createId, now } from "@struct/framework";
import { JsonlEngine } from "./engine.js";

export interface PointerInput {
  type: PointerType;
  topic: string;
  files: string[];
  decision?: string;
  keywords: string[];
  importance: Importance;
  content: string; // 完整内容（落盘存储，上下文中仅放指针）
  linkedCapsuleIds?: string[];
}

/**
 * 可逆指针管理器：
 * - create: 完整内容落盘，返回轻量指针（~50 tokens）
 * - expand: 按 ID 恢复完整内容（100% 保真）
 * - associate: 自动关联触发（检测文件 → 推送相关指针候选）
 */
export class PointerManager {
  private readonly engine: JsonlEngine<ContextPointer>;
  private readonly contentStore: Map<string, string> = new Map();

  constructor(engine: JsonlEngine<ContextPointer>) {
    this.engine = engine;
  }

  async createPointer(input: PointerInput): Promise<ContextPointer> {
    const id = createId<"pointer">("ptr");
    const timestamp = now();
    const contentRef = `ptr_content:${id}:${timestamp}`;

    // 完整内容存入内存映射（实际可落盘为单独 JSONL）
    this.contentStore.set(contentRef, input.content);

    const pointer: ContextPointer = {
      id,
      type: input.type,
      topic: input.topic,
      files: input.files,
      decision: input.decision,
      keywords: input.keywords,
      timestamp,
      importance: input.importance,
      linkedCapsuleIds: input.linkedCapsuleIds,
      contentRef,
      estimatedTokens: Math.ceil(input.content.length / 4), // 粗估
    };

    await this.engine.append(pointer);
    return pointer;
  }

  /** 展开指针为完整内容（100% 保真） */
  expandPointer(pointerId: string): string | null {
    const pointer = this.engine.getById(pointerId);
    if (!pointer) return null;
    return this.contentStore.get(pointer.contentRef) ?? null;
  }

  /** 获取指针元数据 */
  getPointer(pointerId: string): ContextPointer | undefined {
    return this.engine.getById(pointerId);
  }

  /** 按文件查找关联指针（自动关联触发） */
  findByFile(file: string): ContextPointer[] {
    return this.engine
      .getAll()
      .filter((p) => p.files.some((f: string) => f === file || file.startsWith(f.replace("*", ""))));
  }

  /** 按关键词搜索 */
  searchPointers(query: string, opts?: { limit?: number }): ContextPointer[] {
    return this.engine.search(query, opts);
  }

  /** 关联胶囊 */
  async associate(pointerId: string, capsuleId: string): Promise<void> {
    const pointer = this.engine.getById(pointerId);
    if (!pointer) return;

    const updated: ContextPointer = {
      ...pointer,
      linkedCapsuleIds: [...(pointer.linkedCapsuleIds ?? []), capsuleId],
    };
    await this.engine.append(updated);
  }

  /** 按重要性过滤 */
  getByImportance(level: Importance): ContextPointer[] {
    return this.engine.getAll().filter((p) => p.importance === level);
  }

  /** 获取所有指针 */
  getAll(): ContextPointer[] {
    return this.engine.getAll();
  }
}
