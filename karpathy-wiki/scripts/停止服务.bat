@echo off
chcp 936 >nul 2>&1
REM 入口脚本：仅 echo 提示 + 调用主逻辑 ps1，不含业务逻辑
REM 业务逻辑、日志着色、流水号全部在 stop-service.ps1 中实现
cd /d "%~dp0.."

echo ============================================
echo   正在停止 Karpathy-Wiki 服务...
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-service.ps1" %*

echo.
pause
exit
