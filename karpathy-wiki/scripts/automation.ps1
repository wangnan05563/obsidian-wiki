<#
.SYNOPSIS
    Karpathy-Wiki 项目服务生命周期自动化执行器
.DESCRIPTION
    整合 scripts\start-service.bat、scripts\stop-service.bat、scripts\build-web.bat 三个脚本，
    提供 start/stop/rebuild/check/status 五个动作的统一入口。
    参考 .trae\skills\wiki-automation-startserver\SKILL.md 使用。
.PARAMETER Action
    必填。取值：start | stop | rebuild | check | status
.PARAMETER LogFile
    可选。日志文件路径，默认 logs\automation.log
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\automation.ps1 -Action start
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\automation.ps1 -Action rebuild
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'stop', 'rebuild', 'check', 'status')]
    [string]$Action,

    [string]$LogFile = "logs\automation.log"
)

# 切换到项目根目录（脚本位于 scripts/ 子目录）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location -LiteralPath $projectRoot

# 控制台输出编码设为 UTF-8，避免中文乱码（Windows 默认 GBK）
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 确保 logs 目录存在（不存在则创建，避免后续写日志失败）
if (-not (Test-Path -LiteralPath "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
}

# 端口从 config.json 读取，与 start-service.ps1 保持一致
$ScriptConfigPath = Join-Path $PSScriptRoot 'config.json'
if (Test-Path $ScriptConfigPath) {
    $ScriptConfig = Get-Content $ScriptConfigPath -Raw | ConvertFrom-Json
    $API_PORT = $ScriptConfig.ports.api
    $WEB_PORT = $ScriptConfig.ports.web
} else {
    $API_PORT = 3000
    $WEB_PORT = 5173
}

# 加载 node 路径解析模块（配置驱动，使用 tools.node.exe_path 指定的 node）
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
if ($ScriptConfig) {
    $Script:NodeExe = Resolve-NodeExe -Config $ScriptConfig
    # 将 node.exe 所在目录加入 PATH 头部，让 pnpm/npm 自动找到指定版本
    if ($Script:NodeExe) { Invoke-WithNodePath -NodeExePath $Script:NodeExe }
}

# ============================================
# 日志函数：写入 logs\automation.log
# 格式：2026-07-09 10:30:15 [INFO]  ACTION=start STEP=env-check RESULT=pass
# ============================================
function Write-Log {
    param(
        [string]$LogAction,
        [string]$Step,
        [string]$Result,
        [string]$Msg = "",
        [string]$Level = "INFO"
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    # Level 左对齐 5 字符，与示例对齐
    $levelPad = $Level.PadRight(5)
    $line = "$timestamp [$levelPad] ACTION=$LogAction STEP=$Step RESULT=$Result"
    if ($Msg) { $line += " MSG=`"$Msg`"" }
    try {
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    }
    catch {
        # 日志写入失败不影响主流程，仅控制台提示
        Write-Host "  [WARN] 日志写入失败：$_" -ForegroundColor Yellow
    }
}

# ============================================
# 端口检查：返回是否监听
# ============================================
function Test-PortListening {
    param([int]$Port)
    # netstat -aon 输出含 LISTENING 行时即认为端口被占用
    # 使用 -ErrorAction SilentlyContinue 避免 findstr 无匹配时抛错
    $line = netstat -aon | Select-String -Pattern ":$Port\s.*LISTENING" -SimpleMatch:$false -ErrorAction SilentlyContinue
    return [bool]$line
}

# 获取占用端口的 PID（取第一个匹配）
function Get-PortPid {
    param([int]$Port)
    $line = netstat -aon | Select-String -Pattern ":$Port\s.*LISTENING" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) {
        # netstat 行格式：TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 12345
        $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
        return $parts[-1]
    }
    return $null
}

# ============================================
# 环境检查：返回 $true / $false
# ============================================
function Invoke-EnvCheck {
    param([string]$Action)

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  环境检查..." -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    $allPass = $true

    # 1. Node.js（路径已由脚本头部 Resolve-NodeExe 解析，避免 PATH 旧版优先）
    if (-not $Script:NodeExe) {
        Write-Host "  [FAIL] 未检测到 Node.js" -ForegroundColor Red
        Write-Host "         请检查 scripts/config.json 中 tools.node 配置或运行 scripts\setup-env.bat 一键安装环境" -ForegroundColor Yellow
        Write-Log -LogAction $Action -Step "env-check" -Result "fail" -Msg "node not resolved from config"
        return $false
    }
    $nodeVer = & $Script:NodeExe --version 2>$null
    Write-Host "  [OK] Node.js $nodeVer (路径: $($Script:NodeExe))" -ForegroundColor Green

    # 2. 包管理器（pnpm 优先，回退 npm）
    $pkgCmd = $null
    if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
        $pkgCmd = "pnpm.cmd"
    }
    elseif (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        $pkgCmd = "npm.cmd"
    }
    if (-not $pkgCmd) {
        Write-Host "  [FAIL] 未检测到 pnpm 或 npm" -ForegroundColor Red
        Write-Host "         请运行 npm install -g pnpm 安装 pnpm" -ForegroundColor Yellow
        Write-Log -LogAction $Action -Step "env-check" -Result "fail" -Msg "no package manager"
        return $false
    }
    $pkgVer = & $pkgCmd --version 2>$null
    Write-Host "  [OK] $pkgCmd $pkgVer" -ForegroundColor Green

    # 3. 根 node_modules
    if (-not (Test-Path -LiteralPath "node_modules")) {
        Write-Host "  [FAIL] 根 node_modules 不存在" -ForegroundColor Red
        Write-Host "         请运行 $pkgCmd install" -ForegroundColor Yellow
        Write-Log -LogAction $Action -Step "env-check" -Result "fail" -Msg "root node_modules missing"
        return $false
    }
    Write-Host "  [OK] 根 node_modules" -ForegroundColor Green

    # 4. 后端依赖（api\node_modules）
    if (-not (Test-Path -LiteralPath "api\node_modules")) {
        Write-Host "  [FAIL] api\node_modules 不存在" -ForegroundColor Red
        Write-Host "         请运行 $pkgCmd install（workspace 会自动安装子包依赖）" -ForegroundColor Yellow
        Write-Log -LogAction $Action -Step "env-check" -Result "fail" -Msg "api node_modules missing"
        return $false
    }
    Write-Host "  [OK] 后端 node_modules" -ForegroundColor Green

    # 5. 前端依赖（frontend\node_modules）
    if (-not (Test-Path -LiteralPath "frontend\node_modules")) {
        Write-Host "  [FAIL] frontend\node_modules 不存在" -ForegroundColor Red
        Write-Host "         请运行 $pkgCmd install" -ForegroundColor Yellow
        Write-Log -LogAction $Action -Step "env-check" -Result "fail" -Msg "web node_modules missing"
        return $false
    }
    Write-Host "  [OK] 前端 node_modules" -ForegroundColor Green

    Write-Host ""
    Write-Host "  环境检查通过" -ForegroundColor Green
    Write-Log -LogAction $Action -Step "env-check" -Result "pass"
    return $true
}

# ============================================
# 调用 .bat 脚本：使用 cmd /c 包裹
# ============================================
function Invoke-Bat {
    param(
        [string]$BatName,
        [string]$Action
    )

    $batPath = Join-Path "scripts" $BatName
    if (-not (Test-Path -LiteralPath $batPath)) {
        Write-Host "  [FAIL] 脚本不存在：$batPath" -ForegroundColor Red
        Write-Log -LogAction $Action -Step "call-bat" -Result "fail" -Msg "bat not found: $batPath"
        return $false
    }

    Write-Host "  调用 $BatName ..." -ForegroundColor Cyan
    # 设置自动化标记环境变量，让 .bat 跳过 pause 避免阻塞
    # 为什么用环境变量而非参数：.bat 的参数会透传给 start-service.ps1 的 param()，导致参数解析错误
    $env:KARPATHY_AUTOMATION = "1"
    # 为什么用超时等待而非 -Wait：start-service.bat 启动的后台 API/Web 进程继承 cmd.exe 的标准输出句柄，
    # 导致 cmd.exe 不退出（即使 start-service.ps1 已 exit），-Wait 会永久阻塞。
    # 超时 90 秒后强制继续，由后续端口验证判断启动是否成功。
    $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$batPath`"" -NoNewWindow -PassThru
    # 为什么用轮询等待而非 -Wait：start-service.bat 启动的后台 API/Web 进程继承 cmd.exe 的标准输出句柄，
    # 导致 cmd.exe 不退出（即使 start-service.ps1 已 exit），-Wait 会永久阻塞。
    # 对于 start/rebuild 动作：API 端口就绪后立即继续（start-service.ps1 内部已完成验证）。
    # 对于 stop/build 动作：cmd.exe 无后台进程，会正常退出。
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) { break }
        if ($Action -eq 'start' -or $Action -eq 'rebuild') {
            if (Test-PortListening -Port $API_PORT) { break }
        }
        Start-Sleep -Seconds 2
    }
    # 清除自动化标记，避免影响后续手动调用的 .bat
    Remove-Item Env:\KARPATHY_AUTOMATION -ErrorAction SilentlyContinue
    # 超时未退出时 HasExited=$false，不能访问 ExitCode（会抛异常）
    if (-not $process.HasExited) {
        Write-Host "  [WARN] $BatName 超时未退出，继续验证端口..." -ForegroundColor Yellow
        Write-Log -LogAction $Action -Step "call-bat" -Result "skip" -Msg "$BatName timeout, will verify by port"
        return $true
    }
    # 确保进程完全退出后再读 ExitCode（PowerShell 在进程刚退出时 ExitCode 可能为 $null）
    $process.WaitForExit(2000) | Out-Null
    $exitCode = $process.ExitCode
    # ExitCode 为 $null 时按成功处理（cmd.exe exit 不带退出码，或进程被外力终止）
    if ($null -ne $exitCode -and $exitCode -ne 0) {
        Write-Host "  [FAIL] $BatName 退出码 $exitCode" -ForegroundColor Red
        Write-Log -LogAction $Action -Step "call-bat" -Result "fail" -Msg "$BatName exit=$exitCode"
        return $false
    }

    Write-Host "  [OK] $BatName 完成" -ForegroundColor Green
    Write-Log -LogAction $Action -Step "call-bat" -Result "pass" -Msg $BatName
    return $true
}

# ============================================
# 等待端口就绪
# ============================================
function Wait-PortReady {
    param(
        [int]$Port,
        [int]$MaxTries,
        [string]$Action
    )
    # 每 2 秒检查一次，MaxTries 次后超时
    for ($i = 1; $i -le $MaxTries; $i++) {
        if (Test-PortListening -Port $Port) {
            return $true
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

# ============================================
# 动作：start
# ============================================
function Action-Start {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Karpathy-Wiki 启动" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # 1. 环境预检查（失败立即终止）
    if (-not (Invoke-EnvCheck -Action "start")) {
        Write-Host ""
        Write-Host "[ERROR] 环境检查失败，启动已终止" -ForegroundColor Red
        return 1
    }

    # 2. 调用start-service.bat
    Write-Host ""
    Write-Host "[2/3] 启动服务..." -ForegroundColor Cyan
    if (-not (Invoke-Bat -BatName "start-service.bat" -Action "start")) {
        Write-Host ""
        Write-Host "[ERROR] 启动脚本执行失败" -ForegroundColor Red
        return 1
    }

    # 3. 验证端口（.bat 内部已做等待，这里二次确认）
    Write-Host ""
    Write-Host "[3/3] 验证服务..." -ForegroundColor Cyan
    $apiOk = Test-PortListening -Port $API_PORT
    $webOk = Test-PortListening -Port $WEB_PORT

    if ($apiOk) {
        $apiPid = Get-PortPid -Port $API_PORT
        Write-Host "  [OK] 后端 API 运行中 (PID=$apiPid)" -ForegroundColor Green
        Write-Log -LogAction "start" -Step "verify-port" -Result "pass" -Msg "api port=$API_PORT pid=$apiPid"
    }
    else {
        Write-Host "  [FAIL] 后端 API 未运行" -ForegroundColor Red
        Write-Log -LogAction "start" -Step "verify-port" -Result "fail" -Msg "api port=$API_PORT not listening"
    }

    if ($webOk) {
        $webPid = Get-PortPid -Port $WEB_PORT
        Write-Host "  [OK] 前端 Web 运行中 (PID=$webPid)" -ForegroundColor Green
        Write-Log -LogAction "start" -Step "verify-port" -Result "pass" -Msg "web port=$WEB_PORT pid=$webPid"
    }
    else {
        # Vite 可能慢启动，仅告警不回滚
        Write-Host "  [WARN] 前端 Web 启动较慢，可稍后手动访问 http://localhost:$WEB_PORT" -ForegroundColor Yellow
        Write-Log -LogAction "start" -Step "verify-port" -Result "skip" -Msg "web port=$WEB_PORT not ready yet"
    }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    if ($apiOk) {
        Write-Host "  服务已启动" -ForegroundColor Green
        Write-Host "  后端 API：http://localhost:$API_PORT" -ForegroundColor White
        Write-Host "  前端 Web：http://localhost:$WEB_PORT" -ForegroundColor White
        Write-Host "  健康检查：http://localhost:$API_PORT/health" -ForegroundColor White
        Write-Host "  停止服务：scripts\automation.ps1 -Action stop" -ForegroundColor White
    }
    else {
        Write-Host "  启动失败，请检查上方错误信息" -ForegroundColor Red
    }
    Write-Host "========================================" -ForegroundColor Cyan

    if (-not $apiOk) { return 1 }
    return 0
}

# ============================================
# 动作：stop
# ============================================
function Action-Stop {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  停止 Karpathy-Wiki 服务..." -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # 调用stop-service.bat
    Write-Host "[1/2] 调用stop-service.bat..." -ForegroundColor Cyan
    if (-not (Invoke-Bat -BatName "stop-service.bat" -Action "stop")) {
        Write-Host ""
        Write-Host "[ERROR] 停止脚本执行失败" -ForegroundColor Red
        return 1
    }

    # 验证端口已释放
    Write-Host ""
    Write-Host "[2/2] 验证端口已释放..." -ForegroundColor Cyan
    $apiStillListening = Test-PortListening -Port $API_PORT
    $webStillListening = Test-PortListening -Port $WEB_PORT

    if (-not $apiStillListening -and -not $webStillListening) {
        Write-Host "  [OK] 所有服务已停止" -ForegroundColor Green
        Write-Log -LogAction "stop" -Step "verify-stop" -Result "pass"
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  服务已停止" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Cyan
        return 0
    }

    # 部分端口仍被占用，列出占用 PID 供用户手动处理
    if ($apiStillListening) {
        $pid = Get-PortPid -Port $API_PORT
        Write-Host "  [WARN] 端口 $API_PORT 仍被占用 (PID=$pid)" -ForegroundColor Yellow
        Write-Host "         可手动执行：taskkill /F /T /PID $pid" -ForegroundColor Yellow
        Write-Log -LogAction "stop" -Step "verify-stop" -Result "fail" -Msg "api port=$API_PORT still listening pid=$pid"
    }
    if ($webStillListening) {
        $pid = Get-PortPid -Port $WEB_PORT
        Write-Host "  [WARN] 端口 $WEB_PORT 仍被占用 (PID=$pid)" -ForegroundColor Yellow
        Write-Host "         可手动执行：taskkill /F /T /PID $pid" -ForegroundColor Yellow
        Write-Log -LogAction "stop" -Step "verify-stop" -Result "fail" -Msg "web port=$WEB_PORT still listening pid=$pid"
    }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  部分进程可能仍在运行，请检查任务管理器" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
    return 1
}

# ============================================
# 动作：rebuild
# 顺序：停止 → 前端构建 → 启动（任一步失败立即终止）
# ============================================
function Action-Rebuild {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  重新构建 Karpathy-Wiki 前端 SPA" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # Step 1/3：停止服务（必须先停服，避免 vite 构建文件锁定）
    Write-Host ""
    Write-Host "[1/3] 停止当前服务..." -ForegroundColor Cyan
    $stopResult = Action-Stop
    if ($stopResult -ne 0) {
        Write-Host ""
        Write-Host "[ERROR] 停止服务失败，已终止重建流程" -ForegroundColor Red
        Write-Host "        请先手动释放 $API_PORT / $WEB_PORT 端口后再试" -ForegroundColor Yellow
        Write-Log -LogAction "rebuild" -Step "stop" -Result "fail" -Msg "stop failed, abort rebuild"
        return 1
    }
    Write-Log -LogAction "rebuild" -Step "stop" -Result "pass"

    # Step 2/3：前端构建
    Write-Host ""
    Write-Host "[2/3] 构建前端 SPA..." -ForegroundColor Cyan
    if (-not (Invoke-Bat -BatName "build-web.bat" -Action "rebuild")) {
        Write-Host ""
        Write-Host "[ERROR] 前端构建失败，未启动服务" -ForegroundColor Red
        Write-Host "        旧构建产物（如有）已保留，请检查 vite 错误输出" -ForegroundColor Yellow
        Write-Host "        可手动运行：scripts\build-web.bat 查看详细错误" -ForegroundColor Yellow
        Write-Log -LogAction "rebuild" -Step "build" -Result "fail" -Msg "build failed"
        return 1
    }

    # 验证构建产物
    if (-not (Test-Path -LiteralPath "api\public\index.html")) {
        Write-Host ""
        Write-Host "[ERROR] 构建完成但未找到 api\public\index.html" -ForegroundColor Red
        Write-Host "        请检查 vite.config.ts 的 outDir 配置" -ForegroundColor Yellow
        Write-Log -LogAction "rebuild" -Step "build" -Result "fail" -Msg "index.html not found after build"
        return 1
    }
    Write-Host "  [OK] 构建产物验证通过：api\public\index.html" -ForegroundColor Green
    Write-Log -LogAction "rebuild" -Step "build" -Result "pass"

    # Step 3/3：重新启动
    Write-Host ""
    Write-Host "[3/3] 启动服务..." -ForegroundColor Cyan
    $startResult = Action-Start
    if ($startResult -ne 0) {
        Write-Host ""
        Write-Host "[ERROR] 启动服务失败，构建产物已保留" -ForegroundColor Red
        Write-Host "        请检查后端日志与 api\config.json 配置" -ForegroundColor Yellow
        Write-Log -LogAction "rebuild" -Step "start" -Result "fail" -Msg "start failed after build"
        return 1
    }
    Write-Log -LogAction "rebuild" -Step "start" -Result "pass"

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  重新构建并启动完成" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    return 0
}

# ============================================
# 动作：check（仅检查，不启动）
# ============================================
function Action-Check {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Karpathy-Wiki 环境检查" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    $allPass = $true

    # 1. Node.js（路径已由脚本头部 Resolve-NodeExe 解析）
    Write-Host ""
    Write-Host "[1/11] Node.js..." -ForegroundColor Cyan
    if ($Script:NodeExe) {
        $nodeVer = & $Script:NodeExe --version 2>$null
        Write-Host "  [OK] Node.js $nodeVer ($($Script:NodeExe))" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 未检测到 Node.js（请检查 scripts/config.json 中 tools.node 配置）" -ForegroundColor Red
        $allPass = $false
    }

    # 2. 包管理器
    Write-Host ""
    Write-Host "[2/11] 包管理器..." -ForegroundColor Cyan
    $pkgCmd = $null
    if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
        $pkgCmd = "pnpm.cmd"
    }
    elseif (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        $pkgCmd = "npm.cmd"
    }
    if ($pkgCmd) {
        $pkgVer = & $pkgCmd --version 2>$null
        Write-Host "  [OK] $pkgCmd $pkgVer" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 未检测到 pnpm 或 npm" -ForegroundColor Red
        $allPass = $false
    }

    # 3. 根 node_modules
    Write-Host ""
    Write-Host "[3/11] 根 node_modules..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "node_modules") {
        Write-Host "  [OK] 存在" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 不存在，请运行 $pkgCmd install" -ForegroundColor Red
        $allPass = $false
    }

    # 4. 后端依赖
    Write-Host ""
    Write-Host "[4/11] 后端 api\node_modules..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "api\node_modules") {
        Write-Host "  [OK] 存在" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 不存在，请运行 $pkgCmd install" -ForegroundColor Red
        $allPass = $false
    }

    # 5. 前端依赖
    Write-Host ""
    Write-Host "[5/11] 前端 frontend\node_modules..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "frontend\node_modules") {
        Write-Host "  [OK] 存在" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 不存在，请运行 $pkgCmd install" -ForegroundColor Red
        $allPass = $false
    }

    # 6. 后端入口
    Write-Host ""
    Write-Host "[6/11] 后端入口 api\src\index.ts..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "api\src\index.ts") {
        Write-Host "  [OK] 存在" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 不存在" -ForegroundColor Red
        $allPass = $false
    }

    # 7. 前端入口
    Write-Host ""
    Write-Host "[7/11] 前端入口 frontend\index.html..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "frontend\index.html") {
        Write-Host "  [OK] 存在" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] 不存在" -ForegroundColor Red
        $allPass = $false
    }

    # 8. 构建产物（开发模式可选，生产模式必需）
    Write-Host ""
    Write-Host "[8/11] 构建产物 api\public\index.html..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "api\public\index.html") {
        Write-Host "  [OK] 存在（生产模式可启动）" -ForegroundColor Green
    }
    else {
        Write-Host "  [SKIP] 不存在（开发模式可选，生产模式需先运行 scripts\build-web.bat）" -ForegroundColor Yellow
    }

    # 9. 日志目录
    Write-Host ""
    Write-Host "[9/11] 日志目录 logs\..." -ForegroundColor Cyan
    if (Test-Path -LiteralPath "logs") {
        Write-Host "  [OK] 存在" -ForegroundColor Green
    }
    else {
        # 不存在则创建，避免后续启动失败
        New-Item -ItemType Directory -Path "logs" | Out-Null
        Write-Host "  [OK] 已自动创建" -ForegroundColor Green
    }

    # 10. 后端端口状态
    Write-Host ""
    Write-Host "[10/11] 后端端口 $API_PORT..." -ForegroundColor Cyan
    if (Test-PortListening -Port $API_PORT) {
        $apiPid = Get-PortPid -Port $API_PORT
        Write-Host "  [OCCUPIED] 已被占用 (PID=$apiPid)" -ForegroundColor Yellow
        Write-Host "             服务可能正在运行，或需先执行 -Action stop" -ForegroundColor Yellow
    }
    else {
        Write-Host "  [FREE] 端口空闲" -ForegroundColor Green
    }

    # 11. 前端端口状态
    Write-Host ""
    Write-Host "[11/11] 前端端口 $WEB_PORT..." -ForegroundColor Cyan
    if (Test-PortListening -Port $WEB_PORT) {
        $webPid = Get-PortPid -Port $WEB_PORT
        Write-Host "  [OCCUPIED] 已被占用 (PID=$webPid)" -ForegroundColor Yellow
        Write-Host "             服务可能正在运行，或需先执行 -Action stop" -ForegroundColor Yellow
    }
    else {
        Write-Host "  [FREE] 端口空闲" -ForegroundColor Green
    }

    # 汇总
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    if ($allPass) {
        Write-Host "  环境检查全部通过" -ForegroundColor Green
        Write-Log -LogAction "check" -Step "env-check" -Result "pass"
    }
    else {
        Write-Host "  环境检查存在失败项，请按上述提示修复" -ForegroundColor Red
        Write-Log -LogAction "check" -Step "env-check" -Result "fail"
    }
    Write-Host "========================================" -ForegroundColor Cyan

    if ($allPass) { return 0 } else { return 1 }
}

