// struct-app - Electron 主进程（重接为直接驱动 @struct/context 上下文引擎）
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
// electron-updater 作为可选依赖，打包后自动更新用；开发阶段动态 import 避免硬依赖
interface AppUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}
let autoUpdater: AppUpdater | null = null;
async function loadAutoUpdater(): Promise<AppUpdater | null> {
  if (autoUpdater) return autoUpdater;
  try {
    const mod = await import("electron-updater");
    autoUpdater = mod.autoUpdater as AppUpdater;
    return autoUpdater;
  } catch {
    return null;
  }
}
import { ContextManager, TOTAL_BUDGET, BudgetManager, type TaskContext } from "@struct/context";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const SYSTEM_PROMPT =
  "你是 StructAgent 上下文引擎控制台。本界面用于可视化与驱动注意力管理" +
  "（focus / forget / reflect / 自动接管 / 任务相关性驱逐 / 注意力审计）。";

let win: BrowserWindow | null = null;
let manager: ContextManager | null = null;

// ─── 上下文引擎实例 ───────────────────────────────────────

async function getManager(): Promise<ContextManager> {
  if (!manager) {
    manager = new ContextManager({ maxWindow: TOTAL_BUDGET });
  }
  return manager;
}

// ─── 窗口创建 ──────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: "#0B1120",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const htmlPath = isDev
    ? path.join(__dirname, "..", "src", "ui", "index.html")
    : path.join(__dirname, "ui", "index.html");

  win.loadFile(htmlPath);
  win.on("closed", () => { win = null; });
}

// ─── 窗口控制 IPC ──────────────────────────────────────

ipcMain.handle("window:minimize", () => win?.minimize());
ipcMain.handle("window:maximize", () => {
  if (win?.isMaximized()) win?.unmaximize(); else win?.maximize();
});
ipcMain.handle("window:close", () => win?.close());
ipcMain.handle("window:isMaximized", () => win?.isMaximized());

// ─── 上下文引擎 IPC ────────────────────────────────────

function serializeEntries(m: ContextManager) {
  // 通过 toMessages 顺序拿条目，附上可读字段
  const msgs = m.toMessages(SYSTEM_PROMPT);
  return msgs.map((msg, i) => ({
    index: i,
    role: msg.role,
    content: (msg.content ?? "").slice(0, 240),
    tokens: BudgetManager.estimateTokens(msg.content ?? ""),
  }));
}

ipcMain.handle("ctx:init", async () => {
  const m = await getManager();
  return m.getReflection();
});

ipcMain.handle("ctx:loadTask", async (_event, task: string) => {
  const m = await getManager();
  if (typeof task === "string" && task.trim().length > 0) {
    const content = task.trim().slice(0, 2000);
    m.appendUser(content);
    // 任务启动时检索相关记忆（将原文 + 关键词交给分词召回）
    const keywords = content
      .replace(/[，。！？、\n]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && w.length <= 10)
      .slice(0, 8);
    const hits = await m.recall([content.slice(0, 200), ...keywords].join(" "), 5);
    if (hits.length > 0) {
      const lines = hits.map((h, i) => `${i + 1}. [${h.kind}] ${h.content}`).join("\n");
      m.appendUser(`## 🔍 自动召回的相关记忆（${hits.length} 条）\n${lines}\n\n---`);
    }
  }
  return m.getReflection();
});

ipcMain.handle("ctx:focus", async (_event, filePath: string) => {
  const m = await getManager();
  return m.focusFile(String(filePath));
});

ipcMain.handle("ctx:forget", async (_event, filePath: string) => {
  const m = await getManager();
  return { removed: m.forgetFile(String(filePath)) };
});

ipcMain.handle("ctx:reflect", async () => {
  const m = await getManager();
  return m.getReflection();
});

ipcMain.handle("ctx:autoManage", async (_event, taskContext?: TaskContext) => {
  const m = await getManager();
  if (taskContext) m.setTaskContext(taskContext);
  const report = await m.autoManage();
  return { report, reflect: m.getReflection() };
});

ipcMain.handle("ctx:appendTool", async (_event, _toolCallId: string, content: string, _importance?: string, file?: string) => {
  const m = await getManager();
  m.appendToolResult(String(content), { source: file ? String(file) : undefined, sourceType: "tool_output" });
  return m.getReflection();
});

ipcMain.handle("ctx:appendMessage", async (_event, role: string, content: string) => {
  const m = await getManager();
  const text = String(content);
  if (role === "assistant") {
    m.appendAssistant(text);
    // 自动 remember：检测 LLM 回复中的决策信号
    await m.rememberFromContent(text);
  } else {
    m.appendUser(text);
  }
  return m.getReflection();
});

ipcMain.handle("ctx:setTaskContext", async (_event, taskContext: TaskContext) => {
  const m = await getManager();
  m.setTaskContext(taskContext ?? null);
  return { ok: true };
});

ipcMain.handle("ctx:getEntries", async () => {
  const m = await getManager();
  return serializeEntries(m);
});

ipcMain.handle("ctx:getLog", async () => {
  const m = await getManager();
  return m.getAllEntries().map((e) => ({
    id: e.id,
    type: e.type,
    source: e.source,
    evicted: e.evicted,
    tokens: e.tokenCount,
    taskRelevance: e.taskRelevance,
  }));
});

ipcMain.handle("ctx:reset", async () => {
  manager = new ContextManager({ maxWindow: TOTAL_BUDGET });
  return manager.getReflection();
});

// ─── 自动更新（electron-updater）─────────────────────────

async function setupAutoUpdater(): Promise<void> {
  if (!app.isPackaged) return;
  const updater = await loadAutoUpdater();
  if (!updater) return;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("checking-for-update", () => win?.webContents.send("updater:status", { type: "checking" }));
  updater.on("update-available", (info: { version: string; releaseNotes: unknown }) => {
    win?.webContents.send("updater:status", { type: "available", version: info.version, releaseNotes: info.releaseNotes });
  });
  updater.on("update-not-available", (info: { version: string }) => {
    win?.webContents.send("updater:status", { type: "not-available", version: info.version });
  });
  updater.on("download-progress", (p: { percent: number }) => {
    win?.webContents.send("updater:status", { type: "progress", percent: p.percent });
  });
  updater.on("update-downloaded", (info: { version: string }) => {
    win?.webContents.send("updater:status", { type: "downloaded", version: info.version });
  });
  updater.on("error", (err: Error) => {
    win?.webContents.send("updater:status", { type: "error", message: err.message });
  });
  setTimeout(() => { updater.checkForUpdates().catch(() => {}); }, 3000);
}

ipcMain.handle("updater:check", async () => {
  if (!app.isPackaged) return { available: false, reason: "dev" };
  const updater = await loadAutoUpdater();
  if (!updater) return { available: false, reason: "electron-updater not installed" };
  try {
    await updater.checkForUpdates();
    return { available: true };
  } catch (err) {
    return { available: false, error: String(err) };
  }
});

ipcMain.handle("updater:quitAndInstall", async () => {
  const updater = await loadAutoUpdater();
  updater?.quitAndInstall();
});

// ─── 启动 ──────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  manager = null;
  if (process.platform !== "darwin") app.quit();
});
