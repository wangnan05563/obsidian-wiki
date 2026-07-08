# scripts/build-exe.ps1
# Karpathy-Wiki EXE 构建脚本
#
# 用法：
#   powershell -File scripts/build-exe.ps1            # 默认完整构建
#   powershell -File scripts/build-exe.ps1 -SkipSPA   # 跳过 SPA 构建（前端无变更时用）
#   powershell -File scripts/build-exe.ps1 -SkipDeps  # 跳过依赖安装（依赖无变更时用）
#   powershell -File scripts/build-exe.ps1 -Clean     # 清理所有缓存重新构建
#
# 产物：dist/karpathy-wiki/ 目录 + dist/KarpathyWiki-Setup-v*.exe
#
# 构建步骤：
# 1. 检查依赖（Node.js / pnpm / @yao-pkg/pkg / esbuild）
# 2. 构建 @wiki/harness（如存在本地包）
# 3. 构建 SPA（vite build → services/api/public）
# 4. esbuild 打包后端 TS → CJS 单文件 bundle
# 5. @yao-pkg/pkg 打包 → exe
# 6. 复制外置资源（SPA + config.json + vault 默认结构）
# 7. 制作安装包（Inno Setup）

param(
    [switch]$SkipSPA,
    [switch]$SkipDeps,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $repoRoot

# 缓存与产物目录
$cacheDir = "$repoRoot\.cache"
$buildDir = "$repoRoot\.build"
$distDir = "$repoRoot\dist"
$buildReadyMarker = "$buildDir\.kw-build-ready"

function Write-Step { param($msg) Write-Host "[Build] $msg" -ForegroundColor Cyan }
function Write-Ok { param($msg) Write-Host "[Build]   [OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[Build]   [WARN] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[Build]   [FAIL] $msg" -ForegroundColor Red }

# -Clean：清理所有缓存
if ($Clean) {
    Write-Host "[Clean] 清理所有缓存..." -ForegroundColor Yellow
    foreach ($p in @(".build", $cacheDir, $distDir)) {
        if (Test-Path $p) {
            Write-Host "  删除 $p"
            Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
        }
    }
}

New-Item -ItemType Directory -Force $cacheDir | Out-Null
New-Item -ItemType Directory -Force $buildDir | Out-Null

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Karpathy-Wiki EXE Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Repo: $repoRoot"
Write-Host "Build: $buildDir"
Write-Host "Dist: $distDir"
if ($SkipDeps) { Write-Host "Mode: SkipDeps（跳过依赖安装）" }
if ($SkipSPA)  { Write-Host "Mode: SkipSPA（跳过 SPA 构建）" }

# ============== 1. 检查依赖 ==============
Write-Host "`n[1/7] 检查依赖..." -ForegroundColor Yellow

# Node.js 版本检查
$nodeVersion = (node --version 2>$null) -replace '[v\n\r]', ''
if ($nodeVersion) {
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt 18) {
        Write-Err "Node $nodeVersion 版本过低，需要 Node 18+"
        throw "Node 版本过低（$nodeVersion），需要 18+"
    }
    Write-Ok "Node 版本：$nodeVersion"
} else {
    throw "未检测到 Node.js，请安装 Node 18+ 后重试"
}

# 检测包管理器
$UsePnpm = $false
try { $null = pnpm --version; $UsePnpm = $true } catch { }
$pkgCmd = if ($UsePnpm) { 'pnpm' } else { 'npm' }
Write-Ok "包管理器：$pkgCmd"

# 安装根目录依赖
if (-not $SkipDeps) {
    Write-Step "安装根目录依赖..."
    & $pkgCmd install
    if ($LASTEXITCODE -ne 0) { throw "根目录依赖安装失败" }
}

# 确保 @yao-pkg/pkg 和 esbuild 已安装（构建工具）
$buildTools = @("@yao-pkg/pkg", "esbuild")
foreach ($tool in $buildTools) {
    $toolPath = "node_modules\.bin\$tool"
    if (-not (Test-Path $toolPath) -and -not (Test-Path "node_modules\$tool")) {
        Write-Step "安装构建工具 $tool..."
        & $pkgCmd add -D $tool
        if ($LASTEXITCODE -ne 0) { throw "$tool 安装失败" }
    }
}
Write-Ok "构建工具就绪（@yao-pkg/pkg + esbuild）"

# ============== 2. 构建 @wiki/harness ==============
Write-Host "`n[2/7] 构建 @wiki/harness..." -ForegroundColor Yellow

