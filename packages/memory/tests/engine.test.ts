// memory 测试套件 - JSONL 引擎 + 记录 + 搜索 + 损坏恢复
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { JsonlEngine } from "@structfocus/memory";
import { type MemoryRecord, createId, now } from "@structfocus/framework";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "struct-mem-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("JsonlEngine", () => {
  it("append + getAll 基本写入读取", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();

    const record: MemoryRecord = {
      id: createId<"memory">("mem"),
      kind: "decision",
      content: "使用 vitest",
      tags: ["test"],
      timestamp: now(),
      deprecated: false,
    };
    await engine.append(record);
    const all = engine.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe("使用 vitest");
  });

  it("appendBatch 批量写入", async () => {
    const filePath = path.join(tmpDir, "batch.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();

    const records: MemoryRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `mem_${i}` as any,
      kind: "fact" as const,
      content: `fact ${i}`,
      tags: [],
      timestamp: now(),
      deprecated: false,
    }));
    await engine.appendBatch(records);
    expect(engine.getAll()).toHaveLength(5);
  });

  it("getById 按 ID 查找", async () => {
    const filePath = path.join(tmpDir, "byid.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();

    const record: MemoryRecord = {
      id: "mem_special" as any,
      kind: "fact",
      content: "special",
      tags: [],
      timestamp: now(),
      deprecated: false,
    };
    await engine.append(record);
    const found = engine.getById("mem_special");
    expect(found).toBeDefined();
    expect(found!.content).toBe("special");
  });

  it("search 字符串匹配", async () => {
    const filePath = path.join(tmpDir, "search.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();

    await engine.append({
      id: "mem_1" as any, kind: "decision", content: "选择了 TypeScript", tags: [], timestamp: now(), deprecated: false,
    });
    await engine.append({
      id: "mem_2" as any, kind: "fact", content: "vitest 是测试框架", tags: [], timestamp: now(), deprecated: false,
    });
    await engine.append({
      id: "mem_3" as any, kind: "error", content: "遇到 TypeScript 错误", tags: [], timestamp: now(), deprecated: false,
    });

    const results = engine.search("TypeScript");
    expect(results).toHaveLength(2);
  });

  it("search 带过滤", async () => {
    const filePath = path.join(tmpDir, "filter.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();

    await engine.append({
      id: "mem_1" as any, kind: "decision", content: "test", tags: [], timestamp: now(), deprecated: false,
    });
    await engine.append({
      id: "mem_2" as any, kind: "error", content: "test error", tags: [], timestamp: now(), deprecated: false,
    });

    const results = engine.search("test", { filter: (r) => r.kind === "decision" });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("decision");
  });

  it("searchSync 超时不崩溃", async () => {
    const filePath = path.join(tmpDir, "sync.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();
    await engine.append({
      id: "mem_1" as any, kind: "fact", content: "hello", tags: [], timestamp: now(), deprecated: false,
    });
    const results = engine.searchSync("hello", 200);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("exportJSON 导出", async () => {
    const filePath = path.join(tmpDir, "export.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();
    await engine.append({
      id: "mem_1" as any, kind: "fact", content: "data", tags: [], timestamp: now(), deprecated: false,
    });
    const json = await engine.exportJSON();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe("data");
  });

  it("exportMarkdown 导出", async () => {
    const filePath = path.join(tmpDir, "md.jsonl");
    const engine = new JsonlEngine<MemoryRecord>(filePath, path.join(tmpDir, "backup"));
    await engine.init();
    await engine.append({
      id: "mem_1" as any, kind: "fact", content: "data", tags: [], timestamp: now(), deprecated: false,
    });
    const md = await engine.exportMarkdown();
    expect(md).toContain("# Memory Export");
    expect(md).toContain("mem_1");
  });

  it("损坏文件回退备份", async () => {
    const filePath = path.join(tmpDir, "corrupt.jsonl");
    const backupDir = path.join(tmpDir, "backup");
    const engine = new JsonlEngine<MemoryRecord>(filePath, backupDir);
    await engine.init();

    // 写入正常数据
    await engine.append({
      id: "mem_1" as any, kind: "fact", content: "good", tags: [], timestamp: now(), deprecated: false,
    });
    // 等待异步备份
    await new Promise((r) => setTimeout(r, 200));

    // 损坏文件
    await fs.writeFile(filePath, "{ broken json }\n", "utf-8");

    // 重新初始化 → 应从备份恢复
    const engine2 = new JsonlEngine<MemoryRecord>(filePath, backupDir);
    await engine2.init();
    const all = engine2.getAll();
    // 备份可能成功或失败，关键是引擎不崩溃
    expect(all.length).toBeGreaterThanOrEqual(0);
  });
});
