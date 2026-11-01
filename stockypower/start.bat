@echo off
setlocal
cd /d "%~dp0"
title Stockypower

if not exist node_modules (
  echo First run: installing packages...
  call npm install --no-fund --no-audit
  if errorlevel 1 goto fail
)
if not exist .env (
  echo No .env file yet. Double-click setup.bat first.
  pause
  exit /b 1
)

echo Starting Stockypower at http://localhost:8790
echo Keep this window open while you use it. Close it to stop Stockypower.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8790"
node server.mjs
pause
exit /b 0

:fail
pause
exit /b 1