$harnessPath = Join-Path $repoRoot "..\wiki-harness"
if (Test-Path (Join-Path $harnessPath "package.json")) {
    Push-Location $harnessPath
    try {
        if (-not $SkipDeps) {
            & $pkgCmd install
            if ($LASTEXITCODE -ne 0) { Pop-Location; throw "@wiki/harness 依赖安装失败" }
        }
        & $pkgCmd run build
        if ($LASTEXITCODE -ne 0) { Pop-Location; throw "@wiki/harness 构建失败" }
    } finally {
        Pop-Location
    }
    Write-Ok "@wiki/harness 构建完成"
} else {
    Write-Warn "未找到本地 wiki-harness 目录，跳过（若已发布到 npm 可忽略）"
}

# ============== 3. 构建 SPA ==============
Write-Host "`n[3/7] 构建 SPA..." -ForegroundColor Yellow

$spaIndex = Join-Path $repoRoot "services\api\public\index.html"
if ($SkipSPA -and (Test-Path $spaIndex)) {
    Write-Ok "SPA 已存在且 -SkipSPA 已指定，跳过构建"
} else {
    # 构建前端：vite.config.ts 中 outDir 指向 services/api/public
    & $pkgCmd run build
    if ($LASTEXITCODE -ne 0) { throw "SPA 构建失败" }

    if (-not (Test-Path $spaIndex)) {
        throw "SPA 构建完成但未找到 index.html：$spaIndex"
    }
    Write-Ok "SPA 构建完成：$spaIndex"
}

# ============== 4. esbuild 打包后端 TS → CJS 单文件 ==============
Write-Host "`n[4/7] esbuild 打包后端..." -ForegroundColor Yellow

# 为什么用 esbuild：项目使用 ESM（"type": "module"），pkg 对 ESM 支持有限
# esbuild 把所有 TS 打包成单个 CJS 文件，pkg 再打包成 exe
$entryFile = Join-Path $repoRoot "services\api\src\index.ts"
$bundleFile = Join-Path $buildDir "bundle.cjs"

$esbuildArgs = @(
    "node_modules\.bin\esbuild",
    $entryFile,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node18",
    "--outfile=$bundleFile",
    "--external:@wiki/harness",  # 本地 file: 引用，pkg 需单独处理
    "--external:gray-matter",    # 原生模块，保持外部引用
    "--loader:.node=copy",       # 原生 .node 模块直接复制
    "--log-level=info"
)

& node @esbuildArgs
if ($LASTEXITCODE -ne 0) { throw "esbuild 打包失败" }

if (-not (Test-Path $bundleFile)) {
    throw "esbuild 打包完成但未找到 bundle.cjs：$bundleFile"
}

# @wiki/harness 需要作为外部依赖打包
# 为什么：harness 是本地 file: 引用，esbuild 无法直接解析，需 pkg 从 node_modules 收集
$harnessNodeModules = Join-Path $repoRoot "node_modules\@wiki\harness"
if (Test-Path $harnessNodeModules) {
    Write-Ok "@wiki/harness 已在 node_modules 中"
} else {
    Write-Warn "@wiki/harness 不在 node_modules 中，构建可能失败"
}

Write-Ok "esbuild 打包完成：$bundleFile"

# ============== 5. @yao-pkg/pkg 打包 → exe ==============
Write-Host "`n[5/7] pkg 打包 exe..." -ForegroundColor Yellow
Write-Host "  预计耗时：约 1-3 分钟（首次需下载 Node.js 二进制）" -ForegroundColor DarkGray

$pkgOutputDir = Join-Path $distDir "karpathy-wiki"
# 清理旧产物
if (Test-Path $pkgOutputDir) {
    Remove-Item -Recurse -Force $pkgOutputDir
}

# pkg 配置文件
$pkgConfig = @{
    name = "karpathy-wiki"
    bin = $bundleFile
    pkg = @{
        targets = @("node18-win-x64")
        output = $pkgOutputDir
        assets = @(
            "services\api\prompts\**\*",
            "services\api\src\prompts\**\*"
        )
        scripts = @()
    }
}
$pkgConfigPath = Join-Path $buildDir "pkg-config.json"
$pkgConfig | ConvertTo-Json -Depth 5 | Set-Content $pkgConfigPath -Encoding UTF8

# 设置 pkg 缓存目录（避免重复下载 Node 二进制）
$env:PKG_CACHE_PATH = $cacheDir

