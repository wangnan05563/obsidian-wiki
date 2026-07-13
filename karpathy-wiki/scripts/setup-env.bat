@echo off
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Environment Setup
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-env.ps1" %*

if errorlevel 1 (
    echo.
    echo [ERROR] Setup failed, check logs above
    pause
    exit /b 1
)

echo.
echo Setup complete. Press any key to exit...
pause >nul
exit
