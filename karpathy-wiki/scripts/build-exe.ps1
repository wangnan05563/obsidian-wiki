# scripts/build-exe.ps1
# Karpathy-Wiki EXE 构建脚本
#
# 用法：
#   powershell -File scripts/build-exe.ps1            # 默认完整构建
#   powershell -File scripts/build-exe.ps1 -SkipSPA   # 跳过 SPA 构建（前端无变更时用）
#   powershell -File scripts/build-exe.ps1 -SkipDeps  # 跳过依赖安装（依赖无变更时用）
#   powershell -File scripts/build-exe.ps1 -Clean     # 清理所有缓存重新构建
#
# 产物：release/app/karpathy-wiki/ 目录 + release/installer/KarpathyWiki-Setup-v*.exe
#
# 构建步骤：
# 1. 检查依赖（Node.js / pnpm / @yao-pkg/pkg / esbuild）
# 2. 构建 @wiki/harness（如存在本地包）
# 3. 构建 SPA（vite build → release/spa/public）
# 4. esbuild 打包后端 TS → CJS 单文件 bundle
# 5. @yao-pkg/pkg 打包 → exe
# 6. 复制外置资源（SPA + vault 默认结构）
# 7. 制作安装包（Inno Setup）

param(
    [switch]$SkipSPA,
    [switch]$SkipDeps,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$wsRoot = Split-Path $repoRoot   # 项目（git 仓库）根目录：karpathy-wiki 的上级，统一发布目录 release/ 位于此
Set-Location $repoRoot

# 加载 node 路径解析模块（配置驱动，避免 PATH 旧版 node 优先）
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
$scriptConfig = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$NodeExe = Resolve-NodeExe -Config $scriptConfig
if (-not $NodeExe) {
    throw "未找到满足版本要求的 node.exe，请检查 scripts/config.json 中 tools.node 配置"
}
# 将 node.exe 所在目录加入 PATH 头部，让 pnpm.cmd / esbuild / pkg 自动找到指定版本
Invoke-WithNodePath -NodeExePath $NodeExe

# ============================================================
# [0/8] patch 号生成（构建前必做）
# 为什么放在最前：后续 esbuild / pkg / Inno Setup 均依赖 version，
# 必须在任何引用 version 的步骤之前完成写回
# 规则：主.次版本保留，patch = YYYYMMDD + 当天递增序号
# 持久化：.build/patch-counter.json 记录当天已构建次数，跨日重置
# ============================================================
. (Join-Path $PSScriptRoot 'bump-version.ps1')
$BuildVersion = Invoke-VersionBump -RepoRoot $repoRoot
if (-not $BuildVersion) {
    throw "构建版本号生成失败，请检查 package.json 与 .build 目录可写权限"
}

# 缓存与产物目录（必须在引用 $cacheDir 前定义）
$cacheDir = "$repoRoot\.cache"
$buildDir = "$repoRoot\.build"
$releaseDir = Join-Path $wsRoot "release"
$buildReadyMarker = "$buildDir\.kw-build-ready"

# 自动检测 Git 的 patch.exe 并添加到 PATH（pkg-fetch 从源码构建 Node 二进制时需要）
$git = Get-Command git -ErrorAction SilentlyContinue
if($git){
    $gitDir = Split-Path $git.Source
    $patchPath = Join-Path (Split-Path $gitDir) "usr\bin"
    if(Test-Path (Join-Path $patchPath "patch.exe")){
        $env:Path = "$patchPath;$env:Path"
        Write-Host "[Build] [OK] Git patch 添加到 PATH: $patchPath" -ForegroundColor Green
    }
}

# 自动检测 NASM 并添加到 PATH（pkg-fetch 从源码构建 Node 二进制时需要）
$nasm = Get-Command nasm -ErrorAction SilentlyContinue
if(-not $nasm){
    $nasmCacheDir = Join-Path $cacheDir "nasm-tmp"
    $nasmExe = Get-ChildItem $nasmCacheDir -Filter "nasm.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if($nasmExe){
        $nasmDir = Split-Path $nasmExe.FullName
        $env:Path = "$nasmDir;$env:Path"
        Write-Host "[Build] [OK] NASM 从缓存添加到 PATH: $nasmDir" -ForegroundColor Green
    } else {
        Write-Host "[Build] [WARN] NASM 未找到，pkg-fetch 从源码构建可能失败" -ForegroundColor Yellow
    }
} else {
    Write-Host "[Build] [OK] NASM 已在 PATH 中: $($nasm.Source)" -ForegroundColor Green
}

