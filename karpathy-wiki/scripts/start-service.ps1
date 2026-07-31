#Requires -Version 5.1
# Karpathy-Wiki 服务启动主逻辑
# 对标闲鱼 logger.py 日志风格：颜色分明 + 日期时间 + 全局流水号
# 配置驱动：所有参数从 config.json 读取，无硬编码
# 分层架构：本脚本由 start-service.bat 调用，bat 仅作入口

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

# 加载 node 路径解析模块（配置驱动，使用 tools.node.exe_path 指定的 node）
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
$NodeExe = Resolve-NodeExe -Config $Config
# 将 node.exe 所在目录加入 PATH 头部，让后续 pnpm/npm 自动找到指定版本
if ($NodeExe) { Invoke-WithNodePath -NodeExePath $NodeExe }

# ============================================================
# [1/4] 清理旧进程：通过端口扫描杀掉占用 API/Web 端口的进程
# 对标闲鱼start-service.bat [1/4] 逻辑
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
    Write-Log "端口扫描无残留进程" -Level SKIP -Step "1/4"
}

# 命令行匹配兜底清理：捕获未绑定端口但仍占用资源的 tsx watch / vite 残留进程
# 为什么需要：多个 tsx watch 进程竞争同一端口时，均未成功 LISTENING，
# 端口扫描（Get-PidOnPort）返回空但进程仍在运行，新进程启动后立即被抢占导致 exit -1
# 匹配模式覆盖三种调用路径：pnpm run dev:api / node tsx/dist/cli.mjs / node vite/bin/vite.js
$strayProcs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*$Root*" -and (
        $_.CommandLine -like "*dev:api*" -or
        $_.CommandLine -like "*dev:web*" -or
        $_.CommandLine -match "tsx.*src/index\.ts" -or
        $_.CommandLine -match "vite.*bin/vite"
    )
}
foreach ($p in $strayProcs) {
    try { taskkill /F /T /PID $p.ProcessId 2>&1 | Out-Null } catch { }
    if ($LASTEXITCODE -eq 0) {
        Write-Log "已清理残留进程 (PID $($p.ProcessId), $($p.Name))" -Level OK -Step "1/4"
    }
}

Start-Sleep -Seconds 1

# ============================================================
# [2/4] 检查依赖：Node.js + node_modules + 包管理器
# 对标闲鱼start-service.bat [2/4] 逻辑
# ============================================================
Write-Log "正在检查依赖..." -Level INFO -Step "2/4"

# 检查 Node.js（路径已由脚本头部 Resolve-NodeExe 解析，避免 PATH 旧版优先）
if (-not $NodeExe) {
    Write-Log "未检测到 Node.js，请检查 scripts/config.json 中 tools.node 配置或运行 scripts\setup-env.bat 安装" -Level ERROR -Step "2/4"
    exit 1
}
$nodeVer = & $NodeExe --version
Write-Log "Node.js 版本: $nodeVer (路径: $NodeExe)" -Level OK -Step "2/4"

# 检查 node_modules（对标闲鱼检查 .venv 虚拟环境）
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Log "node_modules 不存在，请先运行 scripts\setup-env.bat" -Level ERROR -Step "2/4"
    exit 1
}
Write-Log "node_modules 已就绪" -Level OK -Step "2/4"

