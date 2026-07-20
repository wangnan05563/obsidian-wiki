# Karpathy-AI + Obsidian 知识库一键安装脚本（AC-06-1）
# 流程：检查 Node.js → 安装依赖 → 初始化 Vault → 向导式配置 → 输出启动命令
# 用法：在 karpathy-wiki 目录下执行  .\scripts\install.ps1
# V1.3 变更：移除 TRAE CLI 检查，默认 HarnessAdapter

param(
    [string]$VaultPath = "../../data/vault",
    [switch]$SkipWizard
)

$ErrorActionPreference = "Stop"

# --- 日志辅助函数（输出结构化日志，便于前端解析进度，NFR-05-5）---
function Write-Step { param($msg) Write-Host "[安装] $msg" -ForegroundColor Cyan }
function Write-Ok { param($msg) Write-Host "[完成] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[警告] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[错误] $msg" -ForegroundColor Red }

# 项目根目录（scripts/ 的上一级）
$Root = Split-Path -Parent $PSScriptRoot

# 加载 node 路径解析模块（配置驱动，使用 tools.node.exe_path 指定的 node）
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
$scriptConfig = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$NodeExe = Resolve-NodeExe -Config $scriptConfig
# 将 node.exe 所在目录加入 PATH 头部，让后续 pnpm/npm 自动找到指定版本
if ($NodeExe) { Invoke-WithNodePath -NodeExePath $NodeExe }

# ============================================================
# 步骤 1：检查 Node.js >= 18（路径由配置解析，避免 PATH 旧版优先）
# ============================================================
Write-Step "检查 Node.js..."
if (-not $NodeExe) {
    Write-Err "未检测到 Node.js，请检查 scripts/config.json 中 tools.node 配置，或从 https://nodejs.org 安装 >= 18 版本后重试。"
    exit 1
}
try {
    $nodeVersion = (& $NodeExe --version).Trim()
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Err "Node.js 版本过低（$nodeVersion），需要 >= 18。请从 https://nodejs.org 升级。"
        exit 1
    }
    Write-Ok "Node.js $nodeVersion (路径: $NodeExe)"
} catch {
    Write-Err "调用 node 失败：$_"
    exit 1
}

# ============================================================
# 步骤 2：检测包管理器（pnpm 优先，回退 npm）
# ============================================================
Write-Step "检测包管理器..."
$UsePnpm = $false
try {
    $pnpmVer = (pnpm --version).Trim()
    Write-Ok "pnpm $pnpmVer"
    $UsePnpm = $true
} catch {
    Write-Warn "未检测到 pnpm，回退 npm。建议安装 pnpm 加速：npm install -g pnpm"
}

function Invoke-Install {
    if ($UsePnpm) { pnpm install } else { npm install }
}

# ============================================================
# 步骤 3：安装依赖
# ============================================================
Write-Step "安装根目录依赖..."
Push-Location $Root
try {
    Invoke-Install
} finally {
    Pop-Location
}

# @wiki/harness 独立包（本地 file: 引用，需先构建）
$HarnessPath = Join-Path $Root "..\wiki-harness"
if (Test-Path (Join-Path $HarnessPath "package.json")) {
    Write-Step "安装 @wiki/harness 依赖..."
    Push-Location $HarnessPath
    try {
        Invoke-Install
        # 构建 harness 产物，供 api 通过 file: 引用
        Write-Step "构建 @wiki/harness..."
        if ($UsePnpm) { pnpm run build } else { npm run build }
    } finally {
        Pop-Location
    }
} else {
    Write-Warn "未找到本地 wiki-harness 目录（$HarnessPath）。若已发布到 npm 可忽略此警告。"
}

# ============================================================
# 步骤 4：初始化 Vault 目录结构
# VaultService.init() 会在 API 启动时自动创建，这里预创建避免首次启动空白
# ============================================================
Write-Step "初始化 Vault 目录（$VaultPath）..."
$VaultFull = if ([System.IO.Path]::IsPathRooted($VaultPath)) { $VaultPath } else { Join-Path $Root $VaultPath }
$PageDirs = @('raw', 'entities', 'concepts', 'comparisons', 'queries')
foreach ($d in $PageDirs) {
    $dirPath = Join-Path $VaultFull $d
    if (-not (Test-Path $dirPath)) {
        New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
    }
}
Write-Ok "Vault 目录就绪：$VaultFull"

