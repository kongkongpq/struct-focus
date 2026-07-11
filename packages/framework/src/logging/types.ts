// @struct/framework - 日志接口

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  setLevel(level: LogLevel): void;
  child(prefix: string): ILogger;
}

/** 控制台日志实现（测试中可设 silent 静音） */
export class ConsoleLogger implements ILogger {
  private level: LogLevel;
  private readonly prefix: string;
  private static readonly order: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
  };

  constructor(prefix = "struct", level: LogLevel = "info") {
    this.prefix = prefix;
    this.level = level;
  }

  private shouldLog(target: LogLevel): boolean {
    return ConsoleLogger.order[this.level] <= ConsoleLogger.order[target];
  }

  private format(msg: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return `[${ts}] [${this.prefix}] ${msg}${metaStr}`;
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) console.debug(this.format(msg, meta));
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("info")) console.info(this.format(msg, meta));
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) console.warn(this.format(msg, meta));
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog("error")) console.error(this.format(msg, meta));
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(prefix: string): ILogger {
    return new ConsoleLogger(`${this.prefix}:${prefix}`, this.level);
  }
}

/** 空日志（测试用，不产生输出） */
export class NullLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  setLevel(): void {}
  child(): ILogger {
    return this;
  }
}
