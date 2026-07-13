@echo off
REM Tauri stop - kill desktop.exe + sidecar child processes
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Tauri Stop Service
echo ============================================
echo.
echo Killing: desktop.exe + sidecar (cmd/pnpm/tsx/node)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-stop.ps1" %*
set "ENTRY_EXIT_CODE=%ERRORLEVEL%"

if not "%ENTRY_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Stop failed, check red FAIL logs above
    pause
    exit /b %ENTRY_EXIT_CODE%
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0