# 为什么用 --options expose-gc：Fastify 可能需要 GC 控制
$pkgArgs = @(
    "node_modules\.bin\pkg",
    $pkgConfigPath,
    "--targets", "node18-win-x64",
    "--output", (Join-Path $pkgOutputDir "karpathy-wiki.exe"),
    "--options", "max-old-space-size=512"
)

& node @pkgArgs
if ($LASTEXITCODE -ne 0) { throw "pkg 打包失败" }

$exePath = Join-Path $pkgOutputDir "karpathy-wiki.exe"
if (-not (Test-Path $exePath)) {
    throw "pkg 打包完成但未找到 exe：$exePath"
}
Write-Ok "exe 生成完成：$exePath"

# ============== 6. 复制外置资源 ==============
Write-Host "`n[6/7] 复制外置资源..." -ForegroundColor Yellow

# 6.1 SPA 静态资源（前端构建产物）
Write-Host "  [6.1] 复制 SPA 静态资源..."
$spaSource = Join-Path $repoRoot "services\api\public"
$spaTarget = Join-Path $pkgOutputDir "public"
if (Test-Path $spaSource) {
    Copy-Item -Recurse -Force $spaSource $spaTarget
    Write-Ok "SPA 已复制到 $spaTarget"
} else {
    Write-Warn "SPA 源目录不存在：$spaSource"
}

# 6.2 配置文件（config.json）
Write-Host "  [6.2] 复制配置文件..."
$configSource = Join-Path $repoRoot "services\api\config.json"
$configTarget = Join-Path $pkgOutputDir "config.json"
if (Test-Path $configSource) {
    Copy-Item -Force $configSource $configTarget
    Write-Ok "config.json 已复制"
} else {
    # 生成默认配置
    $defaultConfig = @{
        vaultPath = "./vault"
        adapter = "harness"
        llm = @{
            provider = "glm"
            baseUrl = "https://open.bigmodel.cn/api/paas/v4"
            model = "glm-4-plus"
            apiKeyRef = "GLM_KEY"
        }
        budget = @{ maxSteps = 20; tokenBudget = 50000 }
        server = @{ host = "127.0.0.1"; port = 3000 }
        localOnly = $true
        healthCheck = @{ staleDays = 30 }
    }
    $defaultConfig | ConvertTo-Json -Depth 5 | Set-Content $configTarget -Encoding UTF8
    Write-Ok "已生成默认 config.json"
}

# 6.3 .env 模板（不含实际 Key，仅占位提示）
Write-Host "  [6.3] 生成 .env 模板..."
$envTemplate = Join-Path $pkgOutputDir ".env.example"
$envContent = @"
# Karpathy-Wiki 环境变量配置
# 复制此文件为 .env 并填入实际 API Key
# 支持：GLM_KEY / QWEN_KEY / DEEPSEEK_KEY（与 config.json 中 apiKeyRef 对应）

# 智谱 GLM
GLM_KEY=

# 通义千问 Qwen
# QWEN_KEY=

# DeepSeek
# DEEPSEEK_KEY=
"@
Set-Content -Path $envTemplate -Value $envContent -Encoding UTF8
Write-Ok ".env.example 已生成"

# 6.4 默认 Vault 目录结构
Write-Host "  [6.4] 创建默认 Vault 目录..."
$vaultTarget = Join-Path $pkgOutputDir "vault"
$PageDirs = @('raw', 'entities', 'concepts', 'comparisons', 'queries')
foreach ($d in $PageDirs) {
    $dirPath = Join-Path $vaultTarget $d
    New-Item -ItemType Directory -Force $dirPath | Out-Null
}
Write-Ok "默认 Vault 目录已创建"

# 6.5 prompts 目录（编译/问答/体检的 prompt 模板）
Write-Host "  [6.5] 复制 prompts 目录..."
$promptsSource = Join-Path $repoRoot "services\api\src\prompts"
$promptsTarget = Join-Path $pkgOutputDir "prompts"
if (Test-Path $promptsSource) {
    Copy-Item -Recurse -Force $promptsSource $promptsTarget
    Write-Ok "prompts 已复制"
} else {
    Write-Warn "prompts 源目录不存在：$promptsSource"
}

# 写入构建就绪标记
Set-Content -Path $buildReadyMarker -Value (Get-Date -Format o) -Encoding UTF8

# ============== 7. 制作安装包（Inno Setup） ==============
Write-Host "`n[7/7] 制作安装包（Inno Setup）..." -ForegroundColor Yellow

function Find-ISCC {
    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $paths = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "$env:USERPROFILE\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
    )
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    return $null
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

