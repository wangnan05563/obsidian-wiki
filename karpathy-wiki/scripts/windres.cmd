@echo off
REM windres.cmd - windres wrapper for Chinese path encoding issue
REM Uses WRAPPER_PS1 env var to locate PowerShell script (avoids Chinese chars in .cmd)

REM Debug log to confirm wrapper is called
echo [%DATE% %TIME%] windres.cmd called with args: %* >> "%TEMP%\windres-wrapper-debug.log"

powershell -ExecutionPolicy Bypass -File "%WRAPPER_PS1%" %*
exit /b %ERRORLEVEL%
