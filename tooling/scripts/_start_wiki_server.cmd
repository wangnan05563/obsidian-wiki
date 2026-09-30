@echo off
setlocal
rem Window title set FIRST so a double-click immediately shows a
rem named window - if you see no "Karpathy-Wiki Starter" title,
rem the script was NOT launched by double-click.
title Karpathy-Wiki Starter
rem 脚本已归并到 tooling/scripts/，%~dp0 不再是项目根；
rem 这里一次性解析出根目录，后续所有路径都基于 %ROOT%。
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "TRACE=%ROOT%\karpathy-wiki\logs\start-trace.log"
echo [S0] script start >> "%TRACE%"
rem ============================================================
rem  Karpathy-Wiki one-click starter: backend + frontend (hidden)
rem  Lives in tooling\scripts\; double-click to run.
rem
rem  Why wait for ports: backend (tsx) boots in 10s+, so we poll
rem  3000/5173 until LISTEN. This keeps this window alive with
rem  meaningful status instead of flashing and closing.
rem ============================================================

if not exist "%ROOT%\karpathy-wiki\api\src\index.ts" goto :noroot
echo [S1] root ok >> "%TRACE%"

where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_CMD=node"
) else (
  set "NODE_CMD=C:\Users\hspcadmin\.workbuddy\binaries\node\versions\22.22.2\node.exe"
)

:launch
echo [S3] launching services >> "%TRACE%"

rem ---- Port pre-check: if a service is already listening (e.g. this
rem       script was double-clicked again), reuse it instead of launching
rem       a duplicate that fails on the busy port and piles up processes.
rem       This also avoids a pointless 60s wait below. ----
call :isup 3000
if errorlevel 1 goto :start_backend
echo  [SKIP] Backend API already listening on port 3000, reusing it
goto :after_backend
:start_backend
cd /d "%ROOT%\karpathy-wiki\api"
rem Why NOT -WindowStyle Hidden on the powershell itself: running a
rem hidden powershell child steals the starter console window (handle 0)
rem = "flash-close". Hidden applies only to the node child via Start-Process.
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_CMD%' -ArgumentList 'node_modules\tsx\dist\cli.mjs','src\index.ts' -WindowStyle Hidden -RedirectStandardOutput '..\logs\api-start.out.log' -RedirectStandardError '..\logs\api-start.err.log'"
cd /d "%ROOT%\karpathy-wiki\api"
:after_backend

call :isup 5173
if errorlevel 1 goto :start_frontend
echo  [SKIP] Frontend Web already listening on port 5173, reusing it
goto :after_frontend
:start_frontend
cd /d "%ROOT%\karpathy-wiki\frontend"
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_CMD%' -ArgumentList 'node_modules\vite\bin\vite.js' -WindowStyle Hidden -RedirectStandardOutput '..\logs\web-dev.log' -RedirectStandardError '..\logs\web-dev-err.log'"
cd /d "%ROOT%\karpathy-wiki\api"
:after_frontend

echo [S4] services launched >> "%TRACE%"

echo.
echo  Karpathy-Wiki: starting backend + frontend (hidden)...
echo.
call :waitport 3000 "Backend API"
call :waitport 5173 "Frontend Web"
echo.
echo  [OK] Services ready:
echo    Backend API : http://localhost:3000
echo    Frontend Web: http://localhost:5173/wiki/
echo    Logs        : karpathy-wiki\logs\
echo.
echo  ---------------------------------------------------------
echo   Press any key to open the browser; window closes after.
echo   Hint: best run by DOUBLE-CLICK on this file. If launched
echo   from an IDE/terminal, 'pause' returns instantly and the
echo   window looks like it "flash-closed" - that is expected.
echo  ---------------------------------------------------------
echo.
echo [S5] ready, waiting for key >> "%TRACE%"
pause >nul
echo [S6] key pressed, opening browser >> "%TRACE%"
start "" "http://localhost:5173/wiki/"
echo [S7] done >> "%TRACE%"
endlocal
exit /b 0

:isup
rem %1=port. exit 0 if already LISTENING (reuse it), 1 if free (must start).
netstat -an | findstr /R /C:":%~1 .*LISTENING" >nul
if not errorlevel 1 exit /b 0
exit /b 1

:waitport
rem Poll a TCP port until LISTEN (max 60s). %1=port, %2=label.
rem Why netstat+findstr instead of powershell: a non-hidden powershell
rem child steals the console and makes the starter window flash/close.
set "PORT=%~1"
set "NAME=%~2"
echo    Waiting for %NAME% (port %PORT%) ...
set /a "TRY=0"
:waitloop
netstat -an | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 goto :waitok
set /a TRY+=1
if %TRY% GEQ 60 goto :waittimeout
set /a MOD=TRY %% 5
if %MOD%==0 <nul set /p ".=."
ping -n 2 127.0.0.1 >nul
goto :waitloop
:waitok
echo    [OK] %NAME% (port %PORT%) is ready
exit /b 0
:waittimeout
echo    [WARN] %NAME% (port %PORT%) not ready after 60s; see logs\api-start.err.log
exit /b 0

:noroot
echo [ERROR] karpathy-wiki\api not found relative to this script.
echo         Expected layout: ^<project-root^>\tooling\scripts\this-script
echo         Currently at: %~dp0
echo.
pause
endlocal
exit /b 1
