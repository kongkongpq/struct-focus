// @struct/framework - 生命周期状态机

export type LifecycleState =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "error";

/** 合法状态转移表 */
const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  idle: ["running"],
  running: ["paused", "stopping", "error"],
  paused: ["running", "stopping"],
  stopping: ["stopped"],
  stopped: ["idle"],
  error: ["idle"],
};

export interface StateChangeCallback {
  (from: LifecycleState, to: LifecycleState, reason?: string): void;
}

/**
 * 状态机：仅允许合法转移，非法转移抛错。
 * onChange 回调通知状态变化。
 */
export class StateMachine {
  private state: LifecycleState = "idle";
  private listeners = new Set<StateChangeCallback>();

  get current(): LifecycleState {
    return this.state;
  }

  canTransition(to: LifecycleState): boolean {
    return TRANSITIONS[this.state].includes(to);
  }

  transition(to: LifecycleState, reason?: string): void {
    if (!this.canTransition(to)) {
      throw new Error(
        `Invalid state transition: ${this.state} → ${to}` + (reason ? ` (${reason})` : ""),
      );
    }
    const from = this.state;
    this.state = to;
    const snapshot = Array.from(this.listeners);
    for (const cb of snapshot) {
      try {
        cb(from, to, reason);
      } catch {
        // listener 异常不影响状态机
      }
    }
  }

  onChange(cb: StateChangeCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  reset(): void {
    this.state = "idle";
  }
}
