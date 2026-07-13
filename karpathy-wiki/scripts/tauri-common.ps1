#Requires -Version 5.1
# scripts/tauri-common.ps1
# Tauri 桌面应用共享环境配置模块
# 所有 Tauri 脚本通过 dot-source 加载此模块，统一环境配置逻辑
# 配置驱动：所有路径/参数从 config.json 读取，无硬编码

# 加载配置并设置 Tauri 编译环境（LLD 链接器 + windres wrapper）
# 返回 Config 对象供调用方使用
function Initialize-TauriEnvironment {
    param(
        [string]$ConfigPath = "$PSScriptRoot\config.json"
    )

    $ErrorActionPreference = "Stop"

    # --- 控制台输出编码对齐 ---
    # 从 cmd.exe 调用时 .ps1 默认按系统 ANSI 输出，与 .bat 的 chcp 65001 不匹配会导致中文乱码
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $OutputEncoding = [System.Text.Encoding]::UTF8
    } catch {
        # ISE/VS Code 终端等宿主不支持设置输出编码，忽略错误
    }

    # --- 加载配置 ---
    if (-not (Test-Path $ConfigPath)) {
        throw "config.json not found: $ConfigPath"
    }
    $Config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

    # --- 计算关键路径 ---
    $ScriptDir = $PSScriptRoot
    $ProjectRoot = (Resolve-Path (Join-Path $ScriptDir $Config.project.root)).Path

    $MingwRoot = Join-Path $ProjectRoot $Config.mingw.root_rel
    $MingwBin = Join-Path $MingwRoot $Config.mingw.bin_subdir
    $MingwLib = Join-Path $MingwRoot $Config.mingw.lib_subdir
    $MingwGccLib = Join-Path $MingwRoot $Config.mingw.gcc_lib_subdir
    $LdLld = Join-Path $MingwBin $Config.mingw.ld_lld_name

    $CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    $WrapperPs1 = Join-Path $ScriptDir "windres-wrapper.ps1"
    $WrapperExe = Join-Path $ScriptDir "windres.exe"

    # --- 设置 PATH ---
    # 优先级：cargo bin > scripts wrapper > w64devkit bin > 原 PATH
    # 为什么 scripts 目录要在 w64devkit 前：让 embed-resource 找到我们的 windres.exe wrapper
    $env:Path = "$CargoBin;$ScriptDir;$MingwBin;$env:Path"

    # --- 设置 WRAPPER_PS1 环境变量 ---
    # windres.exe wrapper（C 编译）会读取此变量调用 PowerShell 脚本
    $env:WRAPPER_PS1 = $WrapperPs1

    # --- 设置 RUSTFLAGS ---
    # 为什么用 LLD：GNU ld 用 GBK 解析路径，中文路径会失败；LLD 原生支持 UTF-8
    # 为什么 link-self-contained：让 rustc 自管理 CRT 对象，避免手动添加 crt2.o 等
    $rustflagsTemplate = $Config.rust.rustflags_template
    $env:RUSTFLAGS = $rustflagsTemplate `
        -replace '\{ld_lld\}', $LdLld `
        -replace '\{lib1\}', $MingwLib `
        -replace '\{lib2\}', $MingwGccLib

    # --- 返回环境信息对象 ---
    return [PSCustomObject]@{
        Config = $Config
        ScriptDir = $ScriptDir
        ProjectRoot = $ProjectRoot
        MingwRoot = $MingwRoot
        MingwBin = $MingwBin
        LdLld = $LdLld
        WrapperPs1 = $WrapperPs1
        WrapperExe = $WrapperExe
        CargoBin = $CargoBin
        Rustflags = $env:RUSTFLAGS
    }
}

# 统一日志输出函数
function Write-TauriStep { param($msg) Write-Host "[Tauri] $msg" -ForegroundColor Cyan }
function Write-TauriOk { param($msg) Write-Host "[Tauri]   [OK] $msg" -ForegroundColor Green }
function Write-TauriWarn { param($msg) Write-Host "[Tauri]   [WARN] $msg" -ForegroundColor Yellow }
function Write-TauriErr { param($msg) Write-Host "[Tauri]   [FAIL] $msg" -ForegroundColor Red }

# 检查工具是否可用
function Test-ToolAvailable {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# 检查文件/目录是否存在并报告
function Assert-PathExists {
    param([string]$Path, [string]$Description)
    if (-not (Test-Path $Path)) {
        Write-TauriErr "$Description not found: $Path"
        return $false
    }
    return $true
}

# 检查指定路径所在磁盘的可用空间是否足够
# 为什么需要：cargo 编译产物（rmeta/rlib）会占数 GB，磁盘空间不足会导致编译中途失败
# 返回 $true 表示空间足够，$false 表示不足（已输出错误提示）
function Test-DiskSpace {
    param(
        [string]$Path,
        [double]$MinGB
    )
    # 解析路径所在盘符
    $fullPath = (Resolve-Path $Path -ErrorAction SilentlyContinue).Path
    if (-not $fullPath) { $fullPath = $Path }
    if ($fullPath -match '^([A-Za-z]:)') {
        $driveLetter = $matches[1]
    } else {
        # UNC 或相对路径无法直接判断盘符，跳过检查
        return $true
    }
    $drive = Get-PSDrive -Name $driveLetter[0] -ErrorAction SilentlyContinue
    if (-not $drive) { return $true }
    $freeGB = [math]::Round($drive.Free / 1GB, 2)
    if ($freeGB -lt $MinGB) {
        Write-TauriErr "磁盘 $driveLetter 可用空间不足: $freeGB GB (要求 >= $MinGB GB)"
        Write-TauriErr "请清理 $driveLetter 盘空间后重试:"
        Write-TauriErr "  - 清理 target 目录: cargo clean"
        Write-TauriErr "  - 清理旧日志: del logs\*.log"
        Write-TauriErr "  - 清理 Windows 临时文件"
        return $false
    }
    Write-TauriOk "磁盘 $driveLetter 可用空间: $freeGB GB (要求 >= $MinGB GB)"
    return $true
}
