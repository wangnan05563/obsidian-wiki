@echo off
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Frontend Build
echo ============================================
echo.

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

echo.
echo [2/4] Cleaning old build output...
if exist "api\public" (
    rmdir /s /q "api\public"
    echo   Cleaned api\public
)

echo.
echo [3/4] Cleaning TypeScript/Vue compile artifacts...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path 'frontend\\src' -Recurse -Filter '*.js' -Exclude '*.d.ts.js' | Remove-Item -Force -ErrorAction SilentlyContinue"
echo   Cleaned stray .js files from src/

echo.
echo [4/4] Building SPA...
call %PKG_CMD% --filter @karpathy-wiki/web build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed, check errors above
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

if not exist "api\public\index.html" (
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
echo   Output: api\public\
echo   Entry:  api\public\index.html
echo ============================================
echo.
echo Press any key to exit...
if not "%KARPATHY_AUTOMATION%"=="1" pause >nul
exit
