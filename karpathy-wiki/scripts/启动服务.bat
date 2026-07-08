@echo off
chcp 936 >nul 2>&1
REM 脚本位于 scripts/ 子目录，切回项目根目录
cd /d "%~dp0.."
setlocal enabledelayedexpansion

echo ========================================
echo   Karpathy-Wiki Starting...
echo ========================================

REM [1/4] 清理旧进程（通过 PID 文件 + 端口扫描）
echo [1/4] 清理旧进程...

if not exist "logs" mkdir logs

REM 杀掉占用 3000 端口的进程（后端 API）
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
)

REM 杀掉占用 5173 端口的进程（前端 Vite）
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
)

timeout /t 1 >nul 2>&1

REM [2/4] 检查依赖
echo [2/4] 检查依赖...

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未检测到 Node.js！
    echo 请运行 scripts\环境配置.bat 一键安装环境
    pause
    exit /b 1
)

REM 检测包管理器（pnpm 优先，回退 npm）
set PKG_CMD=npm
where pnpm >nul 2>&1
if not errorlevel 1 set PKG_CMD=pnpm

REM 检查 node_modules 是否存在
if not exist "node_modules" (
    echo [ERROR] node_modules 不存在！
    echo 请先运行 scripts\环境配置.bat
    pause
    exit /b 1
)

REM [3/4] 启动后端 API + 前端 Web
echo [3/4] 启动服务（使用 %PKG_CMD%）...

REM 启动后端 API（新窗口）
start "KarpathyWiki-API" cmd /c "%PKG_CMD% dev:api 2>&1 & pause"

REM 等待后端端口就绪（最多 30 秒）
echo 等待后端 API 就绪...
set /a tries=0
:wait_api
set /a tries+=1
ping -n 2 127.0.0.1 >nul 2>&1
netstat -aon | findstr ":3000.*LISTENING" >nul 2>&1
if errorlevel 1 (
    if !tries! lss 15 goto wait_api
    echo [ERROR] 后端 API 30 秒内未启动！
    echo 请检查 services\api 目录下的配置
    pause
    exit /b 1
)
echo   后端 API 已启动：http://localhost:3000

REM 启动前端 Web（新窗口）
start "KarpathyWiki-Web" cmd /c "%PKG_CMD% dev:web 2>&1 & pause"

REM 等待前端端口就绪（最多 15 秒）
set /a tries=0
:wait_web
set /a tries+=1
ping -n 2 127.0.0.1 >nul 2>&1
netstat -aon | findstr ":5173.*LISTENING" >nul 2>&1
if errorlevel 1 (
    if !tries! lss 10 goto wait_web
    echo [WARN] 前端 Web 启动较慢，可稍后手动访问
) else (
    echo   前端 Web 已启动：http://localhost:5173
)

REM [4/4] 验证服务
echo [4/4] 验证服务...

netstat -aon | findstr ":3000.*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] 后端 API 运行中
) else (
    echo   [FAIL] 后端 API 未运行
)

echo.
echo ========================================
echo   服务已启动！
echo ========================================
echo   后端 API：http://localhost:3000
echo   前端 Web：http://localhost:5173
echo   健康检查：http://localhost:3000/health
echo.
echo 停止服务：双击 scripts\停止服务.bat
echo.

start "" http://localhost:5173
timeout /t 3 >nul 2>&1
exit
