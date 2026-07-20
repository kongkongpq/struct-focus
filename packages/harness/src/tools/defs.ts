// @structfocus/harness - 33 个工具定义

import type { ToolDef } from "@structfocus/framework";

export const FS_TOOLS: readonly ToolDef[] = [
  { name: "file_read", description: "读取文件内容", category: "fs", params: [{ name: "path", type: "string", description: "文件路径", required: true }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "file_write", description: "写入文件（覆盖）", category: "fs", params: [{ name: "path", type: "string", description: "文件路径", required: true }, { name: "content", type: "string", description: "文件内容", required: true }], risk: "medium", disableable: true, enabledByDefault: true },
  { name: "file_edit", description: "编辑文件（字符串替换）", category: "fs", params: [{ name: "path", type: "string", description: "文件路径", required: true }, { name: "old_str", type: "string", description: "旧字符串", required: true }, { name: "new_str", type: "string", description: "新字符串", required: true }], risk: "medium", disableable: true, enabledByDefault: true },
  { name: "file_append", description: "追加内容到文件", category: "fs", params: [{ name: "path", type: "string", description: "文件路径", required: true }, { name: "content", type: "string", description: "追加内容", required: true }], risk: "low", disableable: true, enabledByDefault: true },
  { name: "file_delete", description: "删除文件", category: "fs", params: [{ name: "path", type: "string", description: "文件路径", required: true }], risk: "high", disableable: true, enabledByDefault: false },
  { name: "file_list", description: "列出目录内容", category: "fs", params: [{ name: "path", type: "string", description: "目录路径", required: true }, { name: "recursive", type: "boolean", description: "是否递归", required: false }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "file_mkdir", description: "创建目录", category: "fs", params: [{ name: "path", type: "string", description: "目录路径", required: true }, { name: "recursive", type: "boolean", description: "递归创建", required: false }], risk: "low", disableable: true, enabledByDefault: true },
  { name: "file_search", description: "在文件中搜索文本", category: "fs", params: [{ name: "pattern", type: "string", description: "搜索模式", required: true }, { name: "path", type: "string", description: "搜索路径", required: false }], risk: "safe", disableable: false, enabledByDefault: true },
];

export const SHELL_TOOLS: readonly ToolDef[] = [
  { name: "shell_exec", description: "执行 shell 命令", category: "shell", params: [{ name: "command", type: "string", description: "命令", required: true }, { name: "cwd", type: "string", description: "工作目录", required: false }, { name: "timeout", type: "number", description: "超时(ms)", required: false }], risk: "high", disableable: true, enabledByDefault: true },
  { name: "shell_npm", description: "执行 npm 命令", category: "shell", params: [{ name: "args", type: "string", description: "npm 参数", required: true }], risk: "medium", disableable: true, enabledByDefault: true },
  { name: "shell_pnpm", description: "执行 pnpm 命令", category: "shell", params: [{ name: "args", type: "string", description: "pnpm 参数", required: true }], risk: "medium", disableable: true, enabledByDefault: true },
  { name: "shell_kill", description: "终止进程", category: "shell", params: [{ name: "pid", type: "number", description: "进程 ID", required: true }], risk: "critical", disableable: true, enabledByDefault: false },
];

export const GIT_TOOLS: readonly ToolDef[] = [
  { name: "git_status", description: "Git 状态", category: "git", params: [{ name: "cwd", type: "string", description: "工作目录", required: false }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "git_diff", description: "Git diff", category: "git", params: [{ name: "cwd", type: "string", description: "工作目录", required: false }, { name: "file", type: "string", description: "文件", required: false }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "git_commit", description: "Git 提交", category: "git", params: [{ name: "message", type: "string", description: "提交信息", required: true }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "medium", disableable: true, enabledByDefault: true },
  { name: "git_add", description: "Git 添加", category: "git", params: [{ name: "files", type: "string", description: "文件", required: true }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "low", disableable: true, enabledByDefault: true },
  { name: "git_log", description: "Git 日志", category: "git", params: [{ name: "limit", type: "number", description: "条数", required: false }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "git_push", description: "Git 推送", category: "git", params: [{ name: "remote", type: "string", description: "远程名", required: false }, { name: "branch", type: "string", description: "分支名", required: false }, { name: "force", type: "boolean", description: "强制推送", required: false }], risk: "critical", disableable: true, enabledByDefault: false },
];

export const ANALYSIS_TOOLS: readonly ToolDef[] = [
  { name: "code_search", description: "代码搜索（正则）", category: "analysis", params: [{ name: "pattern", type: "string", description: "正则模式", required: true }, { name: "path", type: "string", description: "路径", required: false }, { name: "glob", type: "string", description: "文件 glob", required: false }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "code_symbols", description: "提取代码符号", category: "analysis", params: [{ name: "path", type: "string", description: "文件路径", required: true }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "code_dependencies", description: "分析依赖关系", category: "analysis", params: [{ name: "path", type: "string", description: "项目路径", required: true }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "code_structure", description: "分析项目结构", category: "analysis", params: [{ name: "path", type: "string", description: "项目路径", required: true }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "knowledge_query", description: "查询记忆/知识库（LLM Pull）", category: "analysis", params: [{ name: "query", type: "string", description: "查询内容", required: true }], risk: "safe", disableable: false, enabledByDefault: true },
];

export const PROJECT_STATUS_TOOLS: readonly ToolDef[] = [
  { name: "test_run", description: "运行测试", category: "verify", params: [{ name: "command", type: "string", description: "测试命令", required: false }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "low", disableable: false, enabledByDefault: true },
  { name: "lint_run", description: "运行 lint", category: "verify", params: [{ name: "command", type: "string", description: "lint 命令", required: false }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "low", disableable: false, enabledByDefault: true },
  { name: "typecheck_run", description: "运行类型检查", category: "verify", params: [{ name: "command", type: "string", description: "类型检查命令", required: false }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "low", disableable: false, enabledByDefault: true },
  { name: "build_run", description: "运行构建", category: "project", params: [{ name: "command", type: "string", description: "构建命令", required: false }, { name: "cwd", type: "string", description: "工作目录", required: false }], risk: "medium", disableable: true, enabledByDefault: true },
  { name: "project_init", description: "初始化项目", category: "project", params: [{ name: "path", type: "string", description: "项目路径", required: true }], risk: "medium", disableable: true, enabledByDefault: false },
  { name: "project_info", description: "获取项目信息", category: "project", params: [{ name: "path", type: "string", description: "项目路径", required: true }], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "status_budget", description: "查看预算使用情况", category: "status", params: [], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "status_progress", description: "查看当前进度", category: "status", params: [], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "status_memory", description: "查看记忆概况", category: "status", params: [], risk: "safe", disableable: false, enabledByDefault: true },
  { name: "status_health", description: "查看健康状态", category: "status", params: [], risk: "safe", disableable: false, enabledByDefault: true },
];

/** 全部 33 个工具 */
export const ALL_TOOLS: readonly ToolDef[] = [
  ...FS_TOOLS,      // 8
  ...SHELL_TOOLS,   // 4
  ...GIT_TOOLS,     // 6
  ...ANALYSIS_TOOLS, // 5
  ...PROJECT_STATUS_TOOLS, // 10
];

/** 工具名 → ToolDef 映射 */
export const TOOL_MAP: ReadonlyMap<string, ToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
