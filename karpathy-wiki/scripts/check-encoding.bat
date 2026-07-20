@echo off
REM ============================================================
REM  Encoding Check - Double click to run
REM  Scans frontend/src and api/src for .vue/.ts source files
REM  Detects garbled text caused by GBK encoding
REM
REM  Why delegate to .ps1: .bat is pure ASCII and cannot parse
REM  config.json. The .ps1 runner reads tools.node.exe_path and
REM  invokes check-encoding.js with the configured node.exe.
REM ============================================================
setlocal
cd /d "%~dp0\.."
echo === Encoding Check ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-encoding-runner.ps1" %*
if errorlevel 1 goto fix
echo.
echo OK - All files are UTF-8.
pause
goto end
:fix
echo.
echo GBK garbled text detected. Auto fix:
echo   scripts\check-encoding.bat --fix
pause
:end
endlocal
