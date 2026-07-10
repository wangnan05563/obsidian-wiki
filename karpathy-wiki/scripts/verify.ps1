# 验证 .bat / .ps1 文件编码、行尾、BOM 是否符合 create-bat 技能规范
# 规范：
#   .bat  → GBK + 无 BOM + CRLF
#   .ps1  → UTF-8 with BOM + CRLF
# 用法: powershell -File verify.ps1 -TargetDir <DIR>

param(
    [Parameter(Mandatory=$true)][string]$TargetDir
)

$utf8Bom = [byte[]](0xEF, 0xBB, 0xBF)
$gbk = [System.Text.Encoding]::GetEncoding(936)
$pass = 0; $fail = 0

function Test-FileEncoding {
    param($path, $expectedEncoding, $expectBom)
    $b = [System.IO.File]::ReadAllBytes($path)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $issues = @()

    # BOM 检查
    if ($expectBom -and -not $hasBom) { $issues += "缺少 BOM" }
    if (-not $expectBom -and $hasBom) { $issues += "不应有 BOM" }

    # 行尾检查：孤立 LF 数应为 0（所有 LF 前必须有 CR）
    $lf = 0
    for ($i=0; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq 0x0A -and ($i -eq 0 -or $b[$i-1] -ne 0x0D)) { $lf++ }
    }
    if ($lf -gt 0) { $issues += "$lf 个孤立 LF 行尾（应为 CRLF）" }

    # 编码可解码性
    try {
        if ($expectedEncoding -eq 'GBK') { $null = $gbk.GetString($b) }
        elseif ($expectedEncoding -eq 'UTF8') { $null = [System.Text.Encoding]::UTF8.GetString($b) }
    } catch { $issues += "无法按 $expectedEncoding 解码" }

    return @{ issues = $issues; hasBom = $hasBom; lf = $lf }
}

# 验证所有 .bat（GBK + 无 BOM + CRLF）
Get-ChildItem $TargetDir -Filter '*.bat' -Recurse | ForEach-Object {
    $r = Test-FileEncoding $_.FullName 'GBK' $false
    if ($r.issues.Count -eq 0) { Write-Host "[PASS] $($_.Name) (GBK + 无BOM + CRLF)" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "[FAIL] $($_.Name): $($r.issues -join ', ')" -ForegroundColor Red; $script:fail++ }
}

# 验证所有 .ps1（UTF-8 + BOM + CRLF）
Get-ChildItem $TargetDir -Filter '*.ps1' -Recurse | ForEach-Object {
    $r = Test-FileEncoding $_.FullName 'UTF8' $true
    if ($r.issues.Count -eq 0) { Write-Host "[PASS] $($_.Name) (UTF-8 BOM + CRLF)" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "[FAIL] $($_.Name): $($r.issues -join ', ')" -ForegroundColor Red; $script:fail++ }
}

Write-Host ""
Write-Host "总计: $pass PASS, $fail FAIL" -ForegroundColor $(if ($fail -eq 0) {'Green'} else {'Red'})
exit $(if ($fail -eq 0) {0} else {1})
