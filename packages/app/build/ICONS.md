# 应用图标

打包配置引用 `build/icon`（即 `build/icon.png` / `icon.ico` / `icon.icns`）。
electron-builder 会自动从 `icon.png` 生成各平台所需的 `.ico` / `.icns`。

当前 `icon.png` 为 256×256 纯色占位图，**发布前请替换为正式图标**：

- 准备一张 ≥ 512×512 的 PNG（建议透明背景），覆盖 `build/icon.png`
- 如需 Windows 专属 `.ico` 或 macOS 专属 `.icns`，可另行放入 `build/icon.ico` / `build/icon.icns`
- 不提供时 electron-builder 会使用默认图标（不影响打包）

生成命令示例（占位图，仅开发用）：

```bash
node build/genicon.mjs   # 生成 256x256 纯色占位 icon.png
```
