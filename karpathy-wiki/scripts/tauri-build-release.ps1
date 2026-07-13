#Requires -Version 5.1
# scripts/tauri-build-release.ps1
# Tauri 桌面应用 Release 构建打包脚本
# 步骤：环境配置 → 构建 SPA → tauri build (release) → 移动产物 → 验证
# 产物：dist/tauri-bundle/ (.msi / .exe 安装包) — 与 build-exe.bat 的 dist/ 目录规划一致
# 配置驱动：所有路径从 config.json 读取

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$SkipSPA,
    [switch]$SkipBundle
)

# 加载共享模块
. (Join-Path $PSScriptRoot 'tauri-common.ps1')

$env = Initialize-TauriEnvironment -ConfigPath $ConfigPath
$Config = $env.Config

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Karpathy-Wiki Tauri Package (Release Build)" -ForegroundColor Cyan
Write-Host "  项目目录: $($env.ProjectRoot)" -ForegroundColor DarkGray
Write-Host "  desktop:  $($Config.tauri.desktop_dir)" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""

# ============================================================
# [1/5] 验证环境
# ============================================================
Write-TauriStep "[1/5] 验证环境..."

if (-not (Test-ToolAvailable 'cargo')) {
    Write-TauriErr "cargo 不可用，请先运行 scripts\tauri-setup.bat"
    exit 1
}
Write-TauriOk "cargo 可用"

if (-not (Test-ToolAvailable 'pnpm.cmd') -and -not (Test-ToolAvailable 'pnpm')) {
    Write-TauriErr "pnpm 不可用，请先运行 scripts\setup-env.bat"
    exit 1
}
Write-TauriOk "pnpm 可用"

if (-not (Test-Path $env.LdLld)) {
    Write-TauriErr "LLD 链接器缺失"
    exit 1
}
Write-TauriOk "LLD 链接器就绪"

if (-not (Test-Path $env.WrapperExe)) {
    Write-TauriErr "windres.exe wrapper 缺失"
    exit 1
}
Write-TauriOk "windres wrapper 就绪"

# 磁盘空间预检查（release 构建比 debug 占用更多空间）
$srcTauriDir = Join-Path $env.ProjectRoot $Config.tauri.src_tauri_dir
$minGB = [double]$Config.disk_space.release_min_gb
if (-not (Test-DiskSpace -Path $srcTauriDir -MinGB $minGB)) {
    exit 1
}

Write-Host ""
Write-Host "  RUSTFLAGS = $($env.Rustflags)" -ForegroundColor DarkGray
Write-Host ""

