@echo off
chcp 65001 >nul 2>&1
REM 脚本位于 scripts/ 子目录，切回项目根目录
cd /d "%~dp0.."
setlocal enabledelayedexpansion

echo ========================================
echo   停止 Karpathy-Wiki 服务...
echo ========================================

REM [1/3] 停止后端 API（端口 3000）
echo [1/3] 停止后端 API...

set API_KILLED=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
    if not errorlevel 1 (
        echo   [OK] 后端 API 已停止 (PID %%a)
        set API_KILLED=1
    )
)
if "!API_KILLED!"=="0" (
    echo   [跳过] 端口 3000 无进程运行
)

REM [2/3] 停止前端 Web（端口 5173）
echo [2/3] 停止前端 Web...

set WEB_KILLED=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
    if not errorlevel 1 (
        echo   [OK] 前端 Web 已停止 (PID %%a)
        set WEB_KILLED=1
    )
)
if "!WEB_KILLED!"=="0" (
    echo   [跳过] 端口 5173 无进程运行
)

REM 杀掉残留的 node 进程（仅杀由本项目启动的，通过窗口标题匹配）
taskkill /F /FI "WINDOWTITLE eq KarpathyWiki-API*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq KarpathyWiki-Web*" >nul 2>&1

timeout /t 1 >nul 2>&1

REM [3/3] 验证端口已释放
echo [3/3] 验证停止结果...

set ALL_FREE=1
netstat -aon | findstr ":3000.*LISTENING" >nul 2>&1
if not errorlevel 1 (
    set ALL_FREE=0
    echo   [警告] 端口 3000 仍被占用
)
netstat -aon | findstr ":5173.*LISTENING" >nul 2>&1
if not errorlevel 1 (
    set ALL_FREE=0
    echo   [警告] 端口 5173 仍被占用
)

if "!ALL_FREE!"=="1" (
    echo   [OK] 所有服务已停止
) else (
    echo   [警告] 部分进程可能仍在运行，请检查任务管理器
)

echo.
echo ========================================
echo   服务已停止
echo ========================================
echo.
timeout /t 2 >nul 2>&1
