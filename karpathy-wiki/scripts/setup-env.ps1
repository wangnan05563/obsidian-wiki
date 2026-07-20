<#
.SYNOPSIS
    Karpathy-Wiki 一键环境配置脚本（增强版）
.DESCRIPTION
    在新 PC 上自动检测、安装项目所需的全部依赖，并完成项目初始化。
    覆盖：Node.js 18+ / pnpm / @wiki/harness / 前后端依赖 / Vault 初始化 / 向导式配置。
    默认仅安装缺失项，已存在且版本达标的依赖会跳过，可重复执行。
    本脚本在 install.ps1 基础上增强：新增系统级软件自动安装（winget）。
.PARAMETER SkipSystem
    跳过系统级软件（Node.js/pnpm）的安装，仅做项目级初始化。
    适用场景：已手动安装好运行时，或无管理员权限无法安装系统软件。
.PARAMETER SkipWizard
    跳过向导式初始化（Vault 路径 / 模型选择 / API Key）。
.PARAMETER StartService
    全部完成后自动启动服务。
.PARAMETER VaultPath
    自定义 Vault 路径，默认 ./vault
.EXAMPLE
    .\setup-env.ps1
    标准执行：检测并补齐缺失依赖，完成项目初始化。
.EXAMPLE
    .\setup-env.ps1 -SkipSystem
    跳过系统级软件安装，仅做项目内初始化。
.EXAMPLE
    .\setup-env.ps1 -StartService
    初始化完成后立即启动服务。
.NOTES
    适用：Windows 10/11 x64，PowerShell 5.1+
    作者：Karpathy-Wiki
#>
#Requires -Version 5.0

[CmdletBinding()]
param(
    [switch]$SkipSystem,
    [switch]$SkipWizard,
    [switch]$StartService,
    [string]$VaultPath = "../../data/vault"
)

# 强制遇错即停
$ErrorActionPreference = "Stop"
$Script:StepPrefix = "[KW-Setup]"

# ============================================================
# 工具函数（与 install.ps1 保持一致的风格）
# ============================================================

function Write-Step { param($msg) Write-Host "$StepPrefix $msg" -ForegroundColor Cyan }
function Write-Ok { param($msg) Write-Host "$StepPrefix   [OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "$StepPrefix   [WARN] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "$StepPrefix   [FAIL] $msg" -ForegroundColor Red }

function Test-CommandAvailable {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeVersion {
    param([string]$ExePath)
    try {
        $output = & $ExePath --version 2>&1
        if ($output -match 'v?(\d+)\.(\d+)\.(\d+)') {
            return [PSCustomObject]@{
                Major = [int]$Matches[1]
                Minor = [int]$Matches[2]
                Patch = [int]$Matches[3]
            }
        }
    } catch { }
    return $null
}

function Test-VersionSatisfy {
    param($Current, [int]$MinMajor, [int]$MinMinor)
    if ($null -eq $Current) { return $false }
    if ($Current.Major -gt $MinMajor) { return $true }
    if ($Current.Major -lt $MinMajor) { return $false }
    return $Current.Minor -ge $MinMinor
}

function Test-WingetAvailable {
    return (Test-CommandAvailable 'winget')
}

function Install-WithWinget {
    param([string]$PackageId, [string]$DisplayName)
    Write-Step "通过 winget 安装 $DisplayName ($PackageId) ..."
    try {
        $wingetArgs = @('install', '--id', $PackageId, '--accept-package-agreements', '--accept-source-agreements', '--silent')
        & winget @wingetArgs
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "$DisplayName 安装完成"
            return $true
        } else {
            Write-Warn "winget 返回非零退出码 $LASTEXITCODE"
            return $false
        }
    } catch {
        Write-Err "winget 安装 $DisplayName 失败：$_"
        return $false
    }
}

function Invoke-Safe {
    param([scriptblock]$Block, [string]$Description)
    try {
        $global:LASTEXITCODE = 0
        & $Block
        if ($LASTEXITCODE -ne 0) { throw "退出码 $LASTEXITCODE" }
    } catch {
        Write-Err "$Description 失败：$_"
        throw
    }
}

# ============================================================
# 路径常量
# ============================================================

