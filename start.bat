@echo off
chcp 65001 >nul 2>&1
cd /d "E:\Develop\SrcuctAgent"

echo [1/2] Building TypeScript...
call npx tsc -b
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo [2/2] Launching Electron...
node "packages/app/node_modules/electron/cli.js" "packages/app/dist/main.js"
