#Requires -Version 5.1
# scripts/tauri-build-debug.ps1
# Tauri 桌面应用 Debug 编译脚本
# 步骤：环境配置 → 构建 SPA → cargo check → cargo build (debug)
# 为什么加入 SPA 构建：Tauri 桌面应用通过 sidecar 后端从 services/api/public/ 加载前端，
#   如果 SPA 未重新构建，悬浮窗口等前端改造不会生效（会加载旧版产物）。
# 配置驱动：所有路径从 config.json 读取

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$SkipSPA,
    [switch]$SkipCheck,
    [switch]$SkipBuild
)

# 加载共享模块
. (Join-Path $PSScriptRoot 'tauri-common.ps1')

$env = Initialize-TauriEnvironment -ConfigPath $ConfigPath
$Config = $env.Config

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Karpathy-Wiki Tauri Debug Build" -ForegroundColor Cyan
Write-Host "  项目目录: $($env.ProjectRoot)" -ForegroundColor DarkGray
Write-Host "  src-tauri: $($Config.tauri.src_tauri_dir)" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""

# 切换到 src-tauri 目录
$srcTauriDir = Join-Path $env.ProjectRoot $Config.tauri.src_tauri_dir
if (-not (Test-Path $srcTauriDir)) {
    Write-TauriErr "src-tauri 目录不存在: $srcTauriDir"
    exit 1
}
Set-Location $srcTauriDir

# ============================================================
# [1/4] 验证环境
# ============================================================
Write-TauriStep "[1/4] 验证环境..."

if (-not (Test-ToolAvailable 'cargo')) {
    Write-TauriErr "cargo 不可用，请先运行 tauri-setup.bat 配置环境"
    exit 1
}
Write-TauriOk "cargo: $(Get-Command cargo | Select-Object -ExpandProperty Source)"

if (-not (Test-Path $env.LdLld)) {
    Write-TauriErr "LLD 链接器缺失: $($env.LdLld)"
    exit 1
}
Write-TauriOk "LLD: $($env.LdLld)"

if (-not (Test-Path $env.WrapperExe)) {
    Write-TauriErr "windres.exe wrapper 缺失: $($env.WrapperExe)"
    Write-TauriWarn "请先运行 tauri-setup.bat 自动编译 wrapper"
    exit 1
}
Write-TauriOk "windres wrapper: $($env.WrapperExe)"

# 磁盘空间预检查（避免编译中途因空间不足失败）
$minGB = [double]$Config.disk_space.debug_min_gb
if (-not (Test-DiskSpace -Path $srcTauriDir -MinGB $minGB)) {
    exit 1
}

Write-Host ""
Write-Host "  RUSTFLAGS = $($env.Rustflags)" -ForegroundColor DarkGray
Write-Host "  WRAPPER_PS1 = $($env.WrapperPs1)" -ForegroundColor DarkGray
Write-Host ""

