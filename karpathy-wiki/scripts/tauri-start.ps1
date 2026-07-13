#Requires -Version 5.1
# scripts/tauri-start.ps1
# Tauri 桌面应用启动服务脚本
# 步骤：环境配置 → 清理旧进程 → tauri dev → 等待 sidecar 就绪
# tauri dev 会：编译 Rust + spawn sidecar (Node.js 后端) + 打开主窗口和悬浮窗口
# 配置驱动：所有路径从 config.json 读取

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$SkipClean,
    [switch]$NoBrowser
)

# 加载共享模块
. (Join-Path $PSScriptRoot 'tauri-common.ps1')

$env = Initialize-TauriEnvironment -ConfigPath $ConfigPath
$Config = $env.Config

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Karpathy-Wiki Tauri Dev (Start Service)" -ForegroundColor Cyan
Write-Host "  项目目录: $($env.ProjectRoot)" -ForegroundColor DarkGray
Write-Host "  desktop:  $($Config.tauri.desktop_dir)" -ForegroundColor DarkGray
Write-Host "  端口:     $($Config.tauri.port)" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""

# ============================================================
# [1/4] 验证环境
# ============================================================
Write-TauriStep "[1/4] 验证环境..."

if (-not (Test-ToolAvailable 'pnpm.cmd') -and -not (Test-ToolAvailable 'pnpm')) {
    Write-TauriErr "pnpm 不可用，请先运行 scripts\setup-env.bat"
    exit 1
}
Write-TauriOk "pnpm 可用"

$desktopDir = Join-Path $env.ProjectRoot $Config.tauri.desktop_dir
if (-not (Test-Path $desktopDir)) {
    Write-TauriErr "desktop 目录不存在: $desktopDir"
    exit 1
}
Write-TauriOk "desktop 目录: $desktopDir"

if (-not (Test-Path $env.WrapperExe)) {
    Write-TauriErr "windres.exe wrapper 缺失"
    Write-TauriWarn "请先运行 scripts\tauri-setup.bat"
    exit 1
}
Write-TauriOk "windres wrapper 就绪"

# ============================================================
# [2/4] 清理旧进程
# ============================================================
if (-not $SkipClean) {
    Write-TauriStep "[2/4] 清理旧进程..."

    $exeName = $Config.tauri.exe_name -replace '\.exe$', ''
    $port = [int]$Config.tauri.port

    # 杀掉残留的 desktop.exe
    $oldDesktop = Get-Process -Name $exeName -ErrorAction SilentlyContinue
    if ($oldDesktop) {
        foreach ($p in $oldDesktop) {
            Write-TauriStep "  杀掉旧 desktop 进程 (PID $($p.Id))"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }

    # 杀掉占用端口的进程（sidecar 子进程链）
    # 为什么不只杀 PID 文件：sidecar 启动的进程链可能在 PID 文件失效后仍残留
    $netstatOutput = netstat -aon 2>$null | Select-String ":$port.*LISTENING"
    if ($netstatOutput) {
        $portPids = @()
        foreach ($line in $netstatOutput) {
            $parts = $line -split '\s+'
            $procId = $parts[$parts.Length - 1]
            if ($procId -match '^\d+$' -and $portPids -notcontains $procId) {
                $portPids += $procId
            }
        }
        foreach ($procId in $portPids) {
            Write-TauriStep "  杀掉端口 $port 占用进程 (PID $procId)"
            taskkill /F /T /PID $procId 2>$null | Out-Null
        }
        Start-Sleep -Seconds 2
    }

    # 清理 sidecar 启动的 node 进程（匹配 dev:api / tsx / index.ts）
    # 为什么扫描命令行：sidecar 通过 cmd /C pnpm run dev:api 启动，进程链可能残留
    Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'tsx.*index.ts|pnpm.*dev:api|pnpm.*@karpathy' } |
        ForEach-Object {
            # 排除当前 PowerShell 进程及其父进程
            if ($_.ProcessId -ne $PID -and $_.ParentProcessId -ne $PID) {
                Write-TauriStep "  杀掉 sidecar 残留进程 (PID $($_.ProcessId), $($_.Name))"
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }

    Write-TauriOk "旧进程清理完成"
} else {
    Write-TauriStep "[2/4] 跳过清理 (-SkipClean)"
}

# 确保 logs 目录存在
$logsDir = Join-Path $env.ProjectRoot "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Force $logsDir | Out-Null
}

# ============================================================
# [3/4] 启动 tauri dev
# ============================================================
Write-TauriStep "[3/4] 启动 tauri dev..."
Write-TauriWarn "首次编译需要 1-3 分钟，请耐心等待"
Write-TauriWarn "tauri dev 会: 编译 Rust → spawn sidecar (Node.js 后端) → 打开主窗口 + 悬浮窗口"
Write-Host ""

Set-Location $desktopDir

# 后台启动 tauri dev，日志重定向到文件
$logFile = Join-Path $env.ProjectRoot $Config.tauri.log_file
if (Test-Path $logFile) { Remove-Item $logFile -Force }
$logErrFile = "$logFile.err"
if (Test-Path $logErrFile) { Remove-Item $logErrFile -Force }

