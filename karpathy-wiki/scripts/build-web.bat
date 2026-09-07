@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Frontend Build
echo ============================================
echo.

REM Capture configured node.exe dir from ps1 and prepend to PATH
REM Why: .bat is pure ASCII cannot parse config.json. ps1 reads
REM      tools.node.exe_path and outputs the dir; for /f captures it.
REM      PATH update happens in cmd.exe process so it persists.
REM Why enabledelayedexpansion: !NODE_DIR! reads runtime value inside if-block
REM                              where %NODE_DIR% would be expanded at parse time
set "NODE_DIR="
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepend-node-path.ps1"') do set "NODE_DIR=%%i"

if defined NODE_DIR (
    set "PATH=!NODE_DIR!;%PATH%"
    echo Using configured node from: !NODE_DIR!
) else (
    echo No configured node path, falling back to PATH
)

echo Node version:
node --version
echo.

echo [1/4] Checking dependencies...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    echo Please run scripts\setup-env first
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

set PKG_CMD=npm
where pnpm >nul 2>&1
if not errorlevel 1 set PKG_CMD=pnpm
echo Package manager: %PKG_CMD%

if not exist "node_modules" (
    echo [ERROR] node_modules not found
    echo Please run scripts\setup-env first
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

REM Why no longer manually clean old build dirs (e.g. api\public):
REM vite.config.ts emptyOutDir:true auto-empties outDir(release/spa/public) on build;
REM manual rmdir may trigger the safe-delete hook block (see historical _build_err.log).

echo.
echo [2/4] Cleaning TypeScript/Vue compile artifacts...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path 'frontend\\src' -Recurse -Filter '*.js' -Exclude '*.vue.js','*.ts.js' | Remove-Item -Force -ErrorAction SilentlyContinue"
echo   Cleaned stray .js files from src/

echo.
echo [3/4] Building SPA...
call %PKG_CMD% --filter @karpathy-wiki/web build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed, check errors above
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

if not exist "..\release\spa\public\index.html" (
    echo.
    echo [ERROR] index.html not found in build output
    echo Check vite.config.ts outDir setting
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

echo.
echo ============================================
echo   Frontend build complete
echo ============================================
echo   Output: ..\release\spa\public\
echo   Entry:  ..\release\spa\public\index.html
echo ============================================
echo.
echo Press any key to exit...
if not "%KARPATHY_AUTOMATION%"=="1" pause >nul
exit
