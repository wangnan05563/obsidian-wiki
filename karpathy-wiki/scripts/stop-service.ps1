#Requires -Version 5.1
# Karpathy-Wiki 服务停止主逻辑
# 对标闲鱼 logger.py 日志风格：颜色分明 + 日期时间 + 全局流水号
# 配置驱动：所有参数从 config.json 读取，无硬编码
# 分层架构：本脚本由 stop-service.bat 调用，bat 仅作入口

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json"
)

$ErrorActionPreference = "Stop"

# 加载配置
if (-not (Test-Path $ConfigPath)) { throw "配置文件不存在: $ConfigPath" }
$Config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 切换到项目根目录
$Root = (Resolve-Path (Join-Path $PSScriptRoot $Config.project.root)).Path
Set-Location $Root

# 加载共享日志模块
. (Join-Path $PSScriptRoot 'logger.ps1')
Initialize-Logger -Config $Config

$apiPort = [int]$Config.ports.api
$webPort = [int]$Config.ports.web
$pidDir = Join-Path $Root $Config.process.pid_dir

# ============================================================
# [1/3] 停止后端 API
# 对标闲鱼stop-service.bat [1/3] 逻辑
# ============================================================
Write-LogBanner -Title "$($Config.project.name) 停止流程 [会话: $($script:LogSessionId)]"
Write-Log "开始停止流程" -Level STEP -Step "1/3"
Write-Log "正在停止后端 API..." -Level INFO -Step "1/3"

$apiKilled = $false

# 优先通过 PID 文件停止（对标闲鱼通过 logs\web.pid 停止）
$apiPidFile = Join-Path $pidDir "api.pid"
if (Test-Path $apiPidFile) {
    $savedPid = (Get-Content $apiPidFile -Raw).Trim()
    if ($savedPid) {
        try { taskkill /F /T /PID $savedPid 2>&1 | Out-Null } catch { }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "API 已停止 (PID $savedPid，通过 PID 文件)" -Level OK -Step "1/3"
            $apiKilled = $true
        }
    }
    Remove-Item $apiPidFile -Force -ErrorAction SilentlyContinue
}

# 回退：通过端口扫描停止（对标闲鱼的端口扫描回退方案）
if (-not $apiKilled) {
    $apiPids = Get-PidOnPort -Port $apiPort
    foreach ($procId in $apiPids) {
        try { taskkill /F /T /PID $procId 2>&1 | Out-Null } catch { }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "API 已停止 (PID $procId，通过端口扫描)" -Level OK -Step "1/3"
            $apiKilled = $true
        }
    }
}

if (-not $apiKilled) {
    Write-Log "端口 $apiPort 无运行中的 API 进程" -Level SKIP -Step "1/3"
}

# ============================================================
# [2/3] 停止前端 Web
# 对标闲鱼stop-service.bat [2/3] 逻辑
# ============================================================
Write-Log "正在停止前端 Web..." -Level INFO -Step "2/3"

$webKilled = $false

# 优先通过 PID 文件停止
$webPidFile = Join-Path $pidDir "web.pid"
if (Test-Path $webPidFile) {
    $savedPid = (Get-Content $webPidFile -Raw).Trim()
    if ($savedPid) {
        try { taskkill /F /T /PID $savedPid 2>&1 | Out-Null } catch { }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Web 已停止 (PID $savedPid，通过 PID 文件)" -Level OK -Step "2/3"
            $webKilled = $true
        }
    }
    Remove-Item $webPidFile -Force -ErrorAction SilentlyContinue
}

# 回退：通过端口扫描停止
if (-not $webKilled) {
    $webPids = Get-PidOnPort -Port $webPort
    foreach ($procId in $webPids) {
        try { taskkill /F /T /PID $procId 2>&1 | Out-Null } catch { }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Web 已停止 (PID $procId，通过端口扫描)" -Level OK -Step "2/3"
            $webKilled = $true
        }
    }
}

if (-not $webKilled) {
    Write-Log "端口 $webPort 无运行中的 Web 进程" -Level SKIP -Step "2/3"
}

# 通过窗口标题清理残留进程（对标闲鱼 taskkill /FI WINDOWTITLE 逻辑）
try { taskkill /F /FI "WINDOWTITLE eq $($Config.process.api_window_title)*" 2>&1 | Out-Null } catch { }
try { taskkill /F /FI "WINDOWTITLE eq $($Config.process.web_window_title)*" 2>&1 | Out-Null } catch { }

# 通过命令行匹配清理残留的日志重定向进程树
# 为什么需要：start-service.ps1 用 Start-Process cmd.exe 启动的日志重定向进程（pnpm run dev:api > api-dev.log 2>&1）
# 不监听端口，端口扫描找不到它；当主进程被杀后它可能成为孤儿，持续持有日志文件句柄
$strayProcs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
        $_.CommandLine -like "*$Root*" -and ($_.CommandLine -like "*dev:api*" -or $_.CommandLine -like "*dev:web*")
    )
}
foreach ($p in $strayProcs) {
    try { taskkill /F /T /PID $p.ProcessId 2>&1 | Out-Null } catch { }
    if ($LASTEXITCODE -eq 0) {
        Write-Log "已清理残留进程 (PID $($p.ProcessId), $($p.Name))" -Level OK -Step "2/3"
    }
}

Start-Sleep -Seconds $Config.shutdown.verify_wait_seconds

# ============================================================
# [3/3] 验证端口已释放
# 对标闲鱼stop-service.bat [3/3] 逻辑
# ============================================================
Write-Log "正在验证停止结果..." -Level INFO -Step "3/3"

$allFree = $true

$apiPids = Get-PidOnPort -Port $apiPort
if ($apiPids.Count -gt 0) {
    $allFree = $false
    Write-Log "端口 $apiPort 仍被占用 (PID: $($apiPids -join ', '))" -Level WARN -Step "3/3"
}

$webPids = Get-PidOnPort -Port $webPort
if ($webPids.Count -gt 0) {
    $allFree = $false
    Write-Log "端口 $webPort 仍被占用 (PID: $($webPids -join ', '))" -Level WARN -Step "3/3"
}

if ($allFree) {
    Write-Log "所有服务已成功停止，端口已释放" -Level OK -Step "3/3"
} else {
    Write-Log "部分进程可能仍在运行，请检查任务管理器手动清理" -Level WARN -Step "3/3"
}

# ============================================================
# 停止完成
# ============================================================
Write-LogBanner -Title "$($Config.project.name) 服务已停止 [会话: $($script:LogSessionId)]"
Write-Log "会话流水号: $($script:LogSessionId)（本次停止操作的完整日志标识）" -Level INFO

Start-Sleep -Seconds $Config.shutdown.exit_delay_seconds
exit 0
