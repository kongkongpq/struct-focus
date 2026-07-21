// CapsuleStore 边界条件单测（路线图 2.2.2）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CapsuleStore } from "../src/capsule.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "struct-cap-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("CapsuleStore 边界条件", () => {
  it("build + save + load 往返正确", async () => {
    const caps = new CapsuleStore(root);
    const c = CapsuleStore.buildCapsule("task_alpha", [
      { content: "决定采用方案A。", source: "a.ts" },
      { content: "实现细节在 b.ts。", source: "b.ts" },
    ]);
    await caps.save(c);
    const loaded = await caps.load(c.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(c.id);
    expect(loaded!.taskId).toBe("task_alpha");
    expect(loaded!.files).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
  });

  it("listCapsules 返回全部（按创建顺序）", async () => {
    const caps = new CapsuleStore(root);
    const c1 = CapsuleStore.buildCapsule("t1", [{ content: "x" }]);
    const c2 = CapsuleStore.buildCapsule("t2", [{ content: "y" }]);
    const c3 = CapsuleStore.buildCapsule("t3", [{ content: "z" }]);
    await caps.save(c1);
    await caps.save(c2);
    await caps.save(c3);
    const list = await caps.list();
    expect(list.length).toBe(3);
    expect(list.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);
  });

  it("summaryText / summaryTextL1 产出可读摘要", async () => {
    const caps = new CapsuleStore(root);
    const c = CapsuleStore.buildCapsule("t", [
      { content: "决定采用方案A。", source: "a.ts" },
    ]);
    const l0 = CapsuleStore.summaryText(c);
    const l1 = CapsuleStore.summaryTextL1(c);
    expect(l0).toContain(c.id);
    expect(l1).toContain(c.id);
  });

  it("空内容构建胶囊不崩溃（返回合法结构）", () => {
    const c = CapsuleStore.buildCapsule("empty", []);
    expect(c.id).toContain("empty");
    expect(c.files).toEqual([]);
    expect(c.decisions).toEqual([]);
    expect(c.entryIds).toEqual([]);
  });

  it("buildCapsule 从内容提取决策信号", () => {
    const c = CapsuleStore.buildCapsule("decision", [
      { content: "决定采用 Redis 作为缓存层。" },
    ]);
    expect(c.decisions.length).toBeGreaterThanOrEqual(1);
    expect(c.decisions[0]!.summary).toContain("Redis");
  });
});