# ============================================================
# [2/5] 构建 SPA（vite build → services/api/public）
# ============================================================
if (-not $SkipSPA) {
    Write-TauriStep "[2/5] 构建 SPA (vite build)..."

    # 为什么 SPA 要先构建：Tauri 的 webview 加载的是 services/api/public 中的静态资源
    # tauri build 不会自动构建 SPA，必须先构建好
    Set-Location $env.ProjectRoot

    # 清理旧构建产物
    $spaPublic = Join-Path $env.ProjectRoot "services\api\public"
    if (Test-Path $spaPublic) {
        Write-TauriStep "  清理旧 SPA 产物..."
        Remove-Item -Recurse -Force $spaPublic -ErrorAction SilentlyContinue
    }

    # 使用 Start-Process 调用 pnpm，避免 PowerShell 拦截 stderr（pnpm/vite 进度也走 stderr）
    $proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList "run","build" `
        -NoNewWindow -Wait -PassThru
    $spaExit = $proc.ExitCode

    if ($spaExit -ne 0) {
        Write-TauriErr "SPA 构建失败 (exit $spaExit)"
        exit $spaExit
    }

    # 验证 SPA 产物
    $indexHtml = Join-Path $spaPublic "index.html"
    if (-not (Test-Path $indexHtml)) {
        Write-TauriErr "SPA 构建产物缺失: $indexHtml"
        Write-TauriErr "检查 vite.config.ts 的 outDir 配置"
        exit 1
    }

    $spaSize = (Get-ChildItem $spaPublic -Recurse | Measure-Object -Property Length -Sum).Sum
    Write-TauriOk "SPA 构建完成: $([math]::Round($spaSize / 1KB, 2)) KB"
} else {
    Write-TauriStep "[2/5] 跳过 SPA 构建 (-SkipSPA)"
}

# ============================================================
# [3/5] tauri build (release)
# ============================================================
Write-TauriStep "[3/5] tauri build (release)..."
Write-TauriWarn "首次 Release 构建可能需要 10-30 分钟（编译所有 Rust 依赖的 release 版本）"
Write-Host ""

# Tauri 2.x 不支持 bundle.outputDir 配置，产物默认输出到 src-tauri/target/release/bundle/
# 构建完成后在第 [4/5] 步移动到 dist/tauri-bundle/（与 build-exe.bat 的 dist/ 目录规划一致）
$defaultBundleDir = Join-Path $env.ProjectRoot "$($Config.tauri.src_tauri_dir)\target\release\bundle"

# 清理旧产物（默认位置 + 目标位置都清理）
$bundleDir = Join-Path $env.ProjectRoot $Config.tauri.bundle_output_dir
foreach ($d in @($defaultBundleDir, $bundleDir)) {
    if (Test-Path $d) {
        Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
    }
}

$desktopDir = Join-Path $env.ProjectRoot $Config.tauri.desktop_dir
Set-Location $desktopDir

$buildScript = $Config.tauri.build_script
# 同 SPA 构建：用 Start-Process 调用 pnpm，避免 tauri/cargo 的 stderr 被拦截
$proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList "run",$buildScript `
    -NoNewWindow -Wait -PassThru
$buildExit = $proc.ExitCode

if ($buildExit -ne 0) {
    Write-TauriErr "tauri build 失败 (exit $buildExit)"
    Write-TauriErr "常见原因:"
    Write-TauriErr "  1. Rust release 编译错误 → 检查 cargo 错误信息"
    Write-TauriErr "  2. 资源文件缺失 → 检查 src-tauri/icons/ 目录"
    Write-TauriErr "  3. tauri.conf.json 配置错误 → 检查 bundle 配置"
    exit $buildExit
}
Write-TauriOk "tauri build 完成"

# ============================================================
# [4/5] 移动产物到 dist/tauri-bundle/
# ============================================================
Write-TauriStep "[4/5] 移动产物到 dist/tauri-bundle/..."

if (-not (Test-Path $defaultBundleDir)) {
    Write-TauriErr "tauri 默认 bundle 目录不存在: $defaultBundleDir"
    Write-TauriWarn "可能是 tauri.conf.json 中 bundle.active = false，仅生成 release exe"
    # 兜底：仅 release exe 场景无需移动
} else {
    # 预创建目标目录
    New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null

    # 移动 bundle 目录下所有内容到 dist/tauri-bundle/
    Move-Item -Path "$defaultBundleDir\*" -Destination $bundleDir -Force
    Write-TauriOk "产物已移动到: $bundleDir"

    # 移动后清理空的默认 bundle 目录
    if (Test-Path $defaultBundleDir) {
        Remove-Item -Recurse -Force $defaultBundleDir -ErrorAction SilentlyContinue
    }
}

# ============================================================
# [5/5] 验证产物
# ============================================================
Write-TauriStep "[5/5] 验证产物..."

# 查找安装包（优先从 dist/tauri-bundle/ 查找）
$installers = Get-ChildItem $bundleDir -Recurse -Include *.msi, *.exe, *.nsis -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch 'uninstall' }

if ($installers) {
    Write-TauriOk "找到安装包:"
    foreach ($installer in $installers) {
        $sizeMB = [math]::Round($installer.Length / 1MB, 2)
        Write-Host "    $($installer.FullName)" -ForegroundColor Green
        Write-Host "      大小: $sizeMB MB" -ForegroundColor Gray
    }
} else {
    # 检查 release exe（可能未生成 bundle，只生成了 release exe）
    $releaseExe = Join-Path $env.ProjectRoot "$($Config.tauri.src_tauri_dir)\target\release\$($Config.tauri.exe_name)"
    if (Test-Path $releaseExe) {
        $sizeMB = [math]::Round((Get-Item $releaseExe).Length / 1MB, 2)
        Write-TauriOk "Release exe: $releaseExe ($sizeMB MB)"
        Write-TauriWarn "未生成安装包（可能是 bundle.active=false），仅生成 exe"
    } else {
        Write-TauriErr "未找到任何构建产物"
        Write-TauriErr "检查: $bundleDir"
        exit 1
    }
}

# ============================================================
# 构建完成
# ============================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Tauri Package Build Complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  bundle 目录: $bundleDir" -ForegroundColor Gray
if ($installers) {
    Write-Host "  安装包数量: $($installers.Count)" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  下一步:" -ForegroundColor Cyan
Write-Host "    1. 测试安装包（双击 .msi 或 .exe 安装）"
Write-Host "    2. 验证安装后的应用能正常启动"
Write-Host ""
exit 0
