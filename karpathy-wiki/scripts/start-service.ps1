#Requires -Version 5.1
# Karpathy-Wiki 服务启动主逻辑
# 对标闲鱼 logger.py 日志风格：颜色分明 + 日期时间 + 全局流水号
# 配置驱动：所有参数从 config.json 读取，无硬编码
# 分层架构：本脚本由 启动服务.bat 调用，bat 仅作入口

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$ApiOnly,
    [switch]$WebOnly
)

$ErrorActionPreference = "Stop"

# 加载配置（对标闲鱼 config.py 的 get_settings()）
if (-not (Test-Path $ConfigPath)) { throw "配置文件不存在: $ConfigPath" }
$Config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 切换到项目根目录（config.project.root 是相对 scripts/ 的路径）
$Root = (Resolve-Path (Join-Path $PSScriptRoot $Config.project.root)).Path
Set-Location $Root

# 加载共享日志模块（dot-source，函数进入当前作用域）
. (Join-Path $PSScriptRoot 'logger.ps1')
Initialize-Logger -Config $Config

# ============================================================
# [1/4] 清理旧进程：通过端口扫描杀掉占用 API/Web 端口的进程
# 对标闲鱼启动服务.bat [1/4] 逻辑
# ============================================================
Write-LogBanner -Title "$($Config.project.name) 启动流程 [会话: $($script:LogSessionId)]"
Write-Log "开始启动流程，会话流水号: $($script:LogSessionId)" -Level STEP -Step "1/4"
Write-Log "正在清理旧进程..." -Level INFO -Step "1/4"

$apiPort = [int]$Config.ports.api
$webPort = [int]$Config.ports.web

# 清理 API 端口上的进程
$apiPids = Get-PidOnPort -Port $apiPort
foreach ($procId in $apiPids) {
    taskkill /F /T /PID $procId >$null 2>&1
    Write-Log "已清理 API 端口 $apiPort 上的进程 (PID $procId)" -Level OK -Step "1/4"
}

# 清理 Web 端口上的进程
$webPids = Get-PidOnPort -Port $webPort
foreach ($procId in $webPids) {
    taskkill /F /T /PID $procId >$null 2>&1
    Write-Log "已清理 Web 端口 $webPort 上的进程 (PID $procId)" -Level OK -Step "1/4"
}

if ($apiPids.Count -eq 0 -and $webPids.Count -eq 0) {
    Write-Log "无残留进程需要清理" -Level SKIP -Step "1/4"
}

Start-Sleep -Seconds 1

# ============================================================
# [2/4] 检查依赖：Node.js + node_modules + 包管理器
# 对标闲鱼启动服务.bat [2/4] 逻辑
# ============================================================
Write-Log "正在检查依赖..." -Level INFO -Step "2/4"

# 检查 Node.js（对标闲鱼检查 .venv\Scripts\python.exe）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Log "未检测到 Node.js，请先运行 scripts\环境配置.bat 安装" -Level ERROR -Step "2/4"
    exit 1
}
$nodeVer = & node --version
Write-Log "Node.js 版本: $nodeVer (路径: $($nodeCmd.Source))" -Level OK -Step "2/4"

# 检查 node_modules（对标闲鱼检查 .venv 虚拟环境）
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Log "node_modules 不存在，请先运行 scripts\环境配置.bat" -Level ERROR -Step "2/4"
    exit 1
}
Write-Log "node_modules 已就绪" -Level OK -Step "2/4"

# 检测包管理器：auto 表示自动检测 pnpm > npm
# 对标闲鱼启动脚本中的 PKG_CMD 检测逻辑
$pkgManager = $Config.commands.pkg_manager
if ($pkgManager -eq 'auto') {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        $pkgManager = 'pnpm'
    } else {
        $pkgManager = 'npm'
    }
}
Write-Log "包管理器: $pkgManager" -Level OK -Step "2/4"

# 确保 PID 目录存在（对标闲鱼 if not exist "logs" mkdir logs）
$pidDir = Join-Path $Root $Config.process.pid_dir
if (-not (Test-Path $pidDir)) {
    New-Item -ItemType Directory -Path $pidDir -Force | Out-Null
    Write-Log "已创建 PID 目录: $pidDir" -Level OK -Step "2/4"
}

# ============================================================
# [3/4] 启动 API + Web 服务
# 对标闲鱼启动服务.bat [3/4] 逻辑
# ============================================================
Write-Log "正在启动服务..." -Level INFO -Step "3/4"

$apiCmd = $Config.commands.api_cmd
$webCmd = $Config.commands.web_cmd
$apiTitle = $Config.process.api_window_title
$webTitle = $Config.process.web_window_title