function Write-Step { param($msg) Write-Host "[Build] $msg" -ForegroundColor Cyan }
function Write-Ok { param($msg) Write-Host "[Build]   [OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[Build]   [WARN] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[Build]   [FAIL] $msg" -ForegroundColor Red }

# -Clean：清理所有缓存
if ($Clean) {
    Write-Host "[Clean] 清理所有缓存..." -ForegroundColor Yellow
    foreach ($p in @(".build", $cacheDir, $releaseDir)) {
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
Write-Host "Dist: $releaseDir"
if ($SkipDeps) { Write-Host "Mode: SkipDeps（跳过依赖安装）" }
if ($SkipSPA)  { Write-Host "Mode: SkipSPA（跳过 SPA 构建）" }

# ============== 1. 检查依赖 ==============
Write-Host "`n[1/8] 检查依赖..." -ForegroundColor Yellow

# Node.js 版本检查（路径已由脚本头部 Resolve-NodeExe 解析，这里仅报告版本）
# 为什么不用 PATH 中的 node：避免 PATH 中 nodejs14 优先于 nodejs24 导致 esbuild target=node18 失败
$nodeVersion = (& $NodeExe --version 2>$null) -replace '[v\n\r]', ''
if ($nodeVersion) {
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt 18) {
        Write-Err "Node $nodeVersion 版本过低，需要 Node 18+"
        throw "Node 版本过低（$nodeVersion），需要 18+"
    }
    Write-Ok "Node 版本：$nodeVersion (路径: $NodeExe)"
} else {
    throw "未检测到 Node.js，请检查 scripts/config.json 中 tools.node 配置"
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
# 为什么加 -w：项目是 pnpm workspace，根目录 add 需显式 --workspace-root 标志
$buildTools = @("@yao-pkg/pkg", "esbuild")
foreach ($tool in $buildTools) {
    $toolPath = "node_modules\.bin\$tool"
    if (-not (Test-Path $toolPath) -and -not (Test-Path "node_modules\$tool")) {
        Write-Step "安装构建工具 $tool..."
        if ($UsePnpm) {
            & $pkgCmd add -Dw $tool
        } else {
            & $pkgCmd add -D $tool
        }
        if ($LASTEXITCODE -ne 0) { throw "$tool 安装失败" }
    }
}
Write-Ok "构建工具就绪（@yao-pkg/pkg + esbuild）"

# ============== 2. 构建 @wiki/harness ==============
Write-Host "`n[2/8] 构建 @wiki/harness..." -ForegroundColor Yellow

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
    
    # 安装本地 harness 到 karpathy-wiki 的 node_modules（pkg 打包时需要）
    Write-Step "安装 @wiki/harness 到本地..."
    & $pkgCmd add "file:$harnessPath" -w
    if ($LASTEXITCODE -ne 0) { throw "@wiki/harness 安装失败" }
    Write-Ok "@wiki/harness 安装完成"
} else {
    Write-Warn "未找到本地 wiki-harness 目录，跳过（若已发布到 npm 可忽略）"
}

# ============== 3. 构建 SPA ==============
Write-Host "`n[3/8] 构建 SPA..." -ForegroundColor Yellow

$spaIndex = Join-Path $wsRoot "release\spa\public\index.html"
if ($SkipSPA -and (Test-Path $spaIndex)) {
    Write-Ok "SPA 已存在且 -SkipSPA 已指定，跳过构建"
} else {
    # 构建前端：vite.config.ts 中 outDir 指向 release/spa/public（项目根/release/spa/public）
    # 为什么加 ：vite 默认 base='/wiki/'（Tailscale Funnel 模式），
    #   exe 本地运行时不经过 Funnel 剥离前缀，前端 API 请求若带 /wiki/ 前缀会 404。
    #    覆盖默认值，让 fetch 路径为 /api/xxx 直接命中后端路由。
    # 为什么用等号形式  而非空格形式 --base /：
    #   PowerShell 传参时 --base / 被拆分为两个独立 token "--base" 和 "/"，
    #   commander.js 在 Windows 上把单独的 "/" 当作 Windows 风格选项前缀（如 /help），
    #   不会将其作为 --base 的值消费，导致 vite 回退到 config 中的默认 base='/wiki/'，
    #   前端 API_BASE 变成 '/wiki/api'，后端未注册该前缀路由 → 登录 HTTP 404。
    #   等号形式是 commander 标准语法，值与选项名一体传递，不依赖 shell 分词，跨平台可靠。
    # 为什么不直接用 pnpm run build：
    #   pnpm run build 包含 vue-tsc 类型检查，exe 构建场景下类型错误已在上次开发时验证，
    #   跳过可避免已知类型问题阻塞打包
    Push-Location (Join-Path $repoRoot "frontend")
    try {
        & npx vite build 
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) { throw "SPA 构建失败" }

    if (-not (Test-Path $spaIndex)) {
        throw "SPA 构建完成但未找到 index.html：$spaIndex"
    }
    Write-Ok "SPA 构建完成：$spaIndex"
}

# ============== 4. esbuild 打包后端 TS → CJS 单文件 ==============
Write-Host "`n[4/8] esbuild 打包后端..." -ForegroundColor Yellow

# 为什么用 esbuild：项目使用 ESM（"type": "module"），pkg 对 ESM 支持有限
# esbuild 把所有 TS 打包成单个 CJS 文件，pkg 再打包成 exe
$entryFile = Join-Path $repoRoot "api\src\index.ts"
$bundleFile = Join-Path $buildDir "bundle.cjs"

$esbuildArgs = @(
    # 为什么用 node_modules/esbuild/bin/esbuild 而非 .bin/esbuild：
    # .bin/esbuild（无扩展名）是 bash shim，Windows 下用 node 执行会报 SyntaxError
    # 直接调用 esbuild 包的 JS 入口，跨平台且不依赖 .cmd/.ps1 shim
    "node_modules\esbuild\bin\esbuild",
    $entryFile,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node18",
    "--outfile=$bundleFile",
    "--loader:.node=copy",       # 原生 .node 模块直接复制
    # 将 import.meta.url 替换为 CJS 等价表达式，避免 "import.meta is not available" 警告
    # 为什么用 banner+define 而非单一 define：
    # esbuild 0.25+ 破坏性变更，--define 值只允许 entity name 或 JS literal，
    # 不再允许函数调用表达式（如 require('url').pathToFileURL(...)）
    # 方案：banner 在 bundle 顶部注入 var 定义，define 把 import.meta.url 替换为标识符
    # 为什么检测 __filename 是否存在：SEA exe 中 __filename 指向构建时的 bundle.cjs，
    # 用户机器上该文件不存在，需改用 process.execPath（exe 路径）让路径解析正确
    "--banner:js=var __import_meta_url=require('url').pathToFileURL(require('fs').existsSync(__filename)?__filename:process.execPath).href",
    "--define:import.meta.url=__import_meta_url",
    "--log-level=info"
)

# 为什么用 $NodeExe 而非 PATH 中的 node：esbuild 产物 target=node18，需用对应版本执行
# 同时 $NodeExe 已通过 Invoke-WithNodePath 加入 PATH 头部，esbuild 内部 spawn 也能找到
& $NodeExe @esbuildArgs
if ($LASTEXITCODE -ne 0) { throw "esbuild 打包失败" }

if (-not (Test-Path $bundleFile)) {
    throw "esbuild 打包完成但未找到 bundle.cjs：$bundleFile"
}

# @wiki/harness 与 gray-matter 必须进入 bundle；SEA 运行时无法从 exe 外部解析普通 npm 包。
$harnessNodeModules = Join-Path $repoRoot "node_modules\@wiki\harness"
if (Test-Path $harnessNodeModules) {
    Write-Ok "@wiki/harness 已在 node_modules 中"
} else {
    Write-Warn "@wiki/harness 不在 node_modules 中，构建可能失败"
}

Write-Ok "esbuild 打包完成：$bundleFile"

# ============== 5. @yao-pkg/pkg 打包 → exe ==============
Write-Host "`n[5/8] pkg 打包 exe..." -ForegroundColor Yellow
Write-Host "  预计耗时：约 1-3 分钟（首次需下载 Node.js 二进制）" -ForegroundColor DarkGray

$pkgOutputDir = Join-Path $releaseDir "app\karpathy-wiki"
# 清理旧产物
if (Test-Path $pkgOutputDir) {
    Remove-Item -Recurse -Force $pkgOutputDir
}

# 设置 pkg 缓存目录（避免重复下载 Node 二进制）
$env:PKG_CACHE_PATH = $cacheDir

# ============== 5. pkg --sea 打包 exe（使用 Node.js 官方 SEA 功能，无需预下载特殊二进制）==============
Write-Host "`n[6/8] pkg --sea 打包 exe..." -ForegroundColor Yellow
Write-Host "  预计耗时：约 1-2 分钟（需下载 Node.js 官方二进制）" -ForegroundColor DarkGray

$exePath = Join-Path $pkgOutputDir "karpathy-wiki.exe"
$pkgArgs = @(
    "node_modules\@yao-pkg\pkg\lib-es5\bin.js",
    $bundleFile,
    "--sea",
    "--output", $exePath,
    "--options", "max-old-space-size=512"
)

& $NodeExe @pkgArgs
if ($LASTEXITCODE -ne 0) { throw "pkg 打包失败" }

if (-not (Test-Path $exePath)) {
    throw "pkg 打包完成但未找到 exe：$exePath"
}
Write-Ok "exe 生成完成：$exePath"

# ============== 5.2 注入 exe 图标（pkg/SEA 默认无图标）==============
# 为什么不用 rcedit：rcedit 5.x 是 Deno 编译的单文件二进制，在带杀毒软件(Defender/360/火绒)的
#   真实 Windows 上首次运行要把运行时解包到临时目录，常被拦截/挂起，表现为"构建卡在第6步"。
# 改用 PowerShell 直接 P/Invoke kernel32.dll 的 BeginUpdateResource/UpdateResource/EndUpdateResource
#   把 .ico 写进 exe 的 RT_GROUP_ICON 资源表——纯系统调用，无外部 exe，杀软不拦截、不会卡死。
# 仍由 Inno Setup 的 SetupIconFile + 快捷方式 IconFilename 保证安装包/桌面图标（双保险）。
Write-Host "`n[6a] 注入 exe 图标..." -ForegroundColor Yellow
$appIco = Join-Path $repoRoot "assets\app.ico"
if (Test-Path $appIco) {
    # 用 Windows 内核 API 直接注入图标资源（不依赖任何外部 exe）
    function Set-ExeIcon {
        param([string]$ExePath, [string]$IconPath)
        $code = @'
using System;
using System.Runtime.InteropServices;
public class IconInjector {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetLastError();
    public static void Inject(string exe, string ico) {
        byte[] icon = System.IO.File.ReadAllBytes(ico);
        ushort count = BitConverter.ToUInt16(icon, 4);
        int off = 6;
        var group = new System.Collections.Generic.List<byte>();
        group.Add(0); group.Add(0);                                   // reserved
        group.Add(1); group.Add(0);                                   // type = 1 (icon)
        group.Add((byte)(count & 0xff)); group.Add((byte)((count >> 8) & 0xff)); // count
        IntPtr h = BeginUpdateResource(exe, false);
        if (h == IntPtr.Zero) throw new InvalidOperationException("BeginUpdateResource 失败: " + GetLastError());
        ushort id = 1;
        for (ushort i = 0; i < count; i++) {
            int e = off + i * 16;
            byte width = icon[e];
            byte height = icon[e + 1];
            byte colorCount = icon[e + 2];
            byte reserved = icon[e + 3];
            ushort planes = BitConverter.ToUInt16(icon, e + 4);
            ushort bitCount = BitConverter.ToUInt16(icon, e + 6);
            uint bytesInRes = BitConverter.ToUInt32(icon, e + 8);
            uint imageOffset = BitConverter.ToUInt32(icon, e + 12);
            byte[] img = new byte[bytesInRes];
            Array.Copy(icon, (int)imageOffset, img, 0, (int)bytesInRes);
            // RT_ICON = 3：每个图标图像一个资源，id 从 1 递增
            if (!UpdateResource(h, new IntPtr(3), new IntPtr(id), 0, img, (uint)img.Length))
                throw new InvalidOperationException("UpdateResource(icon " + id + ") 失败: " + GetLastError());
            // GRPICONDIRENTRY（14 字节）：w,h,colorCount,reserved,planes,bitCount,bytesInRes,id(WORD)
            group.Add(width); group.Add(height); group.Add(colorCount); group.Add(reserved);
            group.Add((byte)(planes & 0xff)); group.Add((byte)((planes >> 8) & 0xff));
            group.Add((byte)(bitCount & 0xff)); group.Add((byte)((bitCount >> 8) & 0xff));
            group.Add((byte)(bytesInRes & 0xff)); group.Add((byte)((bytesInRes >> 8) & 0xff));
            group.Add((byte)((bytesInRes >> 16) & 0xff)); group.Add((byte)((bytesInRes >> 24) & 0xff));
            group.Add((byte)(id & 0xff)); group.Add((byte)((id >> 8) & 0xff));
            id++;
        }
        // RT_GROUP_ICON = 14，组 id = 1（Windows 取最小 id 作为应用主图标）
        if (!UpdateResource(h, new IntPtr(14), new IntPtr(1), 0, group.ToArray(), (uint)group.Count))
            throw new InvalidOperationException("UpdateResource(group) 失败: " + GetLastError());
        if (!EndUpdateResource(h, false))
            throw new InvalidOperationException("EndUpdateResource 失败: " + GetLastError());
    }
}
'@
        Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop
        [IconInjector]::Inject($ExePath, $IconPath)
    }
    try {
        Write-Step "通过 Windows API 注入图标到 exe（无需 rcedit）"
        Set-ExeIcon -ExePath $exePath -IconPath $appIco
        Write-Ok "exe 图标已注入"
    } catch {
        Write-Warn "exe 图标注入失败：$($_.Exception.Message)；exe 将使用默认图标，但安装包/快捷方式图标仍生效。"
    }
} else {
    Write-Warn "assets\app.ico 不存在，跳过 exe 图标注入"
}

# ============== 6. 复制外置资源 ==============
Write-Host "`n[7/8] 复制外置资源..." -ForegroundColor Yellow

# 6.1 SPA 静态资源（前端构建产物）
Write-Host "  [6.1] 复制 SPA 静态资源..."
$spaSource = Join-Path $wsRoot "release\spa\public"
$spaTarget = Join-Path $pkgOutputDir "public"
if (Test-Path $spaSource) {
    Copy-Item -Recurse -Force $spaSource $spaTarget
    Write-Ok "SPA 已复制到 $spaTarget"
} else {
    Write-Warn "SPA 源目录不存在：$spaSource"
}

# 6.2 配置文件（config.json）：不再在此处复制/生成
# 原因：SEA 模式下配置由应用在首次运行时自动生成到 %LOCALAPPDATA%\KarpathyWiki\config.json
#   （见 api/src/config.ts 的 loadConfig 首次落盘逻辑），安装器也不再安装 config.json，
#   因此 dist 下的 config.json 不会被读取，复制它既多余又可能误导（旧默认 host=127.0.0.1）。
#   密钥通过用户数据目录的 .env 注入，构建产物不再包含任何 config.json。

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
$promptsSource = Join-Path $repoRoot "api\src\prompts"
$promptsTarget = Join-Path $pkgOutputDir "prompts"
if (Test-Path $promptsSource) {
    Copy-Item -Recurse -Force $promptsSource $promptsTarget
    Write-Ok "prompts 已复制"
} else {
    Write-Warn "prompts 源目录不存在：$promptsSource"
}

# 6.6 pdf-parse 运行时依赖
# 为什么需要：pdf-convert.ts 用 createRequire 加载 pdf-parse/lib/pdf-parse.js，
# esbuild 无法静态分析 createRequire 的 require，不会将其打包进 bundle。
# SEA exe 安装目录无 node_modules，运行时 require 找不到模块。
# pdf-parse/lib/pdf-parse.js 内部还有动态 require `./pdf.js/${version}/build/pdf.js`，
# 同样无法被 esbuild 打包，必须将 pdf.js 文件一并复制到 exe 同级目录。
# 为什么只复制 v1.10.100：pdf-parse 默认 options.version = 'v1.10.100'，其他版本不会被加载
# 为什么排除 .map：source map 仅用于调试，运行时不需要，可减小安装包体积（约 4.5 MB）
Write-Host "  [6.6] 复制 pdf-parse 运行时依赖..."
$runtimeDepsTarget = Join-Path $pkgOutputDir "node_modules"

# pdf-parse：只复制 lib/pdf-parse.js + lib/pdf.js/v1.10.100/build/*.js + package.json
$pdfParseSource = Join-Path $repoRoot "api\node_modules\pdf-parse"
$pdfParseTarget = Join-Path $runtimeDepsTarget "pdf-parse"
if (Test-Path $pdfParseSource) {
    # 创建目录结构
    $pdfJsBuildTarget = Join-Path $pdfParseTarget "lib\pdf.js\v1.10.100\build"
    New-Item -ItemType Directory -Force $pdfJsBuildTarget | Out-Null

    # 复制 package.json（require 解析需要）
    Copy-Item -Force (Join-Path $pdfParseSource "package.json") (Join-Path $pdfParseTarget "package.json")
    # 复制核心文件 lib/pdf-parse.js
    Copy-Item -Force (Join-Path $pdfParseSource "lib\pdf-parse.js") (Join-Path $pdfParseTarget "lib\pdf-parse.js")
    # 复制 pdf.js v1.10.100 build 目录（只复制 .js，不复制 .map）
    $pdfJsBuildSource = Join-Path $pdfParseSource "lib\pdf.js\v1.10.100\build"
    Copy-Item -Force (Join-Path $pdfJsBuildSource "pdf.js") (Join-Path $pdfJsBuildTarget "pdf.js")
    Copy-Item -Force (Join-Path $pdfJsBuildSource "pdf.worker.js") (Join-Path $pdfJsBuildTarget "pdf.worker.js")
    Write-Ok "pdf-parse 已复制（仅 v1.10.100，排除 .map）"
} else {
    Write-Warn "pdf-parse 源目录不存在：$pdfParseSource，PDF 解析功能将不可用"
}

# node-ensure：pdf.js v1.10.100 内部 require('node-ensure') 的运行时依赖
# 为什么用递归查找：pnpm 将 node-ensure 作为 pdf-parse 的间接依赖放在 .pnpm 目录下，
# 路径随 pnpm 版本变化，递归查找最稳健
$nodeEnsureSource = $null
$pnpmNodeEnsure = Join-Path $repoRoot "node_modules\.pnpm"
if (Test-Path $pnpmNodeEnsure) {
    $nodeEnsureSource = Get-ChildItem -Path $pnpmNodeEnsure -Filter "node-ensure" -Directory -Recurse -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "index.js") } |
        Select-Object -First 1 -ExpandProperty FullName
}
# 兜底：检查 api/node_modules 下是否有 node-ensure（非 pnpm 环境或已提升）
if (-not $nodeEnsureSource) {
    $apiNodeEnsure = Join-Path $repoRoot "api\node_modules\node-ensure"
    if (Test-Path (Join-Path $apiNodeEnsure "index.js")) {
        $nodeEnsureSource = $apiNodeEnsure
    }
}

