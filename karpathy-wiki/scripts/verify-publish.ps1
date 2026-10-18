#Requires -Version 5.1
# 验证一键发布脚本是否符合 create-bat 技能规范：
#   .bat  -> 纯 ASCII + 无 BOM + CRLF
#   .ps1  -> UTF-8 BOM + CRLF + PowerShell 语法可解析
# 用法: powershell -File verify-publish.ps1 [-ScriptDir <DIR>]

param([string]$ScriptDir = $PSScriptRoot)

$pass = 0; $fail = 0

function Check-Bat([string]$p) {
    $b = [IO.File]::ReadAllBytes($p)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $nonAscii = 0
    foreach ($x in $b) { if ($x -gt 127) { $nonAscii++ } }
    $lf = 0
    for ($i = 0; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq 0x0A -and ($i -eq 0 -or $b[$i - 1] -ne 0x0D)) { $lf++ }
    }
    $issues = @()
    if ($hasBom) { $issues += 'BOM present' }
    if ($nonAscii -gt 0) { $issues += "$nonAscii non-ASCII bytes" }
    if ($lf -gt 0) { $issues += "$lf orphan LF" }
    if ($issues.Count -eq 0) {
        Write-Host "[PASS] $(Split-Path $p -Leaf) (ASCII + noBOM + CRLF)" -ForegroundColor Green; $script:pass++
    } else {
        Write-Host "[FAIL] $(Split-Path $p -Leaf): $($issues -join ', ')" -ForegroundColor Red; $script:fail++
    }
}

function Check-Ps1([string]$p) {
    $b = [IO.File]::ReadAllBytes($p)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $lf = 0
    for ($i = 0; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq 0x0A -and ($i -eq 0 -or $b[$i - 1] -ne 0x0D)) { $lf++ }
    }
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs)
    $issues = @()
    if (-not $hasBom) { $issues += 'missing BOM' }
    if ($lf -gt 0) { $issues += "$lf orphan LF" }
    if ($errs.Count -gt 0) { $issues += "$($errs.Count) parse error(s)" }
    if ($issues.Count -eq 0) {
        Write-Host "[PASS] $(Split-Path $p -Leaf) (UTF8-BOM + CRLF + syntax-ok)" -ForegroundColor Green; $script:pass++
    } else {
        Write-Host "[FAIL] $(Split-Path $p -Leaf): $($issues -join ', ')" -ForegroundColor Red; $script:fail++
    }
}

Write-Host "=== verify publish scripts (create-bat rules) ===" -ForegroundColor Cyan
Get-ChildItem $ScriptDir -Filter '*.bat' | ForEach-Object { Check-Bat $_.FullName }
Check-Ps1 (Join-Path $ScriptDir 'publish-wiki.ps1')
Write-Host ""
Write-Host "Total: $pass PASS, $fail FAIL" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $(if ($fail -eq 0) { 0 } else { 1 })
