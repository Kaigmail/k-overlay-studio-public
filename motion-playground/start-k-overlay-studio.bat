@echo off
setlocal
chcp 65001 >nul
title K-Overlay-Studio
cd /d "%~dp0" || exit /b 1

echo K-Overlay-Studio 启动中...
where npm >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js/npm。请先安装 Node.js: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次运行，安装依赖...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm run dev -- --open
if errorlevel 1 (
  pause
  exit /b 1
)