$Script:ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$Script:HarnessPath = Join-Path $ProjectRoot "..\wiki-harness"
$Script:EnvFile = Join-Path $ProjectRoot "api\.env"
$Script:ConfigFile = Join-Path $ProjectRoot "api\config.json"
$Script:LogsDir = Join-Path $ProjectRoot "logs"

# 版本门槛：与 package.json engines 对齐
$Script:NodeMinMajor = 18
$Script:NodeMinMinor = 0

# 加载 node 路径解析模块（配置驱动，使用 tools.node.exe_path 指定的 node）
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
$scriptConfig = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Script:NodeExe = Resolve-NodeExe -Config $scriptConfig
# 将 node.exe 所在目录加入 PATH 头部，让后续 pnpm/npm 自动找到指定版本
if ($Script:NodeExe) { Invoke-WithNodePath -NodeExePath $Script:NodeExe }

# ============================================================
# 主流程
# ============================================================

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Karpathy-Wiki 一键环境配置" -ForegroundColor Cyan
Write-Host "  项目目录: $ProjectRoot" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""

# ---------- Step 1: 系统级软件（Node.js / pnpm） ----------

if ($SkipSystem) {
    Write-Step "[1/7] 跳过系统级软件安装（-SkipSystem）"
} else {
    Write-Step "[1/7] 检测并安装系统级软件（Node.js / pnpm）"

    $wingetOk = Test-WingetAvailable
    if (-not $wingetOk) {
        Write-Warn "winget 不可用，将仅检测已有软件；缺失项需手动安装"
    }

    # --- Node.js ---
    # 优先使用 config.tools.node 解析出的路径（已通过 Invoke-WithNodePath 加入 PATH 头部）
    # 仅当配置解析失败时才走 winget 安装路径
    $nodeExe = $null
    if ($Script:NodeExe -and (Test-Path $Script:NodeExe)) {
        $ver = Get-NodeVersion $Script:NodeExe
        if ($ver -and (Test-VersionSatisfy $ver $NodeMinMajor $NodeMinMinor)) {
            $nodeExe = $Script:NodeExe
        }
    }
    # 配置路径未命中时回退 PATH 中的 node
    if (-not $nodeExe -and (Test-CommandAvailable 'node')) {
        $ver = Get-NodeVersion 'node'
        if ($ver -and (Test-VersionSatisfy $ver $NodeMinMajor $NodeMinMinor)) {
            $nodeExe = 'node'
        } else {
            Write-Warn "检测到 Node.js $($ver.Major).$($ver.Minor)，但需要 >= $NodeMinMajor.$NodeMinMinor"
        }
    }

    if ($nodeExe) {
        $ver = Get-NodeVersion $nodeExe
        Write-Ok "Node.js 已就绪: $nodeExe ($($ver.Major).$($ver.Minor).$($ver.Patch))"
    } else {
        Write-Warn "未找到 Node.js >= $NodeMinMajor.$NodeMinMinor"
        if ($wingetOk) {
            # 选择 LTS 版本：稳定且兼容性好
            $installed = Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
            if ($installed) {
                # winget 安装后当前会话 PATH 未刷新，需主动刷新
                $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
                if (Test-CommandAvailable 'node') {
                    $nodeExe = 'node'
                }
            }
        }
        if (-not $nodeExe) {
            Write-Err "Node.js 安装失败。请手动安装 Node.js 18+ 后重跑此脚本（可加 -SkipSystem 跳过），或在 scripts/config.json 的 tools.node.exe_path 中指定已有 node.exe 路径"
            throw "Node.js 不可用"
        }
        $ver = Get-NodeVersion $nodeExe
        Write-Ok "Node.js 安装完成: $nodeExe ($($ver.Major).$($ver.Minor).$($ver.Patch))"
    }

    # --- pnpm（可选，未安装则回退 npm） ---
    if (Test-CommandAvailable 'pnpm') {
        $pnpmVer = (pnpm --version).Trim()
        Write-Ok "pnpm 已就绪: $pnpmVer"
    } else {
        Write-Warn "未检测到 pnpm，尝试自动安装..."
        try {
            Invoke-Safe { & npm install -g pnpm } "安装 pnpm"
            # 刷新 PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
            if (Test-CommandAvailable 'pnpm') {
                $pnpmVer = (pnpm --version).Trim()
                Write-Ok "pnpm 安装完成: $pnpmVer"
            }
        } catch {
            Write-Warn "pnpm 安装失败，将回退 npm。建议手动安装：npm install -g pnpm"
        }
    }
}

