@echo off
setlocal

rem ====================================================================
rem  OPTIONAL: put your keys between the = and the closing quote below,
rem  save this file, then double-click it. Example:
rem      set "ANTHROPIC_KEY=sk-ant-api03-AbCd..."
rem  Leave them empty to be asked for the keys instead.
rem  Do not share this file once your keys are in it.
rem ====================================================================
set "ANTHROPIC_KEY="
set "MASSIVE_KEY="
rem ====================================================================

set "STOCKYPOWER_ANTHROPIC_KEY=%ANTHROPIC_KEY%"
set "STOCKYPOWER_MASSIVE_KEY=%MASSIVE_KEY%"
cd /d "%~dp0"
title Stockypower setup

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Opening https://nodejs.org - install the LTS version, then double-click setup.bat again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

echo Installing packages...
call npm install --no-fund --no-audit
if errorlevel 1 goto fail

node scripts\setup.mjs
if errorlevel 1 goto fail

echo.
echo Starting Stockypower at http://localhost:8790
echo Keep this window open while you use it. Close it to stop Stockypower.
echo Next time, just double-click start.bat.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8790"
node server.mjs
pause
exit /b 0

:fail
echo.
echo Setup did not finish. Read the message above, then double-click setup.bat to try again.
pause
exit /b 1
