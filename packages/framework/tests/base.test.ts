// framework 测试套件 - 类型地基：Branded ID / Result / Timestamp
import { describe, it, expect } from "vitest";
import { createId, Ok, Err, ResultUtil, now, type Id } from "@structfocus/framework";

describe("Branded ID", () => {
  it("createId 生成带前缀的唯一 ID", () => {
    const id1 = createId("plug");
    const id2 = createId("plug");
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("plug_")).toBe(true);
    expect(id1.length).toBeGreaterThan("plug_".length + 8);
  });

  it("不同 brand 的 ID 不可互相赋值（编译期检查）", () => {
    const pluginId: Id<"plugin"> = createId("plug");
    const toolId: Id<"tool"> = createId("tool");
    expect(pluginId).not.toBe(toolId);
    // 以下赋值在编译期会报错（brand 不同）：
    // const wrong: Id<"tool"> = pluginId;
  });
});

describe("Timestamp", () => {
  it("now 返回 ISO 8601 格式", () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("Result<T, E>", () => {
  it("Ok 创建成功结果", () => {
    const r = Ok(42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it("Err 创建错误结果", () => {
    const r = Err(new Error("fail"));
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(Error);
  });

  it("ResultUtil.trySync 成功", () => {
    const r = ResultUtil.trySync(() => 42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it("ResultUtil.trySync 失败", () => {
    const r = ResultUtil.trySync(() => {
      throw new Error("boom");
    });
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe("boom");
  });

  it("ResultUtil.tryAsync 成功", async () => {
    const r = await ResultUtil.tryAsync(async () => 42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it("ResultUtil.tryAsync 失败", async () => {
    const r = await ResultUtil.tryAsync(async () => {
      throw new Error("async fail");
    });
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe("async fail");
  });

  it("ResultUtil.map 对 Ok 变换", () => {
    const r = ResultUtil.map(Ok(5), (v) => v * 2);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(10);
  });

  it("ResultUtil.map 对 Err 透传", () => {
    const r = ResultUtil.map(Err("bad"), (v: number) => v * 2);
    expect(r.ok).toBe(false);
  });

  it("ResultUtil.flatMap 对 Ok 变换并展平", () => {
    const r = ResultUtil.flatMap(Ok(5), (v) => Ok(v + 1));
    expect(r.ok).toBe(true);
    expect(r.value).toBe(6);
  });

  it("ResultUtil.unwrapOr 对 Ok 返回值", () => {
    expect(ResultUtil.unwrapOr(Ok(42), 0)).toBe(42);
  });

  it("ResultUtil.unwrapOr 对 Err 返回默认值", () => {
    expect(ResultUtil.unwrapOr(Err("bad"), 99)).toBe(99);
  });

  it("ResultUtil.isOk 类型守卫", () => {
    const r: Result<number, Error> = Ok(42);
    if (ResultUtil.isOk(r)) {
      expect(r.value).toBe(42);
    }
  });

  it("ResultUtil.isErr 类型守卫", () => {
    const r: Result<number, Error> = Err(new Error("x"));
    if (ResultUtil.isErr(r)) {
      expect(r.error.message).toBe("x");
    }
  });
});
