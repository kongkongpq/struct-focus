// @structfocus/context - CodeExplorer（文件树 + 正则符号扫描）

import * as fs from "node:fs";
import * as path from "node:path";

export interface FileInfo {
  readonly path: string;
  readonly name: string;
  readonly ext: string;
  readonly isDirectory: boolean;
  readonly size?: number;
}

export interface SymbolInfo {
  readonly file: string;
  readonly line: number;
  readonly type: "function" | "class" | "const" | "import" | "export";
  readonly name: string;
}

/**
 * CodeExplorer：文件树 + 符号扫描（零外部依赖，用正则替代 tree-sitter）。
 * - listFiles: 遍历文件树
 * - findRelevant: 按关键词/文件名模式查找相关文件
 * - extractSymbols: 正则提取函数/类/导出
 */
export class CodeExplorer {
  private readonly fs: typeof import("node:fs").promises;
  private readonly path: typeof import("node:path");

  constructor() {
    this.fs = fs.promises;
    this.path = path;
  }

  /** 列出文件树（排除 node_modules/dist/.git） */
  async listFiles(rootDir: string, opts?: { maxDepth?: number; includeExt?: string[] }): Promise<FileInfo[]> {
    const maxDepth = opts?.maxDepth ?? 5;
    const results: FileInfo[] = [];

    const walk = async (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      try {
        const entries = await this.fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
          const fullPath = this.path.join(dir, entry.name);
          if (entry.isDirectory()) {
            results.push({ path: fullPath, name: entry.name, ext: "", isDirectory: true });
            await walk(fullPath, depth + 1);
          } else {
            const ext = this.path.extname(entry.name);
            if (opts?.includeExt && !opts.includeExt.includes(ext)) continue;
            results.push({ path: fullPath, name: entry.name, ext, isDirectory: false });
          }
        }
      } catch { /* skip */ }
    };

    await walk(rootDir, 0);
    return results;
  }

  /** 按关键词查找相关文件 */
  async findRelevant(rootDir: string, keywords: string[]): Promise<FileInfo[]> {
    const allFiles = await this.listFiles(rootDir);
    const scored: { file: FileInfo; score: number }[] = [];

    for (const file of allFiles) {
      if (file.isDirectory) continue;
      let score = 0;
      for (const kw of keywords) {
        const lower = kw.toLowerCase();
        if (file.name.toLowerCase().includes(lower)) score += 3;
        if (file.path.toLowerCase().includes(lower)) score += 1;
      }
      // 常见代码文件加权
      if ([".ts", ".js", ".tsx", ".jsx"].includes(file.ext)) score += 1;
      if (file.name === "index.ts" || file.name === "index.js") score += 2;

      if (score > 0) scored.push({ file, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map((s) => s.file);
  }

  /** 提取文件中的符号（正则模拟 tree-sitter） */
  async extractSymbols(filePath: string): Promise<SymbolInfo[]> {
    try {
      const content = await this.fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const symbols: SymbolInfo[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // function
        const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (fnMatch) {
          symbols.push({ file: filePath, line: i + 1, type: "function", name: fnMatch[1]! });
        }
        // class
        const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
        if (classMatch) {
          symbols.push({ file: filePath, line: i + 1, type: "class", name: classMatch[1]! });
        }
        // const/let/var
        const constMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)/);
        if (constMatch) {
          symbols.push({ file: filePath, line: i + 1, type: "const", name: constMatch[1]! });
        }
        // import
        const importMatch = line.match(/import\s+.*from\s+["'](.+)["']/);
        if (importMatch) {
          symbols.push({ file: filePath, line: i + 1, type: "import", name: importMatch[1]! });
        }
      }

      return symbols;
    } catch {
      return [];
    }
  }

  /** 按符号名搜索 */
  async searchSymbol(rootDir: string, symbolName: string): Promise<SymbolInfo[]> {
    const files = await this.listFiles(rootDir, { includeExt: [".ts", ".js", ".tsx", ".jsx"] });
    const results: SymbolInfo[] = [];

    for (const file of files) {
      if (file.isDirectory) continue;
      const symbols = await this.extractSymbols(file.path);
      for (const sym of symbols) {
        if (sym.name.toLowerCase().includes(symbolName.toLowerCase())) {
          results.push(sym);
        }
      }
    }

    return results;
  }
}
