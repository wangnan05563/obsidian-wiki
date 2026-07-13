@echo off
REM Tauri environment setup - check/install Rust GNU toolchain + w64devkit + windres wrapper
REM This script only calls tauri-setup-env.ps1, all Chinese output is in .ps1
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Tauri Environment Setup
echo ============================================
echo.
echo Checking: Rust GNU toolchain / w64devkit / windres wrapper
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-setup-env.ps1" %*
set "ENTRY_EXIT_CODE=%ERRORLEVEL%"

if not "%ENTRY_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Setup failed, check red FAIL logs above
    pause
    exit /b %ENTRY_EXIT_CODE%
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0
