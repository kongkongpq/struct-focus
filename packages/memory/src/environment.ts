// @struct/memory - 环境打包（项目记忆 layer）

import type { EnvironmentPackage, EnvironmentLayer } from "@struct/framework";
import { createId, now } from "@struct/framework";
import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";

/**
 * 环境打包：类 Docker layer 的分层项目理解。
 * - recordEnvironment: 扫描项目结构，生成环境包
 * - getEnvironment: 获取环境包
 * - 与 ONBOARDING.md 互补
 */
export class EnvironmentManager {
  private pkg: EnvironmentPackage | null = null;
  private readonly storagePath: string;

  constructor(storageDir: string) {
    this.storagePath = path.join(storageDir, "environment.json");
  }

  async init(): Promise<void> {
    try {
      const content = await fs.readFile(this.storagePath, "utf-8");
      this.pkg = JSON.parse(content);
    } catch {
      // 无环境包
    }
  }

  /** 扫描项目结构，生成环境包（启发式，不调 LLM） */
  async recordEnvironment(
    projectName: string,
    rootPath: string,
  ): Promise<EnvironmentPackage> {
    const layers: EnvironmentLayer[] = [];

    // 扫描目录结构
    const scanDir = async (dir: string, prefix: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const subdirs = entries.filter((e: Dirent) => e.isDirectory());
        const files = entries.filter((e: Dirent) => e.isFile());

        // 启发式：检测目录特征
        const hasPackageJson = files.some((f: Dirent) => f.name === "package.json");
        const hasTests = subdirs.some((d: Dirent) => d.name === "tests" || d.name === "__tests__");
        const hasSrc = subdirs.some((d: Dirent) => d.name === "src");

        if (hasPackageJson || hasSrc) {
          const keyPatterns: string[] = [];
          if (hasPackageJson) keyPatterns.push("package.json");
          if (hasSrc) keyPatterns.push("src/");
          if (hasTests) keyPatterns.push("tests/");

          layers.push({
            name: `layer_${prefix || "root"}`.replace(/[/\\]/g, "_"),
            description: `${prefix || "root"} 目录`,
            files: files.slice(0, 20).map((f: Dirent) => path.join(prefix, f.name)),
            keyPatterns,
          });
        }

        // 递归扫描（限制深度）
        if (prefix.split(/[/\\]/).length < 3) {
          for (const subdir of subdirs.slice(0, 20)) {
            if (subdir.name === "node_modules" || subdir.name === ".git") continue;
            await scanDir(path.join(dir, subdir.name), path.join(prefix, subdir.name));
          }
        }
      } catch {
        // 跳过无法访问的目录
      }
    };

    await scanDir(rootPath, "");

    // 读取 ONBOARDING.md
    let onboarding = "";
    try {
      onboarding = await fs.readFile(path.join(rootPath, "ONBOARDING.md"), "utf-8");
    } catch {
      // 无 ONBOARDING
    }

    this.pkg = {
      id: createId<"env">("env"),
      projectName,
      rootPath,
      layers,
      onboarding,
      timestamp: now(),
    };

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(this.pkg, null, 2), "utf-8");

    return this.pkg;
  }

  getEnvironment(): EnvironmentPackage | null {
    return this.pkg;
  }
}
