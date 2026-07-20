// @structfocus/harness - 进程执行器

import { spawn, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { IExecutor, IProcess, ExecResult, ExecOpts } from "@structfocus/framework";

const _execAsync = promisify(execSync);

/**
 * ProcessExecutor：实现 IExecutor。
 * - exec: 执行命令并等待结果
 * - spawn: 启动进程并返回 IProcess
 * - kill: 终止单进程
 * - killTree: 递归 kill 进程树（叶子→根）
 * - 支持 timeout + 输出截断 + AbortSignal
 */
export class ProcessExecutor implements IExecutor {
  async exec(command: string, args: string[], opts: ExecOpts): Promise<ExecResult> {
    const start = Date.now();
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    const maxBytes = opts.maxOutputBytes ?? 1024 * 1024;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (Buffer.concat(stdoutChunks).length > maxBytes) {
        child.kill("SIGTERM");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    if (opts.stdin) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    // timeout
    const timer = opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;

    // AbortSignal
    const onAbort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    return new Promise<ExecResult>((resolve) => {
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        opts.abortSignal?.removeEventListener("abort", onAbort);

        stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        stderr = Buffer.concat(stderrChunks).toString("utf-8");

        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: Date.now() - start,
          timedOut,
          killed,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        opts.abortSignal?.removeEventListener("abort", onAbort);

        resolve({
          stdout: "",
          stderr: err.message,
          exitCode: -1,
          durationMs: Date.now() - start,
          timedOut,
          killed,
        });
      });
    });
  }

  spawn(command: string, args: string[], opts: ExecOpts): IProcess {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => {
      exitCode = code;
    });

    return {
      pid: child.pid ?? -1,
      get stdout() { return stdout; },
      get stderr() { return stderr; },
      get exitCode() { return exitCode; },
      get killed() { return child.killed; },
      kill: (signal?: string) => child.kill(signal as any),
    };
  }

  kill(pid: number, signal?: string): boolean {
    try {
      process.kill(pid, (signal ?? "SIGTERM") as any);
      return true;
    } catch {
      return false;
    }
  }

  /** 递归 kill 进程树（叶子→根反向 kill，100ms 轮询） */
  async killTree(pid: number, signal?: string): Promise<void> {
    const sig = signal ?? "SIGTERM";
    const children = this.findChildren(pid);

    // 叶子→根反向 kill
    for (const childPid of children.reverse()) {
      this.kill(childPid, sig);
    }
    this.kill(pid, sig);

    // 100ms 轮询确认
    await new Promise((r) => setTimeout(r, 100));

    // 确认终止，必要时 SIGKILL
    if (this.isAlive(pid)) {
      this.kill(pid, "SIGKILL");
    }
    for (const childPid of children) {
      if (this.isAlive(childPid)) {
        this.kill(childPid, "SIGKILL");
      }
    }
  }

  /** 查找子进程（跨平台） */
  private findChildren(pid: number): number[] {
    try {
      if (process.platform === "win32") {
        // Windows: wmic 查找子进程
        const output = execSync(
          `wmic process where "ParentProcessId=${pid}" get ProcessId`,
          { encoding: "utf-8", timeout: 5000 },
        );
        return output
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && l !== "ProcessId" && /^\d+$/.test(l))
          .map(Number);
      } else {
        // POSIX: pgrep -P
        const output = execSync(`pgrep -P ${pid}`, {
          encoding: "utf-8",
          timeout: 5000,
        });
        return output
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map(Number);
      }
    } catch {
      return [];
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
