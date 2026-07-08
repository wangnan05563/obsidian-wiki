@echo off
chcp 65001 >nul 2>&1
REM 脚本位于 scripts/ 子目录，调用同目录下 build-exe.ps1
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki EXE 一键构建（调用 PowerShell 脚本）
echo ============================================
echo.
echo 构建流程：
echo   1. 检查依赖（Node.js / pnpm / @yao-pkg/pkg / esbuild）
echo   2. 构建 @wiki/harness（如存在本地包）
echo   3. 构建 SPA（vite build）
echo   4. esbuild 打包后端 TS → CJS 单文件
echo   5. @yao-pkg/pkg 打包 → exe
echo   6. 复制外置资源（SPA + config + vault 默认结构 + prompts）
echo   7. 制作安装包（Inno Setup，未安装时自动安装）
echo.
echo 产物：dist\karpathy-wiki\karpathy-wiki.exe
echo.

REM -NoProfile：避免用户自定义 profile 干扰
REM -ExecutionPolicy Bypass：绕过执行策略限制
REM -File：指定要执行的 ps1 脚本，%* 透传所有命令行参数（例如 -SkipSPA -SkipDeps）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-exe.ps1" %*

REM PowerShell 脚本退出码透传
if errorlevel 1 (
    echo.
    echo [ERROR] 构建失败，请查看上方错误信息
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   构建完成！
echo ============================================
echo   输出目录：dist\karpathy-wiki\
echo   主程序：  dist\karpathy-wiki\karpathy-wiki.exe
echo.
echo   产物：
echo   - EXE：dist\karpathy-wiki\karpathy-wiki.exe
echo   - 安装包：dist\KarpathyWiki-Setup-v*.exe（需 Inno Setup）
echo   - 可直接运行 dist\karpathy-wiki\karpathy-wiki.exe 启动
echo ============================================
echo.
pause
exit
