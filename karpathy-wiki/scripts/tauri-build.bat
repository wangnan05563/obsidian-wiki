@echo off
REM Tauri debug build - cargo check + cargo build (debug mode)
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Tauri Debug Build
echo ============================================
echo.
echo Steps:
echo   1. Setup environment (LLD + windres wrapper)
echo   2. cargo check (verify compilation)
echo   3. cargo build (debug binary)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-build-debug.ps1" %*
set "ENTRY_EXIT_CODE=%ERRORLEVEL%"

if not "%ENTRY_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Build failed, check red FAIL logs above
    pause
    exit /b %ENTRY_EXIT_CODE%
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0
