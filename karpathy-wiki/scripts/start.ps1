# Karpathy-AI + Obsidian 知识库启动脚本
# 加载 .env 环境变量 → 启动后端 API + 前端 Web
# 用法：.\scripts\start.ps1
# 停止：关闭弹出的两个终端窗口，或在窗口内按 Ctrl+C

param(
    [switch]$ApiOnly,   # 仅启动后端
    [switch]$WebOnly    # 仅启动前端
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

# ============================================================
# 加载 .env 文件（M-7：API Key 存于此，不落盘 config.json）
# 将 .env 中的 KEY=VALUE 注入当前进程环境变量，子进程自动继承
# ============================================================
$EnvFile = Join-Path $Root "services\api\.env"
if (Test-Path $EnvFile) {
    Write-Host "[启动] 加载 .env：$EnvFile" -ForegroundColor Cyan
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        # 跳过空行和注释行
        if ($line -and -not $line.StartsWith('#')) {
            if ($line -match "^([^=]+)=(.*)$") {
                $key = $matches[1].Trim()
                $val = $matches[2].Trim()
                Set-Item -Path "env:$key" -Value $val
            }
        }
    }
    Write-Host "[完成] 环境变量已加载" -ForegroundColor Green
} else {
    Write-Host "[警告] 未找到 .env 文件，API Key 可能缺失。若问答报错请先运行 .\scripts\install.ps1" -ForegroundColor Yellow
}

# Windows PowerShell 可能禁止执行 pnpm.ps1/npm.ps1；显式使用 .cmd 入口。
$PnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $PnpmCommand -and -not $NpmCommand) {
    throw "未检测到 pnpm.cmd 或 npm.cmd，请先安装 Node.js 与包管理器"
}

function Get-DevCommand {
    param([string]$Target)  # 'api' 或 'web'
    if ($PnpmCommand) { return "pnpm.cmd dev:$Target" }
    return "npm.cmd run dev:$Target"
}

# ============================================================
# 启动服务（在新 PowerShell 窗口中启动，便于查看实时日志）
# ============================================================
if (-not $WebOnly) {
    $apiCmd = Get-DevCommand 'api'
    Write-Host "[启动] 后端 API：$apiCmd" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; Write-Host '后端 API - http://localhost:3000' -ForegroundColor Green; $apiCmd"
}

if (-not $ApiOnly) {
    $webCmd = Get-DevCommand 'web'
    Write-Host "[启动] 前端 Web：$webCmd" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; Write-Host '前端 Web - http://localhost:5173' -ForegroundColor Green; $webCmd"
}

Write-Host ""
Write-Host "======== 启动完成 ========" -ForegroundColor Green
Write-Host "  后端 API：http://localhost:3000"
Write-Host "  前端 Web：http://localhost:5173"
Write-Host ""
Write-Host "停止服务：关闭弹出的终端窗口即可" -ForegroundColor Gray
