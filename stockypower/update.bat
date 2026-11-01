@echo off
setlocal
cd /d "%~dp0"
title Stockypower update

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org first.
  pause
  exit /b 1
)

rem Downloads the latest Stockypower into THIS folder.
rem Your .env (keys) and setup.bat are kept as they are.
node scripts\update.mjs
if errorlevel 1 (
  echo.
  echo Update did not finish. Read the message above.
  pause
  exit /b 1
)

echo.
call start.bat
