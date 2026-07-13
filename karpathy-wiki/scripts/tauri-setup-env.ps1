#Requires -Version 5.1
# scripts/tauri-setup-env.ps1
# Tauri 桌面应用环境配置脚本
# 检测并安装 Rust GNU 工具链、w64devkit、windres wrapper
# 配置驱动：所有路径从 config.json 读取

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$SkipSystem
)

# 加载共享模块
. (Join-Path $PSScriptRoot 'tauri-common.ps1')

$env = Initialize-TauriEnvironment -ConfigPath $ConfigPath
$Config = $env.Config

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host "  Karpathy-Wiki Tauri 环境配置" -ForegroundColor Cyan
Write-Host "  项目目录: $($env.ProjectRoot)" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor DarkCyan
Write-Host ""

# ============================================================
# [1/6] 检查 Rust 工具链
# ============================================================
Write-TauriStep "[1/6] 检查 Rust 工具链..."

$expectedToolchain = $Config.rust.toolchain
$rustAvailable = $false

if (Test-ToolAvailable 'rustc') {
    $rustVer = & rustc --version 2>$null
    Write-TauriOk "Rust: $rustVer"

    # 检查工具链是否为 GNU（不是 MSVC）
    $rustHost = & rustc -vV 2>$null | Select-String 'host:'
    if ($rustHost -match 'gnu') {
        Write-TauriOk "Toolchain: GNU (匹配中文路径需求)"
        $rustAvailable = $true
    } else {
        Write-TauriWarn "当前 toolchain 非 GNU: $rustHost"
        Write-TauriStep "尝试切换到 $expectedToolchain..."
        & rustup default $expectedToolchain 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-TauriOk "已切换到 $expectedToolchain"
            $rustAvailable = $true
        } else {
            Write-TauriStep "安装 $expectedToolchain..."
            & rustup toolchain install $expectedToolchain 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                & rustup default $expectedToolchain 2>&1 | Out-Null
                Write-TauriOk "已安装并切换到 $expectedToolchain"
                $rustAvailable = $true
            }
        }
    }
} else {
    Write-TauriWarn "未检测到 rustc，尝试通过 rustup 安装..."
    if (Test-ToolAvailable 'rustup') {
        & rustup default $expectedToolchain 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-TauriOk "Rust 工具链已安装"
            $rustAvailable = $true
        }
    } elseif (-not $SkipSystem) {
        Write-TauriStep "通过 winget 安装 Rustup..."
        if (Test-ToolAvailable 'winget') {
            & winget install --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements --silent
            if ($LASTEXITCODE -eq 0) {
                # 刷新 PATH
                $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
                if (Test-ToolAvailable 'rustup') {
                    & rustup default $expectedToolchain 2>&1 | Out-Null
                    $rustAvailable = $true
                    Write-TauriOk "Rust 已通过 winget 安装"
                }
            }
        }
    }
}

if (-not $rustAvailable) {
    Write-TauriErr "Rust 工具链不可用。请手动安装: https://rustup.rs"
    Write-TauriErr "然后运行: rustup toolchain install $expectedToolchain && rustup default $expectedToolchain"
    exit 1
}

# ============================================================
# [2/6] 检查 cargo bin 目录
# ============================================================
Write-TauriStep "[2/6] 检查 cargo bin 目录..."

if (-not (Assert-PathExists $env.CargoBin "cargo bin 目录")) {
    Write-TauriWarn "cargo bin 目录不存在，可能是首次安装 Rust"
    Write-TauriStep "尝试创建: $($env.CargoBin)"
    New-Item -ItemType Directory -Force $env.CargoBin | Out-Null
    if (Test-Path $env.CargoBin) {
        Write-TauriOk "cargo bin 目录已创建"
    } else {
        Write-TauriErr "无法创建 cargo bin 目录"
        exit 1
    }
} else {
    Write-TauriOk "cargo bin: $($env.CargoBin)"
}

# ============================================================
# [3/6] 检查 w64devkit
# ============================================================
Write-TauriStep "[3/6] 检查 w64devkit (MinGW-w64 + LLD)..."

if (-not (Assert-PathExists $env.MingwRoot "w64devkit 根目录")) {
    Write-TauriErr "w64devkit 未找到: $($env.MingwRoot)"
    Write-TauriErr "请从 https://github.com/skeeto/w64devkit/releases 下载 w64devkit-x.x.x.zip"
    Write-TauriErr "解压到项目根目录的 w64devkit/ 子目录（与 karpathy-wiki/ 同级）"
    exit 1
}

if (-not (Assert-PathExists $env.MingwBin "w64devkit bin 目录")) {
    exit 1
}

if (-not (Assert-PathExists $env.LdLld "ld.lld.exe (LLD 链接器)")) {
    Write-TauriErr "LLD 链接器缺失，w64devkit 安装可能不完整"
    exit 1
}

$windresReal = Join-Path $env.MingwBin $Config.mingw.windres_name
if (-not (Assert-PathExists $windresReal "windres.exe (GNU 资源编译器)")) {
    exit 1
}

Write-TauriOk "w64devkit: $($env.MingwRoot)"
Write-TauriOk "LLD 链接器: $($env.LdLld)"

# ============================================================
# [4/6] 检查 windres wrapper
# ============================================================
Write-TauriStep "[4/6] 检查 windres wrapper (中文路径编码修复)..."

