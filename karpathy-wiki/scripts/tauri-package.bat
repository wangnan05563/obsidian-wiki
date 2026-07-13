@echo off
REM Tauri release build - tauri build (production bundle: .msi / .exe installer)
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Tauri Package (Release Build)
echo ============================================
echo.
echo Steps:
echo   1. Setup environment (LLD + windres wrapper)
echo   2. Build SPA (vite build -> services/api/public)
echo   3. tauri build (release bundle: .msi / .exe)
echo.
echo Expected time: 5-15 minutes (first build compiles all deps)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-build-release.ps1" %*
set "ENTRY_EXIT_CODE=%ERRORLEVEL%"

if not "%ENTRY_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Package failed, check red FAIL logs above
    pause
    exit /b %ENTRY_EXIT_CODE%
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0
