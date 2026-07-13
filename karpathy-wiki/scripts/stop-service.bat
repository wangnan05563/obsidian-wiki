@echo off
cd /d "%~dp0.."

echo ============================================
echo   Stopping Karpathy-Wiki...
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-service.ps1" %*

echo.
pause
exit