# ============================================================
# [2/4] 构建 SPA (vite build)
# ============================================================
# 为什么单独构建 SPA：Tauri 桌面应用通过 sidecar 后端从 services/api/public/ 加载前端，
# 若仅编译 Rust 不构建 SPA，悬浮窗口等前端改造会加载旧版产物而不生效。
if (-not $SkipSPA) {
    Write-TauriStep "[2/4] 构建 SPA (vite build)..."
    # 切换回项目根目录构建前端（前面 Set-Location 到了 src-tauri）
    Set-Location $env.ProjectRoot
    $spaPublic = Join-Path $env.ProjectRoot "services\api\public"
    if (Test-Path $spaPublic) {
        Write-TauriStep "  清理旧 SPA 产物..."
        Remove-Item -Recurse -Force $spaPublic -ErrorAction SilentlyContinue
    }
    # 使用 --filter 精准构建 @karpathy-wiki/web 包，避免触发根 pnpm build 递归构建 tauri
    # （tauri build 需要 windres wrapper 在 PATH 中，debug 上下文可能缺失）
    $proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList "--filter","@karpathy-wiki/web","build" `
        -NoNewWindow -Wait -PassThru
    $spaExit = $proc.ExitCode
    if ($spaExit -ne 0) {
        Write-TauriErr "SPA 构建失败 (exit $spaExit)"
        exit $spaExit
    }
    $indexHtml = Join-Path $spaPublic "index.html"
    if (-not (Test-Path $indexHtml)) {
        Write-TauriErr "SPA 构建产物缺失: $indexHtml"
        exit 1
    }
    Write-TauriOk "SPA 构建完成"
    # 构建完成后切回 src-tauri 目录继续 cargo 流程
    Set-Location $srcTauriDir
} else {
    Write-TauriStep "[2/4] 跳过 SPA 构建 (-SkipSPA)"
}

# ============================================================
# [3/4] cargo check
# ============================================================
if (-not $SkipCheck) {
    Write-TauriStep "[3/4] cargo check (验证编译)..."
    Write-TauriWarn "首次运行可能需要数分钟下载依赖"

    # 使用 Start-Process 调用 cargo，避免 PowerShell 拦截 stderr 输出：
    # cargo 按惯例把编译进度（Compiling.../Finished...）写到 stderr，
    # PowerShell 默认会把每行 stderr 包装成 NativeCommandError 红色记录，
    # 即使 exit code 为 0 也会显示为错误，误导用户。Start-Process -NoNewWindow
    # 让子进程直接使用父控制台，stdout/stderr 原样显示，PowerShell 不拦截。
    $proc = Start-Process -FilePath "cargo" -ArgumentList "check","--color","always" `
        -NoNewWindow -Wait -PassThru
    $checkExit = $proc.ExitCode

    if ($checkExit -ne 0) {
        Write-TauriErr "cargo check 失败 (exit $checkExit)"
        Write-TauriErr "常见原因:"
        Write-TauriErr "  1. windres wrapper 编译失败 → 检查 scripts\windres.exe 是否存在"
        Write-TauriErr "  2. LLD 链接器路径错误 → 检查 config.json mingw 段"
        Write-TauriErr "  3. Cargo.toml 配置错误 → 检查 packages\desktop\src-tauri\Cargo.toml"
        exit $checkExit
    }
    Write-TauriOk "cargo check 通过"
} else {
    Write-TauriStep "[3/4] 跳过 cargo check (-SkipCheck)"
}

# ============================================================
# [4/4] cargo build (debug)
# ============================================================
if (-not $SkipBuild) {
    Write-TauriStep "[4/4] cargo build (debug)..."
    Write-TauriWarn "首次构建可能需要 5-10 分钟"

    # 同 cargo check：用 Start-Process 让 cargo 直接写控制台，避免 stderr 被拦截
    $proc = Start-Process -FilePath "cargo" -ArgumentList "build","--color","always" `
        -NoNewWindow -Wait -PassThru
    $buildExit = $proc.ExitCode

    if ($buildExit -ne 0) {
        Write-TauriErr "cargo build 失败 (exit $buildExit)"
        exit $buildExit
    }
    Write-TauriOk "cargo build 完成"
} else {
    Write-TauriStep "[4/4] 跳过 cargo build (-SkipBuild)"
}

# 验证产物
$exeName = $Config.tauri.exe_name
$exePath = Join-Path $srcTauriDir "target\debug\$exeName"
if (Test-Path $exePath) {
    $exeInfo = Get-Item $exePath
    Write-TauriOk "产物: $exePath"
    Write-TauriOk "大小: $([math]::Round($exeInfo.Length / 1MB, 2)) MB"
    Write-TauriOk "编译时间: $($exeInfo.LastWriteTime)"
} else {
    Write-TauriWarn "exe 产物未找到: $exePath (可能只运行了 check)"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Debug Build Complete" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  产物: $exePath" -ForegroundColor Gray
Write-Host "  启动: 双击 scripts\tauri-start.bat" -ForegroundColor Gray
Write-Host ""
exit 0
