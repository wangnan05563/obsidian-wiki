@echo off
cd /d "%~dp0.."

echo ============================================
echo   Stopping Karpathy-Wiki...
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-service.ps1" %*

echo.
if not "%KARPATHY_AUTOMATION%"=="1" pause
exit
