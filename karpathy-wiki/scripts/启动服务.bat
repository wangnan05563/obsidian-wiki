@echo off
chcp 936 >nul 2>&1
REM 入口脚本：仅 echo 提示 + 调用主逻辑 ps1，不含业务逻辑
REM 业务逻辑、日志着色、流水号全部在 start-service.ps1 中实现
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki 服务启动中...
echo ============================================
echo.
echo 日志格式：时间 ^| 级别 ^| [会话流水号^|序号] ^| [步骤] 消息
echo 颜色：时间灰 ^| 级别按类型 ^| 流水号青 ^| 步骤号紫 ^| 消息白
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-service.ps1" %*

if errorlevel 1 (
    echo.
    echo [ERROR] 启动失败，请查看上方红色 ERROR 日志行了解详情
    echo.
    pause
    exit /b 1
)

echo.
pause
exit
