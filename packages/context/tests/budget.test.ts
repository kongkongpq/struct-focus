import { describe, it, expect } from "vitest";
import {
  BudgetManager,
  MAX_CONTEXT_WINDOW,
  setTokenEstimator,
  hasTokenEstimator,
  setMaxContextWindow,
  getMaxContextWindow,
} from "@struct/context";

describe("BudgetManager", () => {
  it("估算非空文本返回正 token 数", () => {
    expect(BudgetManager.estimateTokens("hello world")).toBeGreaterThan(0);
    expect(BudgetManager.estimateTokens("")).toBe(0);
  });

  it("注入 tokenizer 后优先使用它，且保留字符启发式下限", () => {
    setTokenEstimator((t) => t.length); // 1 char = 1 token
    expect(hasTokenEstimator()).toBe(true);
    const est = BudgetManager.estimateTokens("abc");
    expect(est).toBe(3);
    setTokenEstimator(null);
    expect(hasTokenEstimator()).toBe(false);
  });

  it("窗口常量存在且可覆盖", () => {
    expect(MAX_CONTEXT_WINDOW).toBeGreaterThan(0);
    const prev = getMaxContextWindow();
    setMaxContextWindow(50000);
    expect(getMaxContextWindow()).toBe(50000);
    setMaxContextWindow(prev);
  });
});