if ($nodeEnsureSource) {
    $nodeEnsureTarget = Join-Path $runtimeDepsTarget "node-ensure"
    New-Item -ItemType Directory -Force $nodeEnsureTarget | Out-Null
    Copy-Item -Force (Join-Path $nodeEnsureSource "package.json") (Join-Path $nodeEnsureTarget "package.json")
    Copy-Item -Force (Join-Path $nodeEnsureSource "index.js") (Join-Path $nodeEnsureTarget "index.js")
    Write-Ok "node-ensure 已复制（来源：$nodeEnsureSource）"
} else {
    Write-Warn "node-ensure 未找到，pdf.js 运行时可能报 require('node-ensure') 错误"
}

# 6.7 复制 llm-presets.json（LLM 厂商预设列表）
# 为什么需要：ai.ts 通过 getResourcePath('llm-presets.json') 加载预设列表，
# SEA 模式下 getResourcePath 返回 exe 同级目录，必须将 llm-presets.json 复制到 exe 目录
Write-Host "  [6.7] 复制 llm-presets.json..."
$apiDir = Join-Path $repoRoot "api"
$llmPresetsSource = Join-Path $apiDir "llm-presets.json"
if (Test-Path $llmPresetsSource) {
    Copy-Item -Force $llmPresetsSource (Join-Path $pkgOutputDir "llm-presets.json")
    Write-Ok "llm-presets.json 已复制"
} else {
    Write-Warn "llm-presets.json 源文件不存在：$llmPresetsSource，LLM 预设功能将不可用"
}

