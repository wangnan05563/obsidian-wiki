@echo off
REM ============================================================
REM  Encoding Check - Double click to run
REM  Scans frontend/src and api/src for .vue/.ts source files
REM  Detects garbled text caused by GBK encoding
REM ============================================================
setlocal
cd /d "%~dp0\.."
echo === Encoding Check ===
call node scripts\check-encoding.js
if errorlevel 1 goto fix
echo.
echo OK - All files are UTF-8.
pause
goto end
:fix
echo.
echo GBK garbled text detected. Auto fix:
echo   node scripts\check-encoding.js --fix
pause
:end
endlocal
