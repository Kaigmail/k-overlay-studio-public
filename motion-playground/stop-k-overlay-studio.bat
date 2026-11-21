@echo off
setlocal
chcp 65001 >nul
title K-Overlay-Studio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-k-overlay-studio.ps1"
set "exitCode=%errorlevel%"
echo.
pause
exit /b %exitCode%