# ============================================
# 动作：status（查询端口与 PID）
# ============================================
function Action-Status {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Karpathy-Wiki 服务状态" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    # 后端 API
    if (Test-PortListening -Port $API_PORT) {
        $apiPid = Get-PortPid -Port $API_PORT
        Write-Host "  后端 API ($API_PORT)：[运行中] PID=$apiPid" -ForegroundColor Green
        Write-Log -LogAction "status" -Step "query-port" -Result "pass" -Msg "api port=$API_PORT pid=$apiPid"
    }
    else {
        Write-Host "  后端 API ($API_PORT)：[未运行]" -ForegroundColor Gray
        Write-Log -LogAction "status" -Step "query-port" -Result "skip" -Msg "api port=$API_PORT free"
    }

    # 前端 Web
    if (Test-PortListening -Port $WEB_PORT) {
        $webPid = Get-PortPid -Port $WEB_PORT
        Write-Host "  前端 Web ($WEB_PORT)：[运行中] PID=$webPid" -ForegroundColor Green
        Write-Log -LogAction "status" -Step "query-port" -Result "pass" -Msg "web port=$WEB_PORT pid=$webPid"
    }
    else {
        Write-Host "  前端 Web ($WEB_PORT)：[未运行]" -ForegroundColor Gray
        Write-Log -LogAction "status" -Step "query-port" -Result "skip" -Msg "web port=$WEB_PORT free"
    }

    Write-Host ""
    Write-Host "  健康检查：http://localhost:$API_PORT/health" -ForegroundColor White
    Write-Host "  访问入口：http://localhost:$WEB_PORT" -ForegroundColor White
    Write-Host "========================================" -ForegroundColor Cyan
    return 0
}

# ============================================
# 主入口：根据 Action 分发
# ============================================
Write-Log -LogAction $Action -Step "begin" -Result "pass"

$exitCode = 0
switch ($Action) {
    "start" { $exitCode = Action-Start }
    "stop" { $exitCode = Action-Stop }
    "rebuild" { $exitCode = Action-Rebuild }
    "check" { $exitCode = Action-Check }
    "status" { $exitCode = Action-Status }
}

Write-Log -LogAction $Action -Step "end" -Result $(if ($exitCode -eq 0) { "pass" } else { "fail" })

# PowerShell 退出码（0=成功，非0=失败）
exit $exitCode