if (-not (Assert-PathExists $env.WrapperPs1 "windres-wrapper.ps1")) {
    Write-TauriErr "windres-wrapper.ps1 缺失，此脚本用于将 .rc 中的中文路径重写为英文临时路径"
    exit 1
}

if (-not (Assert-PathExists $env.WrapperExe "windres.exe wrapper (C 编译)")) {
    Write-TauriWarn "windres.exe wrapper 未编译，尝试编译..."
    $wrapperC = Join-Path $env.ScriptDir "windres-wrapper.c"
    if (Test-Path $wrapperC) {
        $gcc = Join-Path $env.MingwBin "gcc.exe"
        if (Test-Path $gcc) {
            & $gcc -o $env.WrapperExe $wrapperC 2>&1
            if ($LASTEXITCODE -eq 0 -and (Test-Path $env.WrapperExe)) {
                Write-TauriOk "windres.exe wrapper 已编译"
            } else {
                Write-TauriErr "windres.exe wrapper 编译失败"
                exit 1
            }
        } else {
            Write-TauriErr "gcc.exe 未找到，无法编译 wrapper"
            exit 1
        }
    } else {
        Write-TauriErr "windres-wrapper.c 源文件缺失"
        exit 1
    }
} else {
    Write-TauriOk "windres.exe wrapper: $($env.WrapperExe)"
}

# ============================================================
# [5/6] 检查 Tauri CLI + 项目依赖
# ============================================================
Write-TauriStep "[5/6] 检查 Tauri CLI + 项目依赖..."

$desktopDir = Join-Path $env.ProjectRoot $Config.tauri.desktop_dir
if (-not (Assert-PathExists $desktopDir "Tauri 桌面应用目录")) {
    exit 1
}

$srcTauriDir = Join-Path $env.ProjectRoot $Config.tauri.src_tauri_dir
if (-not (Assert-PathExists $srcTauriDir "src-tauri 目录")) {
    exit 1
}

# 检查 pnpm
if (-not (Test-ToolAvailable 'pnpm.cmd')) {
    if (-not (Test-ToolAvailable 'pnpm')) {
        Write-TauriWarn "pnpm 未找到，尝试安装..."
        if (Test-ToolAvailable 'npm') {
            & npm install -g pnpm 2>&1 | Out-Null
            # 刷新 PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        }
    }
}

# 检查根 node_modules
$rootNodeModules = Join-Path $env.ProjectRoot "node_modules"
if (-not (Test-Path $rootNodeModules)) {
    Write-TauriWarn "根 node_modules 不存在，运行 pnpm install..."
    Push-Location $env.ProjectRoot
    try {
        & pnpm.cmd install 2>&1 | Out-Null
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $rootNodeModules)) {
        Write-TauriErr "pnpm install 失败，请手动运行 pnpm install"
        exit 1
    }
}
Write-TauriOk "node_modules: $rootNodeModules"

# 检查 desktop node_modules
$desktopNodeModules = Join-Path $desktopDir "node_modules"
if (-not (Test-Path $desktopNodeModules)) {
    Write-TauriWarn "desktop node_modules 不存在，运行 pnpm install..."
    Push-Location $desktopDir
    try {
        & pnpm.cmd install 2>&1 | Out-Null
    } finally {
        Pop-Location
    }
}
Write-TauriOk "desktop 目录: $desktopDir"

# ============================================================
# [6/6] 验证环境配置
# ============================================================
Write-TauriStep "[6/6] 验证环境配置..."

$checklist = @(
    @{ Name = "Rust toolchain ($expectedToolchain)"; Test = { Test-ToolAvailable 'rustc' } },
    @{ Name = "cargo"; Test = { Test-ToolAvailable 'cargo' } },
    @{ Name = "w64devkit (LLD)"; Test = { Test-Path $env.LdLld } },
    @{ Name = "windres.exe wrapper"; Test = { Test-Path $env.WrapperExe } },
    @{ Name = "windres-wrapper.ps1"; Test = { Test-Path $env.WrapperPs1 } },
    @{ Name = "Tauri src-tauri 目录"; Test = { Test-Path $srcTauriDir } },
    @{ Name = "根 node_modules"; Test = { Test-Path $rootNodeModules } }
)

$allPass = $true
foreach ($item in $checklist) {
    if (& $item.Test) {
        Write-TauriOk "$($item.Name) √"
    } else {
        Write-TauriErr "$($item.Name) ×"
        $allPass = $false
    }
}

# 输出当前环境配置摘要
Write-Host ""
Write-Host "---- 环境配置摘要 ----" -ForegroundColor DarkGray
Write-Host "  PATH 前缀: $($env.CargoBin); $($env.ScriptDir); $($env.MingwBin)" -ForegroundColor DarkGray
Write-Host "  RUSTFLAGS: $($env.Rustflags)" -ForegroundColor DarkGray
Write-Host "  WRAPPER_PS1: $($env.WrapperPs1)" -ForegroundColor DarkGray
Write-Host ""

if ($allPass) {
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  Tauri 环境配置完成！" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "下一步操作:" -ForegroundColor Cyan
    Write-Host "  编译:       双击 scripts\tauri-build.bat"
    Write-Host "  启动服务:   双击 scripts\tauri-start.bat"
    Write-Host "  停止服务:   双击 scripts\tauri-stop.bat"
    Write-Host "  构建打包:   双击 scripts\tauri-package.bat"
    Write-Host ""
    exit 0
} else {
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host "  部分检查未通过，请按上述提示修复后重跑" -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Yellow
    exit 1
}
