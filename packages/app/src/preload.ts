// struct-app - Preload（安全的 IPC 桥接，直接驱动 @struct/context 引擎）
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("contextAPI", {
  // 引擎生命周期
  init: (): Promise<unknown> => ipcRenderer.invoke("ctx:init"),
  loadTask: (task: string): Promise<unknown> => ipcRenderer.invoke("ctx:loadTask", task),
  reset: (): Promise<unknown> => ipcRenderer.invoke("ctx:reset"),

  // 六原语 / 主动管理
  focus: (filePath: string, scope?: string): Promise<unknown> =>
    ipcRenderer.invoke("ctx:focus", filePath, scope),
  forget: (filePath: string): Promise<unknown> => ipcRenderer.invoke("ctx:forget", filePath),
  reflect: (): Promise<unknown> => ipcRenderer.invoke("ctx:reflect"),
  autoManage: (taskContext?: unknown): Promise<unknown> => ipcRenderer.invoke("ctx:autoManage", taskContext),

  // 数据注入（演示 / 驱动）
  appendTool: (toolCallId: string, content: string, importance?: string, file?: string): Promise<unknown> =>
    ipcRenderer.invoke("ctx:appendTool", toolCallId, content, importance, file),
  appendMessage: (role: string, content: string): Promise<unknown> =>
    ipcRenderer.invoke("ctx:appendMessage", role, content),
  setTaskContext: (taskContext: unknown): Promise<unknown> => ipcRenderer.invoke("ctx:setTaskContext", taskContext),

  // 可视化数据
  getEntries: (): Promise<unknown> => ipcRenderer.invoke("ctx:getEntries"),
  getLog: (): Promise<unknown> => ipcRenderer.invoke("ctx:getLog"),

  // 窗口控制
  minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  maximize: (): Promise<void> => ipcRenderer.invoke("window:maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),

  // 自动更新
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("updater:check"),
});
