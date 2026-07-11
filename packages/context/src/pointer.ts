// @struct/context - PointerRegistry（可逆指针注册表）

import type { ContextPointer, Importance, IMemoryProvider } from "@struct/framework";

export class PointerRegistry {
  private pointers = new Map<string, ContextPointer>();
  private expanded = new Set<string>();
  private memory: IMemoryProvider | null = null;

  setMemoryProvider(provider: IMemoryProvider): void { this.memory = provider; }
  register(pointer: ContextPointer): void { this.pointers.set(pointer.id, pointer); }
  registerBatch(pointers: readonly ContextPointer[]): void { for (const p of pointers) this.pointers.set(p.id, p); }
  get(id: string): ContextPointer | undefined { return this.pointers.get(id); }

  expand(id: string): string | null {
    const pointer = this.pointers.get(id);
    if (!pointer) return null;
    if (pointer.importance === "high") this.expanded.add(id);
    if (this.expanded.has(id)) {
      if (this.memory) return this.memory.expandPointer(id);
      return pointer.decision ?? pointer.topic;
    }
    return null;
  }

  markExpanded(id: string): void { this.expanded.add(id); }

  compress(id: string): void {
    const p = this.pointers.get(id);
    if (p && p.importance === "high") return;
    this.expanded.delete(id);
  }

  findByFile(file: string): ContextPointer[] {
    return this.getAll().filter((p) => p.files.some((f: string) => f === file || file.startsWith(f.replace("*", ""))));
  }

  deduplicate(): ContextPointer[] {
    const all = this.getAll();
    const merged: ContextPointer[] = [];
    const used = new Set<string>();
    for (const pointer of all) {
      if (used.has(pointer.id)) continue;
      const dups = all.filter((p) => {
        if (p.id === pointer.id || used.has(p.id)) return false;
        const overlap = pointer.files.filter((f) => p.files.includes(f));
        return overlap.length / Math.max(pointer.files.length, p.files.length, 1) > 0.5;
      });
      if (dups.length > 0) {
        const sorted = [pointer, ...dups].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        merged.push(sorted[0]!);
        for (const d of sorted) used.add(d.id);
      } else { merged.push(pointer); used.add(pointer.id); }
    }
    return merged;
  }

  getAll(): ContextPointer[] { return Array.from(this.pointers.values()); }
  getExpanded(): ContextPointer[] { return Array.from(this.expanded).map((id) => this.pointers.get(id)).filter((p): p is ContextPointer => p !== undefined); }
  getByImportance(level: Importance): ContextPointer[] { return this.getAll().filter((p) => p.importance === level); }
  clear(): void { this.pointers.clear(); this.expanded.clear(); }
}