# ============================================================
# 步骤 5：向导式初始化（AC-06-5）
# 4 步：Vault 路径确认 → 模型选择 + API Key → SCHEMA 提示 → 完成
# ============================================================
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
            $VaultFull = if ([System.IO.Path]::IsPathRooted($customPath)) { $customPath } else { Join-Path $Root $customPath }
            # 重新创建目录
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

    # 默认 GLM；M-7：apiKeyRef 仅存环境变量名，不落盘实际 Key
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
        # M-7 安全要求：API Key 写入 .env 文件（.gitignore 排除），config.json 仅存 apiKeyRef
        $EnvFile = Join-Path $Root "api\.env"
        $envLines = @()
        if (Test-Path $EnvFile) {
            # 移除同名的旧 key 行，避免重复
            $envLines = @(Get-Content $EnvFile | Where-Object { $_ -and $_ -notmatch "^$ApiKeyRef=" })
        }
        $envLines += "$ApiKeyRef=$ApiKey"
        $envLines | Set-Content $EnvFile -Encoding UTF8
        Write-Ok "API Key 已写入 api/.env（已排除 git 跟踪）"
    } else {
        Write-Warn "未配置 API Key，问答功能暂不可用。可稍后编辑 api/.env 添加 $ApiKeyRef=你的Key"
    }

    # 写入 config.json（含模型配置，不含实际 Key）
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
    $ConfigFile = Join-Path $Root "api\config.json"
    $Config | ConvertTo-Json -Depth 5 | Set-Content $ConfigFile -Encoding UTF8
    Write-Ok "配置已写入 api/config.json"

    # --- 步骤3：SCHEMA.md 提示 ---
    Write-Host "步骤 3/4：SCHEMA.md" -ForegroundColor Cyan
    $schemaFile = Join-Path $VaultFull "SCHEMA.md"
    if (Test-Path $schemaFile) {
        Write-Host "  SCHEMA.md 已存在，保持不变（可在「配置」页编辑）"
    } else {
        Write-Host "  默认 SCHEMA.md 将在 API 首次启动时自动生成（VaultService.init）"
    }

    # --- 步骤4：完成 ---
    Write-Host "步骤 4/4：初始化完成！" -ForegroundColor Green
}

# ============================================================
# 步骤 6：确保 .gitignore 排除敏感文件（M-7）
# ============================================================
$Gitignore = Join-Path $Root ".gitignore"
$ignoreRules = @('.env', 'node_modules/', 'dist/', 'data/vault/raw/', 'data/vault/entities/', 'data/vault/queries/', 'data/vault/log.md', 'data/vault/index.md', 'data/vault/.harness/')
$existing = if (Test-Path $Gitignore) { Get-Content $Gitignore } else { @() }
$updated = $existing
foreach ($rule in $ignoreRules) {
    if ($updated -notcontains $rule) {
        $updated += $rule
    }
}
if ($updated -ne $existing) {
    $updated | Set-Content $Gitignore -Encoding UTF8
    Write-Ok "已更新 .gitignore（排除 .env / node_modules / dist / vault/raw）"
}

# ============================================================
# 输出启动指引
# ============================================================
Write-Host ""
Write-Host "======== 安装完成 ========" -ForegroundColor Green
Write-Host ""
Write-Host "启动方式（二选一）：" -ForegroundColor Cyan
Write-Host "  方式 A（推荐）：运行启动脚本  .\scripts\start.ps1"
Write-Host "  方式 B：分终端启动"
if ($UsePnpm) {
    Write-Host "    终端1：pnpm dev:api"
    Write-Host "    终端2：pnpm dev:web"
} else {
    Write-Host "    终端1：npm run dev:api"
    Write-Host "    终端2：npm run dev:web"
}
Write-Host ""
Write-Host "访问地址：" -ForegroundColor Cyan
Write-Host "  后端 API：http://localhost:3000"
Write-Host "  前端 Web：http://localhost:5173"
Write-Host ""
if (-not $ApiKey) {
    Write-Warn "提醒：尚未配置 API Key，问答功能将返回错误。请编辑 api/.env 添加后重启。"
}
