// structfocus-agent - 死循环检测器

export interface LoopDetectorOptions {
  readonly maxSteps: number;
  readonly maxSameFileModifications: number;
  readonly maxSameToolCalls: number;
}

export const DEFAULT_LOOP_OPTIONS: LoopDetectorOptions = {
  maxSteps: 50,
  maxSameFileModifications: 3,
  maxSameToolCalls: 3,
};

export interface LoopDetectionResult {
  readonly detected: boolean;
  readonly reason?: string;
  readonly type?: "max-steps" | "same-file" | "same-tool" | "no-progress";
}

export class LoopDetector {
  private steps = 0;
  private fileModifications = new Map<string, number>();
  private toolCalls = new Map<string, number>();
  private readonly options: LoopDetectorOptions;

  constructor(options: Partial<LoopDetectorOptions> = {}) {
    this.options = { ...DEFAULT_LOOP_OPTIONS, ...options };
  }

  recordStep(): void { this.steps++; }

  recordFileModification(file: string): void {
    this.fileModifications.set(file, (this.fileModifications.get(file) ?? 0) + 1);
  }

  recordToolCall(tool: string, args: Record<string, unknown>): void {
    const key = `${tool}:${JSON.stringify(args)}`;
    this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
  }

  detect(testPassed?: boolean): LoopDetectionResult {
    if (this.steps >= this.options.maxSteps) return { detected: true, reason: `达到步数上限 ${this.options.maxSteps}`, type: "max-steps" };
    for (const [file, count] of this.fileModifications) {
      if (count >= this.options.maxSameFileModifications && testPassed === false) return { detected: true, reason: `文件 ${file} 连续修改 ${count} 次且测试仍失败`, type: "same-file" };
    }
    for (const [key, count] of this.toolCalls) {
      if (count >= this.options.maxSameToolCalls) return { detected: true, reason: `工具调用重复 ${count} 次: ${key}`, type: "same-tool" };
    }
    return { detected: false };
  }

  getSteps(): number { return this.steps; }
  reset(): void { this.steps = 0; this.fileModifications.clear(); this.toolCalls.clear(); }
}
