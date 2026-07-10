@echo off
REM ============================================================
REM  编码体检 - 双击运行
REM  扫描 packages/web/src 和 services/api/src 的 .vue/.ts 源文件
REM  识别因被保存为 GBK 而导致的乱码问题
REM ============================================================
setlocal
cd /d "%~dp0\.."
echo === 编码体检 ===
node scripts\check-encoding.js
set EXITCODE=%ERRORLEVEL%
echo.
if %EXITCODE% NEQ 0 (
  echo 检测到 GBK 乱码问题。
  echo.
  echo 自动修复（GBK 转 UTF-8 无 BOM）：
  echo   node scripts\check-encoding.js --fix
  echo.
  pause
) else (
  echo OK - 全部 UTF-8。
  pause
)
endlocal
