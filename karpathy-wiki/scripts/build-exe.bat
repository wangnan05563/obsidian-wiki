@echo off
cd /d "%~dp0.."

echo ============================================
echo   Karpathy-Wiki EXE Build (PowerShell)
echo ============================================
echo.
echo Steps:
echo   1. Check deps (Node.js / pnpm / pkg / esbuild)
echo   2. Build @wiki/harness
echo   3. Build SPA (vite build)
echo   4. esbuild bundle (TS -> CJS)
echo   5. pkg --sea -> exe
echo   6. Copy resources (SPA + config + vault + prompts)
echo   7. Inno Setup installer (if available)
echo.
echo Output: dist\karpathy-wiki\karpathy-wiki.exe
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-exe.ps1" %*

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed, check logs above
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build complete
echo ============================================
echo   Output: dist\karpathy-wiki\
echo   EXE:   dist\karpathy-wiki\karpathy-wiki.exe
echo ============================================
echo.
pause
exit