# 启动后端 API
if (-not $WebOnly) {
    Write-Log "启动后端 API: $pkgManager run $apiCmd" -Level INFO -Step "3/4"
    # chcp 65001 匹配 Node.js UTF-8 stdout，避免子进程中文输出乱码
    # 对标闲鱼启动脚本中的 chcp 65001 处理
    $apiScript = "Set-Location '$Root'; chcp 65001 > `$null; Write-Host '后端 API - http://localhost:$apiPort' -ForegroundColor Green; $pkgManager run $apiCmd"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $apiScript

    # 等待 API 端口就绪（对标闲鱼 :wait_web 循环）
    $maxTries = [int]$Config.startup.api_wait_max_tries
    $interval = [int]$Config.startup.ping_interval_seconds
    Write-Log "等待 API 端口 $apiPort 就绪（最多 $maxTries 次探测，每次 ${interval}s）..." -Level INFO -Step "3/4"
    $ready = Wait-PortReady -Port $apiPort -MaxTries $maxTries -IntervalSeconds $interval
    if (-not $ready) {
        $totalWait = $maxTries * $interval
        Write-Log "API 在 ${totalWait}s 内未启动成功" -Level ERROR -Step "3/4"
        Write-Log "请查看弹出的 API 窗口中的错误信息" -Level ERROR -Step "3/4"
        exit 1
    }
    $apiPids = Get-PidOnPort -Port $apiPort
    Write-Log "API 已就绪: http://localhost:$apiPort (PID: $($apiPids -join ', '))" -Level OK -Step "3/4"

    # 记录 API PID 到文件（对标闲鱼 echo %%a> "logs\web.pid"）
    $apiPids | Select-Object -First 1 | Out-File (Join-Path $pidDir "api.pid") -Encoding ASCII
}

# 启动前端 Web
if (-not $ApiOnly) {
    Write-Log "启动前端 Web: $pkgManager run $webCmd" -Level INFO -Step "3/4"
    $webScript = "Set-Location '$Root'; chcp 65001 > `$null; Write-Host '前端 Web - http://localhost:$webPort' -ForegroundColor Green; $pkgManager run $webCmd"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $webScript

    # 等待 Web 端口就绪
    $maxTries = [int]$Config.startup.web_wait_max_tries
    $interval = [int]$Config.startup.ping_interval_seconds
    Write-Log "等待 Web 端口 $webPort 就绪（最多 $maxTries 次探测，每次 ${interval}s）..." -Level INFO -Step "3/4"
    $ready = Wait-PortReady -Port $webPort -MaxTries $maxTries -IntervalSeconds $interval
    if (-not $ready) {
        Write-Log "前端 Web 启动超时，可稍后手动访问 http://localhost:$webPort" -Level WARN -Step "3/4"
    } else {
        $webPids = Get-PidOnPort -Port $webPort
        Write-Log "Web 已就绪: http://localhost:$webPort (PID: $($webPids -join ', '))" -Level OK -Step "3/4"
        $webPids | Select-Object -First 1 | Out-File (Join-Path $pidDir "web.pid") -Encoding ASCII
    }
}

# ============================================================
# [4/4] 验证服务存活
# 对标闲鱼启动服务.bat [4/4] 逻辑
# ============================================================
Write-Log "正在验证服务..." -Level INFO -Step "4/4"

if (-not $WebOnly) {
    $apiPids = Get-PidOnPort -Port $apiPort
    if ($apiPids.Count -gt 0) {
        Write-Log "API 服务运行中 (PID: $($apiPids -join ', '))" -Level OK -Step "4/4"
    } else {
        Write-Log "API 服务未运行！" -Level FAIL -Step "4/4"
        exit 1
    }
}

if (-not $ApiOnly) {
    $webPids = Get-PidOnPort -Port $webPort
    if ($webPids.Count -gt 0) {
        Write-Log "Web 服务运行中 (PID: $($webPids -join ', '))" -Level OK -Step "4/4"
    } else {
        Write-Log "Web 服务未运行！" -Level WARN -Step "4/4"
    }
}

# ============================================================
# 启动完成：输出会话总结
# ============================================================
Write-LogBanner -Title "$($Config.project.name) 服务已启动 [会话: $($script:LogSessionId)]"
Write-Log "后端 API: http://localhost:$apiPort" -Level INFO
Write-Log "前端 Web: http://localhost:$webPort" -Level INFO
Write-Log "健康检查: http://localhost:$apiPort$($Config.commands.health_check_path)" -Level INFO
Write-Log "停止服务: 双击 scripts\停止服务.bat" -Level INFO
Write-Log "会话流水号: $($script:LogSessionId)（排障时可用此号定位本次启动所有日志）" -Level INFO

# 打开浏览器
if ([bool]$Config.startup.open_browser -and -not $ApiOnly) {
    Write-Log "正在打开浏览器: $($Config.startup.browser_url)" -Level INFO
    Start-Process $Config.startup.browser_url
}

exit 0