$iscc = Find-ISCC

# 自动安装 Inno Setup（如未安装）
if (-not $iscc) {
    Write-Host "  Inno Setup 未安装，尝试自动安装..." -ForegroundColor Cyan

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  使用 winget 安装..." -ForegroundColor DarkGray
        winget install --id JRSoftware.InnoSetup --silent --accept-package-agreements --accept-source-agreements
        Refresh-Path
        $iscc = Find-ISCC
    }

    if (-not $iscc) {
        Write-Host "  直接下载 Inno Setup 安装包..." -ForegroundColor DarkGray
        $installerUrl = "https://jrsoftware.org/download.php/is.exe"
        $installerFile = "$env:TEMP\innosetup-install.exe"
        try {
            Invoke-WebRequest -Uri $installerUrl -OutFile $installerFile -UseBasicParsing
            Start-Process -FilePath $installerFile -ArgumentList "/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/SP-" -Wait -NoNewWindow
            Refresh-Path
            $iscc = Find-ISCC
        } catch {
            Write-Host "  [WARN] 下载安装失败：$_" -ForegroundColor Red
        } finally {
            if (Test-Path $installerFile) { Remove-Item $installerFile -Force -ErrorAction SilentlyContinue }
        }
    }
}

# 自动创建 installer.iss（如不存在）
$issFile = Join-Path $repoRoot "installer.iss"
if ($iscc -and -not (Test-Path $issFile)) {
    Write-Host "  installer.iss 不存在，自动创建..." -ForegroundColor Cyan
    $issTemplate = @"
; Auto-generated by build-exe.ps1
; Karpathy-Wiki Inno Setup 配置
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
[Setup]
AppName=Karpathy-Wiki
AppVersion={#MyAppVersion}
AppPublisher=Karpathy-Wiki
DefaultDirName={autopf}\KarpathyWiki
DefaultGroupName=KarpathyWiki
UninstallDisplayIcon={app}\karpathy-wiki.exe
OutputDir=dist
OutputBaseFilename=KarpathyWiki-Setup-v{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
DisableProgramGroupPage=yes
[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项:"
[Files]
Source: "dist\karpathy-wiki\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Karpathy-Wiki"; Filename: "{app}\karpathy-wiki.exe"
Name: "{commondesktop}\Karpathy-Wiki"; Filename: "{app}\karpathy-wiki.exe"; Tasks: desktopicon
[Run]
Filename: "{app}\karpathy-wiki.exe"; Description: "启动 Karpathy-Wiki"; Flags: nowait postinstall skipifsilent
"@
    # Inno Setup 编译器（ISCC）需要 UTF-8 BOM 才能正确解析中文
    [System.IO.File]::WriteAllText($issFile, $issTemplate, (New-Object System.Text.UTF8Encoding($true)))
}

# 编译安装包
if (-not $iscc) {
    Write-Warn "Inno Setup 不可用，跳过安装包制作"
    Write-Host "  手动安装：https://jrsoftware.org/isdl.php" -ForegroundColor DarkGray
} else {
    # 读取版本号
    $version = "0.1.0"
    $rootPkg = Join-Path $repoRoot "package.json"
    if (Test-Path $rootPkg) {
        $pkgContent = Get-Content $rootPkg -Raw | ConvertFrom-Json
        if ($pkgContent.version) { $version = $pkgContent.version }
    }
    Write-Host "  版本号: $version"
    Write-Host "  编译安装包..."
    & $iscc /DMyAppVersion=$version $issFile
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "安装包编译失败"
    } else {
        $setupExe = "dist\KarpathyWiki-Setup-v$version.exe"
        Write-Ok "安装包已生成：$setupExe"
    }
}

# ============== 完成 ==============
$size = (Get-ChildItem -Recurse $pkgOutputDir | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Output: $pkgOutputDir"
Write-Host ("  Size: {0:N1} MB" -f $size)
Write-Host "  EXE:   $pkgOutputDir\karpathy-wiki.exe"
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  使用方式："
Write-Host "  - 直接运行：dist\karpathy-wiki\karpathy-wiki.exe"
Write-Host "  - 安装包：dist\KarpathyWiki-Setup-v*.exe（如 Inno Setup 可用）"
Write-Host ""
Write-Host "  首次运行前："
Write-Host "  1. 编辑 config.json 确认模型配置"
Write-Host "  2. 复制 .env.example 为 .env，填入 API Key"
Write-Host "========================================" -ForegroundColor Green
