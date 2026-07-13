#Requires -Version 5.1
# scripts/verify-tauri.ps1
# 验证 Tauri 脚本套件的编码、行尾、BOM、非 ASCII 字节是否符合 create-bat skill 规范
# 用法: powershell -File scripts/verify-tauri.ps1

param(
    [string]$TargetDir = "$PSScriptRoot"
)

$pass = 0
$fail = 0

function Test-FileEncoding {
    param($path, $expectedEncoding, $expectBom)

    $b = [System.IO.File]::ReadAllBytes($path)
    $issues = @()

    # BOM 检查
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    if ($expectBom -and -not $hasBom) { $issues += "Missing BOM" }
    if (-not $expectBom -and $hasBom) { $issues += "Unexpected BOM" }

    # 行尾检查（孤立 LF）
    $orphanLf = 0
    for ($i = 0; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq 0x0A -and ($i -eq 0 -or $b[$i - 1] -ne 0x0D)) { $orphanLf++ }
    }
    if ($orphanLf -gt 0) { $issues += "$orphanLf orphan LF line endings (need CRLF)" }

    # .bat 专有：非 ASCII 字节检查（纯 ASCII 策略）
    if ($expectedEncoding -eq 'ASCII') {
        $nonAscii = 0
        foreach ($byte in $b) {
            if ($byte -gt 127) { $nonAscii++ }
        }
        if ($nonAscii -gt 0) { $issues += "$nonAscii non-ASCII bytes (must be 0 for .bat)" }
    }

    return @{ issues = $issues; hasBom = $hasBom; orphanLf = $orphanLf }
}

# 验证 Tauri 相关 .bat 文件（纯 ASCII + 无 BOM + CRLF）
$tauriBats = @(
    'tauri-setup.bat',
    'tauri-build.bat',
    'tauri-start.bat',
    'tauri-stop.bat',
    'tauri-package.bat'
)

Write-Host "=== Tauri .bat files (ASCII + no BOM + CRLF) ===" -ForegroundColor Cyan
foreach ($name in $tauriBats) {
    $path = Join-Path $TargetDir $name
    if (-not (Test-Path $path)) {
        Write-Host "[FAIL] $name not found" -ForegroundColor Red
        $fail++
        continue
    }
    $r = Test-FileEncoding $path 'ASCII' $false
    if ($r.issues.Count -eq 0) {
        Write-Host "[PASS] $name" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "[FAIL] $name : $($r.issues -join ', ')" -ForegroundColor Red
        $fail++
    }
}

# 验证 Tauri 相关 .ps1 文件（UTF-8 + BOM + CRLF）
$tauriPs1s = @(
    'tauri-common.ps1',
    'tauri-setup-env.ps1',
    'tauri-build-debug.ps1',
    'tauri-start.ps1',
    'tauri-stop.ps1',
    'tauri-build-release.ps1'
)

Write-Host ""
Write-Host "=== Tauri .ps1 files (UTF-8 + BOM + CRLF) ===" -ForegroundColor Cyan
foreach ($name in $tauriPs1s) {
    $path = Join-Path $TargetDir $name
    if (-not (Test-Path $path)) {
        Write-Host "[FAIL] $name not found" -ForegroundColor Red
        $fail++
        continue
    }
    $r = Test-FileEncoding $path 'UTF8' $true
    if ($r.issues.Count -eq 0) {
        Write-Host "[PASS] $name" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "[FAIL] $name : $($r.issues -join ', ')" -ForegroundColor Red
        $fail++
    }
}

# 验证 .ps1 语法（PS 5.1 Parser）
Write-Host ""
Write-Host "=== PS Parser syntax check ===" -ForegroundColor Cyan
foreach ($name in $tauriPs1s) {
    $path = Join-Path $TargetDir $name
    if (-not (Test-Path $path)) { continue }
    $errors = $null
    $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        Write-Host "[FAIL] $name : $($errors.Count) syntax errors" -ForegroundColor Red
        $errors | ForEach-Object { Write-Host "  Line $($_.Extent.StartLineNumber): $($_.Message)" -ForegroundColor Red }
        $fail++
    } else {
        Write-Host "[PASS] $name syntax OK" -ForegroundColor Green
        $pass++
    }
}

# 验证 config.json 可解析
Write-Host ""
Write-Host "=== config.json validation ===" -ForegroundColor Cyan
$configPath = Join-Path $TargetDir "config.json"
if (Test-Path $configPath) {
    try {
        $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($config.tauri -and $config.rust -and $config.mingw) {
            Write-Host "[PASS] config.json has tauri/rust/mingw sections" -ForegroundColor Green
            $pass++
        } else {
            Write-Host "[FAIL] config.json missing required sections (tauri/rust/mingw)" -ForegroundColor Red
            $fail++
        }
    } catch {
        Write-Host "[FAIL] config.json parse error: $_" -ForegroundColor Red
        $fail++
    }
} else {
    Write-Host "[FAIL] config.json not found" -ForegroundColor Red
    $fail++
}

Write-Host ""
Write-Host "Total: $pass PASS, $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $(if ($fail -eq 0) { 0 } else { 1 })