# 检测最终使用的包管理器
$UsePnpm = $false
try { $null = pnpm --version; $UsePnpm = $true } catch { }

function Invoke-Install {
    if ($UsePnpm) { pnpm install } else { npm install }
}

# ---------- Step 2: 安装根目录依赖 ----------

Write-Step "[2/7] 安装根目录依赖..."
Push-Location $ProjectRoot
try {
    Invoke-Install
} finally {
    Pop-Location
}
Write-Ok "根目录依赖安装完成"

# ---------- Step 3: 安装并构建 @wiki/harness ----------

if (Test-Path (Join-Path $HarnessPath "package.json")) {
    Write-Step "[3/7] 安装 @wiki/harness 依赖..."
    Push-Location $HarnessPath
    try {
        Invoke-Install
        Write-Step "构建 @wiki/harness..."
        if ($UsePnpm) { pnpm run build } else { npm run build }
    } finally {
        Pop-Location
    }
    Write-Ok "@wiki/harness 构建完成"
} else {
    Write-Warn "[3/7] 未找到本地 wiki-harness 目录（$HarnessPath）。若已发布到 npm 可忽略此警告"
}

# ---------- Step 4: 初始化 Vault 目录 ----------

Write-Step "[4/7] 初始化 Vault 目录（$VaultPath）..."
$VaultFull = if ([System.IO.Path]::IsPathRooted($VaultPath)) { $VaultPath } else { Join-Path $ProjectRoot $VaultPath }
$PageDirs = @('raw', 'entities', 'concepts', 'comparisons', 'queries')
foreach ($d in $PageDirs) {
    $dirPath = Join-Path $VaultFull $d
    if (-not (Test-Path $dirPath)) {
        New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
    }
}
Write-Ok "Vault 目录就绪：$VaultFull"

# ---------- Step 5: 向导式初始化 ----------

$ApiKey = $null
if (-not $SkipWizard) {
    Write-Host ""
    Write-Host "======== 向导式初始化 ========" -ForegroundColor Magenta

    # --- 步骤1：Vault 路径 ---
    Write-Host "步骤 1/4：Vault 路径" -ForegroundColor Cyan
    Write-Host "  当前路径：$VaultFull"
    $confirm = Read-Host "  是否使用此路径？[Y/n]"
    if ($confirm -ne '' -and $confirm.ToLower() -ne 'y') {
        $customPath = Read-Host "  请输入 Vault 路径"
        if ($customPath) {
            $VaultPath = $customPath
            $VaultFull = if ([System.IO.Path]::IsPathRooted($customPath)) { $customPath } else { Join-Path $ProjectRoot $customPath }
            foreach ($d in $PageDirs) {
                $dirPath = Join-Path $VaultFull $d
                if (-not (Test-Path $dirPath)) { New-Item -ItemType Directory -Path $dirPath -Force | Out-Null }
            }
            Write-Ok "Vault 路径已更新：$VaultFull"
        }
    }

    # --- 步骤2：模型选择 + API Key ---
    Write-Host "步骤 2/4：选择模型" -ForegroundColor Cyan
    Write-Host "  1) 智谱 GLM（默认，glm-4-plus）"
    Write-Host "  2) 通义千问 Qwen（qwen-plus）"
    Write-Host "  3) DeepSeek（deepseek-chat）"
    $choice = Read-Host "  请选择 [1-3，默认1]"

    $Provider = 'glm'
    $BaseUrl = 'https://open.bigmodel.cn/api/paas/v4'
    $Model = 'glm-4-plus'
    $ApiKeyRef = 'GLM_KEY'

    switch ($choice) {
        '2' {
            $Provider = 'qwen'
            $BaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
            $Model = 'qwen-plus'
            $ApiKeyRef = 'QWEN_KEY'
        }
        '3' {
            $Provider = 'deepseek'
            $BaseUrl = 'https://api.deepseek.com'
            $Model = 'deepseek-chat'
            $ApiKeyRef = 'DEEPSEEK_KEY'
        }
    }

    Write-Host "  已选择：$Provider / $Model" -ForegroundColor Gray
    $ApiKey = Read-Host "  请输入 $Provider API Key（直接回车跳过，稍后可手动配置）"

    if ($ApiKey) {
        $envLines = @()
        if (Test-Path $EnvFile) {
            $envLines = @(Get-Content $EnvFile | Where-Object { $_ -and $_ -notmatch "^$ApiKeyRef=" })
        }
        $envLines += "$ApiKeyRef=$ApiKey"
        $envLines | Set-Content $EnvFile -Encoding UTF8
        Write-Ok "API Key 已写入 api/.env（已排除 git 跟踪）"
    } else {
        Write-Warn "未配置 API Key，问答功能暂不可用。可稍后编辑 api/.env 添加 $ApiKeyRef=你的Key"
    }

    $Config = @{
        vaultPath = $VaultPath
        adapter = 'harness'
        llm = @{
            provider = $Provider
            baseUrl = $BaseUrl
            model = $Model
            apiKeyRef = $ApiKeyRef
        }
        budget = @{ maxSteps = 20; tokenBudget = 50000 }
        server = @{ host = 'localhost'; port = 3000 }
        localOnly = $true
        healthCheck = @{ staleDays = 30 }
    }
    $Config | ConvertTo-Json -Depth 5 | Set-Content $ConfigFile -Encoding UTF8
    Write-Ok "配置已写入 api/config.json"

    # --- 步骤3：SCHEMA.md ---
    Write-Host "步骤 3/4：SCHEMA.md" -ForegroundColor Cyan
    $schemaFile = Join-Path $VaultFull "SCHEMA.md"
    if (Test-Path $schemaFile) {
        Write-Host "  SCHEMA.md 已存在，保持不变"
    } else {
        Write-Host "  默认 SCHEMA.md 将在 API 首次启动时自动生成"
    }

    Write-Host "步骤 4/4：初始化完成！" -ForegroundColor Green
}

