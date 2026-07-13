@echo off
REM Tauri dev - start desktop app with sidecar (Node.js backend)
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Tauri Dev (Start Service)
echo ============================================
echo.
echo Steps:
echo   1. Setup environment (LLD + windres wrapper)
echo   2. Clean old process (port + desktop.exe)
echo   3. tauri dev (compile + spawn sidecar + open windows)
echo   4. Wait for backend /health ready
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-start.ps1" %*
set "ENTRY_EXIT_CODE=%ERRORLEVEL%"

if not "%ENTRY_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Start failed, check red FAIL logs above
    pause
    exit /b %ENTRY_EXIT_CODE%
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0
