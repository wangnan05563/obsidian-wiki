#Requires -Version 5.1
# scripts/tauri-stop.ps1
# Tauri 桌面应用停止服务脚本
# 杀掉 karpathy-wiki-desktop.exe + sidecar 子进程链（cmd/pnpm/tsx/node）
# 配置驱动：所有路径从 config.json 读取

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json"
)

# 加载共享模块
. (Join-Path $PSScriptRoot 'tauri-common.ps1')

$env = Initialize-TauriEnvironment -ConfigPath $ConfigPath
$Config = $env.Config

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Karpathy-Wiki Tauri Stop Service" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""

# ============================================================
# [1/4] 停止 desktop.exe（Tauri 主进程）
# ============================================================
Write-TauriStep "[1/4] 停止 desktop.exe (Tauri 主进程)..."

$exeName = $Config.tauri.exe_name -replace '\.exe$', ''
$desktopKilled = $false

$desktopProcs = Get-Process -Name $exeName -ErrorAction SilentlyContinue
if ($desktopProcs) {
    foreach ($p in $desktopProcs) {
        Write-TauriStep "  杀掉 desktop.exe (PID $($p.Id))"
        # /T 同时杀掉子进程树（但 sidecar 通过 cmd /C 启动，进程链可能复杂）
        taskkill /F /T /PID $p.Id 2>$null | Out-Null
        $desktopKilled = $true
    }
    Start-Sleep -Seconds 2
    Write-TauriOk "desktop.exe 已停止"
} else {
    Write-TauriWarn "desktop.exe 未在运行"
}

# ============================================================
# [2/4] 停止 sidecar 子进程链（cmd/pnpm/tsx/node）
# ============================================================
Write-TauriStep "[2/4] 停止 sidecar 子进程链..."

# 为什么不只依赖 desktop.exe 的 /T：
# sidecar 通过 cmd /C pnpm run dev:api 启动，进程链为：
#   cmd.exe → node(pnpm) → cmd.exe → node(pnpm) → cmd.exe → node(tsx) → node(loader)
# /T 应该杀掉整个树，但有时 cmd.exe /C 的中间进程会脱离父进程关系
# 因此需要额外扫描所有 sidecar 相关进程

$sidecarKilled = $false

# 匹配 sidecar 启动的所有进程（cmd.exe + node.exe，命令行含 tsx/index.ts/pnpm dev:api）
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -match 'tsx.*index\.ts|pnpm.*dev:api|pnpm.*@karpathy-wiki/api|pnpm.*--filter'
    } |
    ForEach-Object {
        # 排除当前 PowerShell 进程及其父进程
        if ($_.ProcessId -ne $PID -and $_.ParentProcessId -ne $PID) {
            Write-TauriStep "  杀掉 sidecar 进程 (PID $($_.ProcessId), $($_.Name))"
            taskkill /F /T /PID $_.ProcessId 2>$null | Out-Null
            $sidecarKilled = $true
        }
    }

if ($sidecarKilled) {
    Write-TauriOk "sidecar 子进程已清理"
} else {
    Write-TauriWarn "无 sidecar 进程需要清理"
}

Start-Sleep -Seconds 1

# ============================================================
# [3/4] 清理端口占用
# ============================================================
Write-TauriStep "[3/4] 清理端口占用..."

$port = [int]$Config.tauri.port
$portCleared = $true

# 循环检测端口，最多等待 5 秒
for ($i = 0; $i -lt 5; $i++) {
    $netstatOutput = netstat -aon 2>$null | Select-String ":$port.*LISTENING"
    if (-not $netstatOutput) {
        break
    }

    # 端口仍被占用，提取 PID 并杀掉
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

    Start-Sleep -Seconds 1
}

# 最终检查
$finalCheck = netstat -aon 2>$null | Select-String ":$port.*LISTENING"
if ($finalCheck) {
    $portCleared = $false
    Write-TauriWarn "端口 $port 仍被占用:"
    $finalCheck | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
} else {
    Write-TauriOk "端口 $port 已释放"
}

# ============================================================
# [4/4] 清理 PID 文件
# ============================================================
Write-TauriStep "[4/4] 清理 PID 文件..."

$pidFile = Join-Path $env.ProjectRoot $Config.tauri.pid_file
if (Test-Path $pidFile) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-TauriOk "PID 文件已清理: $pidFile"
} else {
    Write-TauriWarn "PID 文件不存在: $pidFile"
}

# ============================================================
# 停止完成
# ============================================================
Write-Host ""
if ($desktopKilled -or $sidecarKilled) {
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  Tauri 服务已停止" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  desktop.exe:  $($(if ($desktopKilled) {'已停止'} else {'未运行'}))" -ForegroundColor Gray
    Write-Host "  sidecar:      $($(if ($sidecarKilled) {'已清理'} else {'无残留'}))" -ForegroundColor Gray
    Write-Host "  端口 $port`:    $($(if ($portCleared) {'已释放'} else {'仍被占用'}))" -ForegroundColor Gray
} else {
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host "  无运行中的 Tauri 服务" -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Yellow
}
Write-Host ""
exit 0
