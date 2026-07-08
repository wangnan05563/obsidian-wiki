@echo off
chcp 936 >nul 2>&1
REM 脚本位于 scripts/ 子目录，切回项目根目录
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki 前端构建
echo ============================================
echo.

REM 显示 Node.js 版本
echo Node:
node --version
echo.

REM [1/3] 检查依赖
echo [1/3] 检查依赖...

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未检测到 Node.js！
    echo 请先运行 scripts\环境配置.bat
    pause
    exit /b 1
)

REM 检测包管理器
set PKG_CMD=npm
where pnpm >nul 2>&1
if not errorlevel 1 set PKG_CMD=pnpm
echo 使用包管理器：%PKG_CMD%

REM 检查 node_modules
if not exist "node_modules" (
    echo [ERROR] node_modules 不存在！
    echo 请先运行 scripts\环境配置.bat
    pause
    exit /b 1
)

REM [2/3] 清理旧构建产物
echo.
echo [2/3] 清理旧构建产物...

REM vite.config.ts 中 outDir 指向 services/api/public
REM emptyOutDir: true 会自动清理，这里仅提示
if exist "services\api\public" (
    echo   旧产物目录 services\api\public 将由 vite 自动清理
)

REM [3/3] 构建前端
echo.
echo [3/3] 构建前端 SPA...

%PKG_CMD% run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] 构建失败，请检查上方错误信息
    pause
    exit /b 1
)

REM 验证构建产物
if not exist "services\api\public\index.html" (
    echo.
    echo [ERROR] 构建完成但未找到 index.html
    echo 请检查 vite.config.ts 的 outDir 配置
    pause
    exit /b 1
)

echo.
echo ============================================
echo   构建完成！
echo ============================================
echo   产物目录：services\api\public\
echo   产物入口：services\api\public\index.html
echo.
echo   后续操作：
echo   - 开发模式：运行 scripts\启动服务.bat
echo   - 生产模式：后端 Fastify 会自动托管 services\api\public\
echo   - 打包 EXE：运行 scripts\构建打包.bat
echo ============================================
echo.
pause
