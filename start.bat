@echo off
title Office Ball Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\ws" (
  echo Installing dependencies ^(first run only^)...
  call npm install --no-fund --no-audit
)
node server.js --open
pause