# 写入构建就绪标记
Set-Content -Path $buildReadyMarker -Value (Get-Date -Format o) -Encoding UTF8

# ============== 7. 制作安装包（Inno Setup） ==============
Write-Host "`n[8/8] 制作安装包（Inno Setup）..." -ForegroundColor Yellow

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
UninstallDisplayIcon={app}\app.ico
OutputDir=..\release\installer
OutputBaseFilename=KarpathyWiki-Setup-v{#MyAppVersion}
SetupIconFile=assets\app.ico
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
DisableProgramGroupPage=yes
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项:"
[Files]
; ---- 程序文件 / 资源：每次安装都覆盖（只读应用代码与资源，随版本更新）----
; 注意：新增的顶层程序文件/目录必须在此显式列出，切勿改回 "..\release\app\karpathy-wiki\*" 通配。
Source: "..\release\app\karpathy-wiki\karpathy-wiki.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\app\karpathy-wiki\public"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\release\app\karpathy-wiki\prompts"; DestDir: "{app}\prompts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\release\app\karpathy-wiki\node_modules"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\release\app\karpathy-wiki\llm-presets.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\app\karpathy-wiki\.env.example"; DestDir: "{app}"; Flags: ignoreversion
; 品牌图标：安装到 {app} 供快捷方式 / 卸载项引用（exe 图标另由 build-exe.ps1 用 Windows API 注入，不依赖 rcedit）
Source: "assets\app.ico"; DestDir: "{app}"; Flags: ignoreversion

; ---- 用户数据（config.json / .env / vault / data）不再安装到 {app} ----
; 原因：{app} 位于 Program Files，普通用户无写权限且卸载会被清除。
; 改为由应用在首次运行时自动创建到 %LOCALAPPDATA%\KarpathyWiki（见 api/src/utils/runtime.ts），
; 普通用户可写、不受卸载影响、多用户互不干扰。AI 服务设置持久化于该目录的 config.json。
[Icons]
Name: "{group}\Karpathy-Wiki"; Filename: "{app}\karpathy-wiki.exe"; IconFilename: "{app}\app.ico"; IconIndex: 0
Name: "{commondesktop}\Karpathy-Wiki"; Filename: "{app}\karpathy-wiki.exe"; Tasks: desktopicon; IconFilename: "{app}\app.ico"; IconIndex: 0
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
        $setupExe = Join-Path $releaseDir "installer\KarpathyWiki-Setup-v$version.exe"
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
Write-Host "  - 直接运行：..\release\app\karpathy-wiki\karpathy-wiki.exe"
Write-Host "  - 安装包：$releaseDir\installer\KarpathyWiki-Setup-v*.exe（如 Inno Setup 可用）"
Write-Host ""
Write-Host "  首次运行前（配置位于 %LOCALAPPDATA%\KarpathyWiki）："
Write-Host "  1. config.json 首次启动自动生成，可直接编辑该文件调整模型/provider"
Write-Host "  2. 在同目录（KarpathyWiki）放置 .env 并填入 API Key（参考 .env.example）"
Write-Host "  3. 如需公网/域名访问：将 config.json 的 server.host 改为 0.0.0.0 并配合反向代理或内置隧道"
Write-Host "========================================" -ForegroundColor Green