# ---------- Step 6: .gitignore ----------

Write-Step "[6/7] 检查 .gitignore..."
$Gitignore = Join-Path $ProjectRoot ".gitignore"
$ignoreRules = @('.env', 'node_modules/', 'dist/', 'data/vault/raw/', 'data/vault/entities/', 'data/vault/queries/', 'data/vault/log.md', 'data/vault/index.md', 'data/vault/.harness/', 'api/public/')
$existing = if (Test-Path $Gitignore) { Get-Content $Gitignore } else { @() }
$updated = $existing
foreach ($rule in $ignoreRules) {
    if ($updated -notcontains $rule) {
        $updated += $rule
    }
}
if ($updated -ne $existing) {
    $updated | Set-Content $Gitignore -Encoding UTF8
    Write-Ok "已更新 .gitignore"
} else {
    Write-Ok ".gitignore 已是最新"
}

# ---------- Step 7: 环境自检 ----------

Write-Step "[7/7] 环境自检..."

$checklist = @(
    @{ Name = "Node.js"; Test = { Test-CommandAvailable 'node' } },
    @{ Name = "根目录 node_modules"; Test = { Test-Path (Join-Path $ProjectRoot "node_modules") } },
    @{ Name = "@wiki/harness"; Test = { Test-Path (Join-Path $HarnessPath "dist") } },
    @{ Name = "api/config.json"; Test = { Test-Path $ConfigFile } },
    @{ Name = "Vault 目录"; Test = { Test-Path $VaultFull } }
)

$allPass = $true
foreach ($item in $checklist) {
    if (& $item.Test) {
        Write-Ok "$($item.Name) √"
    } else {
        Write-Err "$($item.Name) ×"
        $allPass = $false
    }
}

# 创建 logs 目录
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

Write-Host ""
if ($allPass) {
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  环境配置完成！" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
} else {
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host "  部分检查未通过，请按上述提示修复后重跑" -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "下一步操作：" -ForegroundColor Cyan
Write-Host "  1. 启动服务：双击 scripts\start-service.bat"
Write-Host "  2. 访问：http://localhost:5173"
Write-Host "  3. 构建前端：双击 scripts\build-web.bat"
Write-Host "  4. 打包 EXE：双击 scripts\build-exe.bat"
Write-Host ""

if (-not $ApiKey) {
    Write-Warn "提醒：尚未配置 API Key，问答功能将返回错误。请编辑 api/.env 添加后重启。"
}

# ---------- 可选：启动服务 ----------

if ($StartService -and $allPass) {
    Write-Step "启动服务（-StartService）"
    & "$PSScriptRoot\start.ps1"
}

Write-Host ""
return 0
