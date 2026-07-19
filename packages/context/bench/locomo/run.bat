@echo off
set LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
set LLM_MODEL=glm-4-flash
echo Running LoCoMo benchmark...
npx tsx run.ts
