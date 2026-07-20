// @structfocus/harness - L5 输出后处理：脱敏 + 结构化 + 异常检测

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string; name: string }[] = [
  { pattern: /(?:sk-|pk-|sk_live_|pk_live_)[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED_API_KEY]", name: "API_KEY" },
  { pattern: /sk-[a-zA-Z0-9]{48}/g, replacement: "[REDACTED_OPENAI_KEY]", name: "OPENAI_KEY" },
  { pattern: /AKIA[A-Z0-9]{16}/g, replacement: "[REDACTED_AWS_KEY]", name: "AWS_KEY" },
  { pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, replacement: "Bearer [REDACTED_TOKEN]", name: "BEARER_TOKEN" },
  { pattern: /(?:password|passwd|secret|token|api_key|apikey|access_key|private_key)\s*[=:]\s*["']?[^\s"']{8,}["']?/gi, replacement: "$1=[REDACTED]", name: "GENERIC_SECRET" },
  { pattern: /(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^\s"']+:[^\s"']+@/gi, replacement: "[REDACTED_CONNECTION_STRING]", name: "CONN_STRING" },
  { pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replacement: "[REDACTED_JWT]", name: "JWT" },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]", name: "PRIVATE_KEY" },
];

export interface SanitizeResult {
  readonly sanitized: string;
  readonly redactionCount: number;
  readonly redactedTypes: readonly string[];
}

/** 脱敏：密钥/Token 正则遮蔽（覆盖所有输出与记忆写入） */
export function sanitizeOutput(text: string): SanitizeResult {
  let result = text;
  let count = 0;
  const types = new Set<string>();

  for (const { pattern, replacement, name } of SECRET_PATTERNS) {
    const matches = result.match(pattern);
    if (matches) {
      count += matches.length;
      types.add(name);
      result = result.replace(pattern, replacement);
    }
  }

  return {
    sanitized: result,
    redactionCount: count,
    redactedTypes: Array.from(types),
  };
}

export interface AnomalySignal {
  readonly type: "crash" | "infinite-loop" | "oom" | "timeout" | "permission-denied";
  readonly message: string;
  readonly severity: "low" | "medium" | "high";
}

/** 异常检测：从输出中识别异常信号 */
export function detectAnomalies(output: string, exitCode: number): AnomalySignal[] {
  const signals: AnomalySignal[] = [];

  if (exitCode !== 0) {
    if (/Segmentation fault|SIGSEGV/i.test(output)) {
      signals.push({ type: "crash", message: "段错误", severity: "high" });
    }
    if (/Out of memory|OOM|heap/i.test(output)) {
      signals.push({ type: "oom", message: "内存不足", severity: "high" });
    }
    if (/ETIMEDOUT|timeout|timed out/i.test(output)) {
      signals.push({ type: "timeout", message: "超时", severity: "medium" });
    }
    if (/EACCES|permission denied/i.test(output)) {
      signals.push({ type: "permission-denied", message: "权限拒绝", severity: "medium" });
    }
  }

  // 无限循环检测（输出中大量重复行）
  const lines = output.split("\n").filter(Boolean);
  if (lines.length > 100) {
    const unique = new Set(lines);
    if (unique.size < lines.length * 0.1) {
      signals.push({ type: "infinite-loop", message: "输出高度重复，疑似死循环", severity: "high" });
    }
  }

  return signals;
}

/** 判断错误是否可重试 */
export function classifyError(
  stderr: string,
  exitCode: number,
): { retryable: boolean; reason: string } {
  // 可重试：网络超时 / 瞬时失败 / npm install 类
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|timeout|timed out/i.test(stderr)) {
    return { retryable: true, reason: "网络超时" };
  }
  if (/EAGAIN|EBUSY|EPIPE|temporary|transient/i.test(stderr)) {
    return { retryable: true, reason: "瞬时错误" };
  }
  if (/npm install|pnpm install|yarn/i.test(stderr) && exitCode !== 0) {
    return { retryable: true, reason: "包安装失败" };
  }
  if (/RATE_LIMIT|429|too many requests/i.test(stderr)) {
    return { retryable: true, reason: "速率限制" };
  }

  // 不可重试：权限拒绝 / 文件不存在 / 语法错误
  if (/EACCES|permission denied/i.test(stderr)) {
    return { retryable: false, reason: "权限拒绝" };
  }
  if (/ENOENT|no such file|not found/i.test(stderr)) {
    return { retryable: false, reason: "文件不存在" };
  }
  if (/SyntaxError|TypeError|parse error/i.test(stderr)) {
    return { retryable: false, reason: "语法错误" };
  }

  return { retryable: false, reason: "未知错误" };
}
