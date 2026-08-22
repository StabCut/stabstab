@echo off
REM ============================================================
REM StabStab - Windows one-click packaging script
REM Run from the project root (double-click or command line).
REM Artifacts are written to release\:
REM   1) StabStab-<version>-x64-setup.exe     - NSIS installer
REM   2) StabStab-<version>-x64-portable.exe  - portable executable
REM See README.md for usage.
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0\.."

echo ==^> Checking Node.js environment
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js ^>= 18 ^(20+ recommended^).
  exit /b 1
)
call node -v
call npm -v
echo ==^> Installing dependencies ^(skipped if already present^)
if not exist "node_modules\electron" (
  call npm install --no-audit --no-fund
  if errorlevel 1 exit /b 1
) else (
  echo     node_modules already exists, skipping install
)

echo ==^> Generating/updating logo ^(requires ImageMagick 7, optional^)
where magick >nul 2>nul
if errorlevel 1 (
  echo     ImageMagick ^(magick^) not found, using existing icons
) else (
  node scripts\gen-logo.js
  if errorlevel 1 echo     WARNING: logo generation failed, using existing icons
)

echo ==^> Building renderer ^(Vite^)
call npm run build
if errorlevel 1 exit /b 1

echo ==^> Packaging with electron-builder ^(nsis + portable^)
call npx electron-builder --win nsis portable
if errorlevel 1 exit /b 1

echo.
echo Packaging complete. Artifacts are in release\:
dir /b release\*.exe
endlocal