# 检测包管理器：auto 表示自动检测 pnpm > npm
# 对标闲鱼启动脚本中的 PKG_CMD 检测逻辑
$pkgManager = $Config.commands.pkg_manager
if ($pkgManager -eq 'auto') {
    if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
        $pkgManager = 'pnpm.cmd'
    } else {
        $pkgManager = 'npm.cmd'
    }
} elseif ($pkgManager -eq 'pnpm') {
    $pkgManager = 'pnpm.cmd'
} elseif ($pkgManager -eq 'npm') {
    $pkgManager = 'npm.cmd'
}
if (-not (Get-Command $pkgManager -ErrorAction SilentlyContinue)) {
    Write-Log "包管理器不可用: $pkgManager" -Level ERROR -Step "2/4"
    exit 1
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
# 对标闲鱼start-service.bat [3/4] 逻辑
# ============================================================
Write-Log "正在启动服务..." -Level INFO -Step "3/4"

$apiCmd = $Config.commands.api_cmd
$webCmd = $Config.commands.web_cmd
$apiTitle = $Config.process.api_window_title
$webTitle = $Config.process.web_window_title

# 启动后端 API
if (-not $WebOnly) {
    Write-Log "启动后端 API: $pkgManager run $apiCmd" -Level INFO -Step "3/4"

    $apiWindowMode = $Config.startup.api_window_mode
    if ($apiWindowMode -eq 'foreground') {
        # 前台弹窗模式：用户可实时查看彩色滚动日志，方便排查反馈
        $apiTitle = $Config.process.api_window_title
        $apiScript = @"
`$host.UI.RawUI.WindowTitle = '$apiTitle'
Set-Location '$Root'
chcp 65001 > `$null
`$host.UI.RawUI.ForegroundColor = 'White'
Write-Host ''
Write-Host '  ================================================' -ForegroundColor DarkCyan
Write-Host '    Karpathy-Wiki  后端 API 服务' -ForegroundColor Cyan
Write-Host '  ================================================' -ForegroundColor DarkCyan
Write-Host '    URL:  http://localhost:$apiPort' -ForegroundColor Green
Write-Host '    日志: 实时输出如下（滚动查看）' -ForegroundColor Yellow
Write-Host '  ================================================' -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  [TIP] 如遇错误，请滚动至错误行（红色），右键标记复制' -ForegroundColor DarkGray
Write-Host ''
$pkgManager run $apiCmd
Write-Host ''
Write-Host '  ================================================' -ForegroundColor DarkRed
Write-Host '    [!] API 服务已停止' -ForegroundColor Red
Write-Host '  ================================================' -ForegroundColor DarkRed
Write-Host '  如非预期停止，请复制上方错误信息反馈' -ForegroundColor Yellow
Write-Host ''
Write-Host '  按任意键关闭此窗口...' -ForegroundColor DarkGray
`$null = `$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
"@
        Start-Process powershell -ArgumentList "-NoExit", "-Command", $apiScript
    } else {
        # 静默模式：后台运行，日志写入文件（不弹窗）
        # 为什么先判断配置是否存在再 Join-Path：Join-Path 遇到 $null 会抛异常，无法走 fallback
        $apiLogRelPath = if ($Config.startup.api_log_file) { $Config.startup.api_log_file } else { 'logs/api-dev.log' }
        $apiLogFile = Join-Path $Root $apiLogRelPath
        $apiLogDir = Split-Path $apiLogFile -Parent
        if (-not (Test-Path $apiLogDir)) { New-Item -ItemType Directory -Path $apiLogDir -Force | Out-Null }
        # 清空旧日志避免新旧日志混淆（与 Web silent 分支保持一致）
        # 为什么用 try/catch 兜底：taskkill 后文件句柄可能尚未完全释放，Remove-Item 会失败；
        # 此时改用 Clear-Content 清空内容，避免阻塞启动。两者都失败时 > 重定向仍会覆盖。
        if (Test-Path $apiLogFile) {
            try { Remove-Item $apiLogFile -Force -ErrorAction Stop }
            catch {
                try { Clear-Content -LiteralPath $apiLogFile -Force -ErrorAction Stop }
                catch { Write-Log "旧日志文件被占用，将以追加模式写入: $apiLogFile" -Level WARN -Step "3/4" }
            }
        }
        Start-Process cmd.exe -ArgumentList "/c", "$pkgManager run $apiCmd > `"$apiLogFile`" 2>&1" -WorkingDirectory $Root -WindowStyle Hidden
        Write-Log "API 后台运行（静默），日志文件: $apiLogFile" -Level INFO -Step "3/4"
    }

    # 等待 API 端口就绪（对标闲鱼 :wait_web 循环）
    $maxTries = [int]$Config.startup.api_wait_max_tries
    $interval = [int]$Config.startup.ping_interval_seconds
    Write-Log "等待 API 端口 $apiPort 就绪（最多 $maxTries 次探测，每次 ${interval}s）..." -Level INFO -Step "3/4"
    $ready = Wait-PortReady -Port $apiPort -MaxTries $maxTries -IntervalSeconds $interval
    if (-not $ready) {
        $totalWait = $maxTries * $interval
        Write-Log "API 在 ${totalWait}s 内未启动成功" -Level ERROR -Step "3/4"
        # 为什么区分窗口模式给提示：foreground 看弹窗、silent 看日志文件，指向正确位置才能快速排障
        if ($apiWindowMode -eq 'foreground') {
            Write-Log "请查看弹出的 API 窗口中的错误信息" -Level ERROR -Step "3/4"
        } else {
            Write-Log "请查看日志文件: $apiLogFile" -Level ERROR -Step "3/4"
            # 输出日志尾部便于快速定位（对标诊断流程 E 的健壮性检查清单）
            if (Test-Path $apiLogFile) {
                Write-Log "===== 日志尾部 30 行 =====" -Level WARN -Step "3/4"
                Get-Content $apiLogFile -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
                Write-Log "=========================" -Level WARN -Step "3/4"
            } else {
                Write-Log "日志文件未生成，进程可能在启动时崩溃" -Level ERROR -Step "3/4"
            }
        }
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

    $webWindowMode = $Config.startup.web_window_mode
    if ($webWindowMode -eq 'foreground') {
        # 前台弹窗模式
        $webTitle = $Config.process.web_window_title
        $webScript = @"
`$host.UI.RawUI.WindowTitle = '$webTitle'
Set-Location '$Root'
chcp 65001 > `$null
Write-Host ''
Write-Host '  ================================================' -ForegroundColor DarkCyan
Write-Host '    Karpathy-Wiki  前端 Web 服务' -ForegroundColor Cyan
Write-Host '  ================================================' -ForegroundColor DarkCyan
Write-Host '    URL:  http://localhost:$webPort' -ForegroundColor Green
Write-Host '    日志: 实时输出如下' -ForegroundColor Yellow
Write-Host '  ================================================' -ForegroundColor DarkCyan
Write-Host ''
$pkgManager run $webCmd
"@
        Start-Process powershell -ArgumentList "-NoExit", "-Command", $webScript
    } else {
        # 静默模式：后台运行，日志写入文件（不弹窗）
        $webLogFile = Join-Path $Root ($Config.startup.web_log_file)
        $webLogDir = Split-Path $webLogFile -Parent
        if (-not (Test-Path $webLogDir)) { New-Item -ItemType Directory -Path $webLogDir -Force | Out-Null }
        # 清空旧日志避免混淆（与 API silent 分支保持一致的容错策略）
        if (Test-Path $webLogFile) {
            try { Remove-Item $webLogFile -Force -ErrorAction Stop }
            catch {
                try { Clear-Content -LiteralPath $webLogFile -Force -ErrorAction Stop }
                catch { Write-Log "旧日志文件被占用，将以追加模式写入: $webLogFile" -Level WARN -Step "3/4" }
            }
        }
        Start-Process cmd.exe -ArgumentList "/c", "$pkgManager run $webCmd > `"$webLogFile`" 2>&1" -WorkingDirectory $Root -WindowStyle Hidden
        Write-Log "Web 后台运行（静默），日志文件: $webLogFile" -Level INFO -Step "3/4"
    }

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
# 对标闲鱼start-service.bat [4/4] 逻辑
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
if (-not $WebOnly) {
    if ($apiWindowMode -eq 'foreground') {
        Write-Log "实时日志: 查看「$apiTitle」窗口（彩色滚动日志）" -Level INFO
    } else {
        Write-Log "API 日志: $apiLogFile" -Level INFO
    }
}
if (-not $ApiOnly) {
    if ($webWindowMode -eq 'foreground') {
        Write-Log "实时日志: 查看「$webTitle」窗口" -Level INFO
    } else {
        Write-Log "Web 日志: $webLogFile" -Level INFO
    }
}
Write-Log "停止服务: 双击 scripts\stop-service.bat" -Level INFO
Write-Log "会话流水号: $($script:LogSessionId)（排障时可用此号定位本次启动所有日志）" -Level INFO

# 打开浏览器
if ([bool]$Config.startup.open_browser -and -not $ApiOnly) {
    Write-Log "正在打开浏览器: $($Config.startup.browser_url)" -Level INFO
    Start-Process $Config.startup.browser_url
}

exit 0
