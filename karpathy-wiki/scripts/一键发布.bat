@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM Karpathy-Wiki one-click publish
REM Build SPA, deploy to live, restart production server
REM ============================================================
cd /d "%~dp0.."

REM Resolve configured node.exe dir and prepend to PATH
set "NODE_DIR="
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepend-node-path.ps1"') do set "NODE_DIR=%%i"
if defined NODE_DIR (
    set "PATH=!NODE_DIR!;%PATH%"
    echo Using node from: !NODE_DIR!
) else (
    echo No configured node path, falling back to PATH
)

echo ============================================================
echo   Karpathy-Wiki One-Click Publish
echo ============================================================
echo   Builds the SPA, deploys it, restarts prod server.
echo   Options: -SkipInstall -SkipBuild -SkipDeploy
echo            -SkipRestart -PublishRelease -DryRun
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-wiki.ps1" %*
if errorlevel 1 (
    echo.
    echo [ERROR] Publish failed, see red ERROR logs above
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

echo.
if not "%KARPATHY_AUTOMATION%"=="1" pause
exit /b 0
