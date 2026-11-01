@echo off
chcp 65001 >nul
title GitPorter - 项目搬运工
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没有找到 Node.js
  echo       请先安装 Node.js ^(https://nodejs.org^)，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没有找到 Git
  echo       请先安装 Git ^(https://git-scm.com/download/win^)，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

node server.js

echo.
echo 服务已停止。
pause
