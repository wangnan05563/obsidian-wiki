# fix-encoding-all.ps1
#
# 扫描以下范围内的文本文件，将 GBK 编码文件转为 UTF-8 无 BOM。
#   1) packages/web/src 与 services/api/src 下所有 .vue / .ts
#   2) 项目根 .gitignore / .editorconfig / .vscode/*.json / 根 *.md
# 跳过 .vue.js / .ts.js（Volar 预转换副本）。
#
# 调用方：Node 端 scripts/check-encoding.js --fix
# 设计原因：Node 调用 PowerShell -Command 模式对长字符串 + 中文路径支持差，
#           改为独立 .ps1 文件后用 -File 调用，可靠性显著提升。

$ErrorActionPreference = 'Stop'

$gbk = [System.Text.Encoding]::GetEncoding('GBK')
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$srcRoots = @(
  'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\packages\web\src',
  'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\services\api\src'
)

$repoRoot = 'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki'

$countTotal = 0
$countOk = 0
$countSkip = 0
$countGbk = 0
$countUtf8 = 0

function Test-IsGbkFile($path) {
  $b = [System.IO.File]::ReadAllBytes($path)
  if ($b.Length -eq 0) { return @{ IsGbk = $false; Reason = 'empty' } }
  $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  if ($hasBom) { return @{ IsGbk = $false; Reason = 'utf8-bom' } }
  # 先按 UTF-8 解码，若无 0xFFFD 且有中文 = 已是 UTF-8
  try {
    $tUtf8 = $utf8NoBom.GetString($b)
    $utf8HasFFFD = $tUtf8.Contains([char]0xFFFD)
    $utf8HasChinese = $tUtf8 -match '[\u4e00-\u9fff]'
    if (-not $utf8HasFFFD -and $utf8HasChinese) { return @{ IsGbk = $false; Reason = 'utf8' } }
  } catch { }
  # 再按 GBK 解码，判定"纯 GBK"才转码
  $tGbk = $gbk.GetString($b)
  $gbkHasFFFD = $tGbk.Contains([char]0xFFFD)
  $gbkHasGarbled = $tGbk.Contains('锟斤拷') -or $tGbk.Contains('烫烫烫') -or $tGbk.Contains('屯屯屯')
  $gbkHasChinese = $tGbk -match '[\u4e00-\u9fff]'
  if ($gbkHasChinese -and -not $gbkHasFFFD -and -not $gbkHasGarbled) {
    return @{ IsGbk = $true; Reason = 'gbk'; Bytes = $b; Text = $tGbk }
  }
  return @{ IsGbk = $false; Reason = 'mixed-or-other' }
}

# 1) 源码目录：.vue / .ts
foreach ($root in $srcRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Recurse -File -Include '*.vue','*.ts' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match '\.(vue|ts)\.js$') { return }
    $countTotal++
    $r = Test-IsGbkFile $_.FullName
    if ($r.IsGbk) {
      $bakPath = $_.FullName + '.gbk.bak'
      [System.IO.File]::WriteAllBytes($bakPath, $r.Bytes)
      $ub = $utf8NoBom.GetBytes($r.Text)
      [System.IO.File]::WriteAllBytes($_.FullName, $ub)
      $countGbk++; $countOk++
      Write-Output ("OK    {0}  {1} -> {2}  (backup: {3})" -f $_.FullName, $r.Bytes.Length, $ub.Length, $bakPath)
    } elseif ($r.Reason -eq 'utf8') {
      $countUtf8++
    } else {
      $countSkip++
      Write-Output ("SKIP  {0}  (reason={1})" -f $_.FullName, $r.Reason)
    }
  }
}

# 2) 元配置 + 根 .md
$metaNames = @('.gitignore', '.editorconfig', '.npmrc', '.prettierrc', '.prettierrc.json')
foreach ($n in $metaNames) {
  $p = Join-Path $repoRoot $n
  if (-not (Test-Path $p)) { continue }
  $countTotal++
  $r = Test-IsGbkFile $p
  if ($r.IsGbk) {
    $bakPath = $p + '.gbk.bak'
    [System.IO.File]::WriteAllBytes($bakPath, $r.Bytes)
    $ub = $utf8NoBom.GetBytes($r.Text)
    [System.IO.File]::WriteAllBytes($p, $ub)
    $countGbk++; $countOk++
    Write-Output ("OK    {0}  {1} -> {2}  (backup: {3})" -f $p, $r.Bytes.Length, $ub.Length, $bakPath)
  } elseif ($r.Reason -eq 'utf8') {
    $countUtf8++
  } else {
    $countSkip++
    Write-Output ("SKIP  {0}  (reason={1})" -f $p, $r.Reason)
  }
}
$vscodeDir = Join-Path $repoRoot '.vscode'
if (Test-Path $vscodeDir) {
  Get-ChildItem -Path $vscodeDir -File | ForEach-Object {
    if ($_.Extension -notin @('.json','.md','.txt','.yml','.yaml','.toml','.ini','.conf','.cfg')) { return }
    $countTotal++
    $r = Test-IsGbkFile $_.FullName
    if ($r.IsGbk) {
      $bakPath = $_.FullName + '.gbk.bak'
      [System.IO.File]::WriteAllBytes($bakPath, $r.Bytes)
      $ub = $utf8NoBom.GetBytes($r.Text)
      [System.IO.File]::WriteAllBytes($_.FullName, $ub)
      $countGbk++; $countOk++
      Write-Output ("OK    {0}  {1} -> {2}  (backup: {3})" -f $_.FullName, $r.Bytes.Length, $ub.Length, $bakPath)
    } elseif ($r.Reason -eq 'utf8') {
      $countUtf8++
    } else {
      $countSkip++
      Write-Output ("SKIP  {0}  (reason={1})" -f $_.FullName, $r.Reason)
    }
  }
}
Get-ChildItem -Path $repoRoot -File -Filter '*.md' | ForEach-Object {
  $countTotal++
  $r = Test-IsGbkFile $_.FullName
  if ($r.IsGbk) {
    $bakPath = $_.FullName + '.gbk.bak'
    [System.IO.File]::WriteAllBytes($bakPath, $r.Bytes)
    $ub = $utf8NoBom.GetBytes($r.Text)
    [System.IO.File]::WriteAllBytes($_.FullName, $ub)
    $countGbk++; $countOk++
    Write-Output ("OK    {0}  {1} -> {2}  (backup: {3})" -f $_.FullName, $r.Bytes.Length, $ub.Length, $bakPath)
  } elseif ($r.Reason -eq 'utf8') {
    $countUtf8++
  } else {
    $countSkip++
    Write-Output ("SKIP  {0}  (reason={1})" -f $_.FullName, $r.Reason)
  }
}

Write-Output ("=== Summary: total={0} utf8={1} converted={2} skipped={3} ===" -f $countTotal, $countUtf8, $countGbk, $countSkip)
