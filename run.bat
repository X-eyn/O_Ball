@echo off
title Office Ball Server (auto-restart)
cd /d "%~dp0"
:loop
echo.
echo   [%date% %time%] starting Office Ball...
node server.js
set CODE=%errorlevel%
echo.
echo   Server stopped (exit code %CODE%). Restarting in 3 seconds...
echo   Press Ctrl+C or close this window to stop.
ping 127.0.0.1 -n 4 >nul
goto loop