$devScript = $Config.tauri.dev_script
$proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList "run", $devScript -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $logErrFile -NoNewWindow
$tauriPid = $proc.Id
Write-TauriOk "tauri dev 已启动 (PID $tauriPid)"
Write-TauriStep "日志: $logFile (stdout) + $logErrFile (stderr)"

# 记录 PID 到文件
$pidFile = Join-Path $env.ProjectRoot $Config.tauri.pid_file
$tauriPid | Out-File $pidFile -Encoding ASCII

# ============================================================
# [4/4] 等待 sidecar 就绪
# ============================================================
Write-TauriStep "[4/4] 等待 sidecar (Node.js 后端) 就绪..."

$port = [int]$Config.tauri.port
$healthPath = $Config.tauri.health_check_path
$healthUrl = "http://localhost:$port$healthPath"
$maxTries = [int]$Config.tauri.health_check_max_tries
$interval = [int]$Config.tauri.ping_interval_seconds

$ready = $false
for ($i = 1; $i -le $maxTries; $i++) {
    # 检查 tauri dev 父进程是否仍在运行
    $tauriProc = Get-Process -Id $tauriPid -ErrorAction SilentlyContinue
    if (-not $tauriProc) {
        # tauri dev 可能已退出（编译失败或 cargo 子进程异常）
        # 检查是否有编译错误
        $errContent = if (Test-Path $logErrFile) { Get-Content $logErrFile -Raw -ErrorAction SilentlyContinue } else { "" }
        $outContent = if (Test-Path $logFile) { Get-Content $logFile -Raw -ErrorAction SilentlyContinue } else { "" }
        $combined = "$outContent`n$errContent"

        if ($combined -match 'error\[|panicked|cannot find|failed to compile') {
            Write-TauriErr "tauri dev 编译失败"
            Write-Host ""
            Write-Host "==== 日志尾部 ====" -ForegroundColor Yellow
            $errTail = Get-Content $logErrFile -Tail 20 -ErrorAction SilentlyContinue
            $outTail = Get-Content $logFile -Tail 10 -ErrorAction SilentlyContinue
            $outTail | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
            $errTail | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            Write-Host "==================" -ForegroundColor Yellow
            Write-TauriErr "完整日志: $logErrFile"
        } else {
            Write-TauriErr "tauri dev 进程已退出（未知原因）"
            Write-TauriStep "查看日志: $logFile"
        }
        exit 1
    }

    # 检查 desktop.exe 是否已启动（编译完成）
    $exeName = $Config.tauri.exe_name -replace '\.exe$', ''
    $desktopProc = Get-Process -Name $exeName -ErrorAction SilentlyContinue
    if (-not $desktopProc) {
        Write-TauriStep "  [$i/$maxTries] 等待编译完成...（tauri dev PID $tauriPid 仍在运行）"
        Start-Sleep -Seconds $interval
        continue
    }

    # desktop.exe 已启动，检查 sidecar 端口
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            $ready = $true
            Write-TauriOk "sidecar 就绪: $healthUrl -> $($response.StatusCode)"
            break
        }
    } catch {
        Write-TauriStep "  [$i/$maxTries] desktop.exe 已启动，等待 sidecar 端口就绪..."
    }

    Start-Sleep -Seconds $interval
}

if (-not $ready) {
    Write-TauriErr "sidecar 在 $($maxTries * $interval) 秒内未就绪"
    Write-TauriErr "可能原因:"
    Write-TauriErr "  1. sidecar 启动失败（端口冲突、配置错误）"
    Write-TauriErr "  2. sidecar 健康检查端点不匹配（config: $healthPath）"
    Write-TauriErr "  3. Node.js 后端崩溃"
    Write-Host ""
    Write-TauriStep "日志尾部 (stdout):"
    if (Test-Path $logFile) {
        Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    }
    Write-TauriStep "日志尾部 (stderr):"
    if (Test-Path $logErrFile) {
        Get-Content $logErrFile -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    }
    Write-TauriWarn "desktop.exe 可能仍在前台运行，可手动检查"
    exit 1
}

# ============================================================
# 启动完成
# ============================================================
$exeName = $Config.tauri.exe_name -replace '\.exe$', ''
$desktopProc = Get-Process -Name $exeName -ErrorAction SilentlyContinue | Select-Object -First 1
$desktopPid = if ($desktopProc) { $desktopProc.Id } else { "未知" }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Tauri Dev 服务已启动" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Tauri desktop PID: $desktopPid" -ForegroundColor Gray
Write-Host "  tauri dev PID:    $tauriPid" -ForegroundColor Gray
Write-Host "  Sidecar URL:      http://localhost:$port" -ForegroundColor Gray
Write-Host "  健康检查:         $healthUrl" -ForegroundColor Gray
Write-Host "  日志:             $logFile" -ForegroundColor Gray
Write-Host "  PID 文件:         $pidFile" -ForegroundColor Gray
Write-Host ""
Write-Host "  停止服务: 双击 scripts\tauri-stop.bat" -ForegroundColor Yellow
Write-Host ""

exit 0
