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
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

echo.
if not "%KARPATHY_AUTOMATION%"=="1" pause
exit
