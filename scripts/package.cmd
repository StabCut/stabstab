@echo off
REM ============================================================
REM StabStab捅捅 —— Windows 一键打包脚本
REM 在项目根目录执行（双击或命令行运行）。产物输出至 release\：
REM   1) StabStab捅捅-<版本>-x64-setup.exe     —— NSIS 安装包
REM   2) StabStab捅捅-<版本>-x64-portable.exe  —— 便携可执行文件
REM 使用说明见项目 README.md。
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0\.."

echo ==> 检查 Node.js 环境
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js ^>= 18（推荐 20+）。
  exit /b 1
)
node -v
npm -v

echo ==> 安装依赖（已存在则跳过）
if not exist "node_modules\electron" (
  call npm install --no-audit --no-fund
  if errorlevel 1 exit /b 1
) else (
  echo     node_modules 已存在，跳过安装
)

echo ==> 生成/更新 Logo（需要 ImageMagick，可跳过）
where magick >nul 2>nul
if %errorlevel%==0 (
  node scripts\gen-logo.js
) else (
  where convert >nul 2>nul
  if %errorlevel%==0 (
    node scripts\gen-logo.js
  ) else (
    echo     未检测到 ImageMagick，跳过 Logo 生成，沿用现有图标
  )
)

echo ==> 构建渲染进程（Vite）
call npm run build
if errorlevel 1 exit /b 1

echo ==> electron-builder 打包（nsis + portable）
call npx electron-builder --win nsis portable
if errorlevel 1 exit /b 1

echo.
echo ✅ 打包完成，产物位于 release\：
dir /b release\*.exe
endlocal
