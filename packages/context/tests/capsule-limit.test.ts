import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LongContextEngine } from "../src/longcontext-engine.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("胶囊 count 上限 (STRUCT_CAPSULE_MAX_COUNT)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sf-caplimit-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("超限时按 createdAt 踢最旧胶囊，总数不超过上限", async () => {
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "store"),
      capsuleRoot: path.join(dir, "caps"),
      capsuleMaxCount: 3,
      minEntriesForSummarize: 5,
      autoSummarize: false,
    });

    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        engine.feed(`任务${i} 条目${j}：这是一段需要概括的上下文内容，包含信息 ${i}-${j}`, {
          source: `task_${i}_${j}.ts`,
          type: "observation",
        });
      }
      await engine.flush({ topic: `task_${i}` });
      engine.newConversation(); // 清空活跃条目，保留胶囊
    }

    const capsules = await engine.listCapsules();
    expect(capsules.length).toBeLessThanOrEqual(3);
    const ids = capsules.map((c) => c.taskId).sort();
    expect(ids).toEqual(["task_3", "task_4", "task_5"]);
  });

  it("capsuleMaxCount=0 表示不限制", async () => {
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "store2"),
      capsuleRoot: path.join(dir, "caps2"),
      capsuleMaxCount: 0,
      minEntriesForSummarize: 5,
      autoSummarize: false,
    });
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 6; j++) {
        engine.feed(`任务${i} 条目${j} 内容 ${i}-${j}`, {
          source: `t_${i}_${j}.ts`,
          type: "observation",
        });
      }
      await engine.flush({ topic: `unlim_${i}` });
      engine.newConversation();
    }
    const capsules = await engine.listCapsules();
    expect(capsules.length).toBe(4);
  });
});
