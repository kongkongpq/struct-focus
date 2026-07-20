// @structfocus/framework - 类型地基：Branded ID / Result / Json / Timestamp

// ─── Branded ID ──────────────────────────────────────────────

/**
 * Branded type pattern: 附加唯一 brand 标记，防止不同 ID 类型混用。
 * `Id<"plugin">` 不能赋值给 `Id<"tool">`，编译期捕获。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Id<B extends string> = Brand<string, B>;

/**
 * 生成带前缀的唯一 ID，使用 globalThis.crypto（零 Node 依赖铁律）。
 * 格式: `{prefix}_{crypto.randomUUID()}`，如 `plug_a1b2c3d4-...`
 */
export function createId<B extends string>(prefix: string): Id<B> {
  const uuid = globalThis.crypto.randomUUID();
  return `${prefix}_${uuid}` as Id<B>;
}

// ─── Timestamp ───────────────────────────────────────────────

/** ISO 8601 时间戳字符串 */
export type Timestamp = Brand<string, "Timestamp">;

export function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

// ─── JSON 类型 ───────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ─── Result<T, E> 判别联合 ────────────────────────────────────

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value } as const;
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error } as const;
}

export const ResultUtil = {
  /** 安全包装：同步函数 → Result */
  trySync<T>(fn: () => T): Result<T, Error> {
    try {
      return Ok(fn());
    } catch (e) {
      return Err(e instanceof Error ? e : new Error(String(e)));
    }
  },

  /** 安全包装：异步函数 → Result */
  async tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
    try {
      return Ok(await fn());
    } catch (e) {
      return Err(e instanceof Error ? e : new Error(String(e)));
    }
  },

  /** map: 对 Ok 值变换，Err 透传 */
  map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
    return r.ok ? Ok(fn(r.value)) : r;
  },

  /** flatMap: 对 Ok 值变换并展平，Err 透传 */
  flatMap<T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> {
    return r.ok ? fn(r.value) : r;
  },

  /** 获取值或默认值 */
  unwrapOr<T, E>(r: Result<T, E>, defaultValue: T): T {
    return r.ok ? r.value : defaultValue;
  },

  /** 判断是否 Ok */
  isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
    return r.ok;
  },

  /** 判断是否 Err */
  isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
    return !r.ok;
  },
};
