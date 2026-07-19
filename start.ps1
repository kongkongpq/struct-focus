# Struct Agent 一键启动脚本
# 用法：双击 start.bat 或在终端运行 .\start.bat

Set-Location "E:\Develop\SrcuctAgent"

Write-Host "[1/2] Building TypeScript..." -ForegroundColor Cyan
npx tsc -b
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[2/2] Launching Electron..." -ForegroundColor Green
node "packages/app/node_modules/electron/cli.js" "packages/app/dist/main.js"
