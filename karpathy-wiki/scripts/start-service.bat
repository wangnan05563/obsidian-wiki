@echo off
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki Starting...
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-service.ps1" %*

if errorlevel 1 (
    echo.
    echo [ERROR] Start failed, check red ERROR logs above
    echo.
    pause
    exit /b 1
)

echo.
pause
exit
