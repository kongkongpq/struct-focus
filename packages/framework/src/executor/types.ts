// @structfocus/framework - 执行器接口

export interface ExecOpts {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly abortSignal?: AbortSignal;
  readonly shell?: boolean;
}

export interface IProcess {
  readonly pid: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly killed: boolean;
  kill(signal?: string): boolean;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly killed: boolean;
}

/** 执行器接口：harness 的 ProcessExecutor 实现此接口 */
export interface IExecutor {
  exec(command: string, args: string[], opts: ExecOpts): Promise<ExecResult>;
  spawn(command: string, args: string[], opts: ExecOpts): IProcess;
  kill(pid: number, signal?: string): boolean;
  /** 递归 kill 进程树（叶子→根） */
  killTree(pid: number, signal?: string): Promise<void>;
}
