// @struct/memory - ONBOARDING.md 扫描与启发式生成

import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * ONBOARDING 管理：
 * - 扫描已有 ONBOARDING.md
 * - 启发式生成（仅基于文件树/package.json/目录结构，不调 LLM）
 * - 首版可能 ~80% 噪声，由代码验证机制兜底
 */
export class OnboardingManager {
  private readonly rootPath: string;
  private content: string | null = null;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async init(): Promise<void> {
    this.content = await this.scan();
  }

  /** 扫描已有 ONBOARDING.md */
  async scan(): Promise<string | null> {
    try {
      const filePath = path.join(this.rootPath, "ONBOARDING.md");
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  getOnboarding(): string | null {
    return this.content;
  }

  /** 启发式生成 ONBOARDING（不调 LLM） */
  async generateOnboarding(): Promise<string> {
    const lines: string[] = ["# ONBOARDING", ""];

    // 读取 package.json
    try {
      const pkgPath = path.join(this.rootPath, "package.json");
      const pkgContent = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgContent);

      lines.push("## 项目信息", "");
      lines.push(`- **名称**: ${pkg.name ?? "unknown"}`);
      lines.push(`- **版本**: ${pkg.version ?? "unknown"}`);
      if (pkg.description) {
        lines.push(`- **描述**: ${pkg.description}`);
      }
      if (pkg.scripts && typeof pkg.scripts === "object") {
        lines.push("", "## 脚本", "");
        for (const [name, script] of Object.entries(pkg.scripts)) {
          lines.push(`- \`npm run ${name}\`: ${script}`);
        }
      }
      if (pkg.dependencies && typeof pkg.dependencies === "object") {
        lines.push("", "## 依赖", "");
        for (const dep of Object.keys(pkg.dependencies)) {
          lines.push(`- ${dep}`);
        }
      }
    } catch {
      lines.push("## 项目信息", "");
      lines.push("- 无 package.json");
    }

    // 扫描目录结构（一级）
    lines.push("", "## 目录结构", "");
    try {
      const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const type = entry.isDirectory() ? "📁" : "📄";
        lines.push(`- ${type} ${entry.name}`);
      }
    } catch {
      lines.push("- 无法扫描目录");
    }

    // 检测关键文件
    lines.push("", "## 关键文件检测", "");
    const keyFiles = [
      "tsconfig.json",
      "pnpm-workspace.yaml",
      "vitest.workspace.ts",
      ".gitignore",
      "README.md",
    ];
    for (const file of keyFiles) {
      try {
        await fs.access(path.join(this.rootPath, file));
        lines.push(`- ✅ ${file}`);
      } catch {
        // 不存在
      }
    }

    lines.push("", "## 注意事项", "");
    lines.push("> ⚠️ 本 ONBOARDING 由启发式自动生成，可能含噪声，请以代码验证为准。");

    const content = lines.join("\n");
    this.content = content;
    return content;
  }

  /** 写入 ONBOARDING.md */
  async save(): Promise<void> {
    if (this.content) {
      await fs.writeFile(
        path.join(this.rootPath, "ONBOARDING.md"),
        this.content,
        "utf-8",
      );
    }
  }
}
