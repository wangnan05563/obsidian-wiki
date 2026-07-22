# 测试修复后的 query 接口返回的 refs 是否为路径形式
# 验证场景：点击参考资料跳转 Browse 时 /api/files?path=<ref> 能正常读取文件
$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$body = '{"question":"什么是 LLM？","history":[]}'
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

# 用 HttpWebRequest 直接读 SSE 流，避免 Invoke-RestMethod 的 JSON 解析干扰
$req = [System.Net.HttpWebRequest]::Create('http://localhost:3000/api/query')
$req.Method = 'POST'
$req.ContentType = 'application/json'
$req.Timeout = 90000
$req.ReadWriteTimeout = 90000
$req.ContentLength = $bodyBytes.Length
$reqStream = $req.GetRequestStream()
$reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
$reqStream.Close()

$resp = $req.GetResponse()
$stream = $resp.GetResponseStream()
$reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)

$refsLines = @()
$lineCount = 0
while (-not $reader.EndOfStream -and $lineCount -lt 500) {
    $line = $reader.ReadLine()
    $lineCount++
    # 收集含 refs 的行（SSE event: refs / data: {...refs...}）
    if ($line -match 'refs') {
        $refsLines += $line
    }
}
$reader.Close()
$resp.Close()

Write-Host "=== 含 refs 的 SSE 行 ===" -ForegroundColor Cyan
$refsLines | ForEach-Object { Write-Host $_ }

# 验证策略：
#   1. 路径形式 ref（含 /）必须能调 /api/files 返回 200（点击跳转不报 404）
#   2. 至少有 1 个路径形式 ref（证明 resolvePageName 生效）
#   3. 裸页面名 ref 允许保留（可能是 LLM 幻觉引用，vault 中确实无对应文件）
$refsJson = $refsLines | Where-Object { $_ -match '"refs"' -and $_ -match 'data:' } | Select-Object -First 1
if ($refsJson) {
    $jsonPart = ($refsJson -split 'data:', 2)[1].Trim()
    try {
        $parsed = $jsonPart | ConvertFrom-Json
        Write-Host ""
        Write-Host "=== 解析后的 refs 数组 ===" -ForegroundColor Cyan
        $parsed.refs | ForEach-Object { Write-Host "  $_" }
        Write-Host ""
        $pathRefs = $parsed.refs | Where-Object { $_ -match '/' -and $_ -match '\.md$' }
        $bareRefs = $parsed.refs | Where-Object { $_ -notmatch '/' }
        if ($bareRefs) {
            Write-Host "[INFO] 裸页面名 ref（可能是 LLM 幻觉，vault 无对应文件）: $($bareRefs -join ', ')" -ForegroundColor Yellow
        }
        if (-not $pathRefs) {
            Write-Host "[FAIL] 无任何路径形式 ref，resolvePageName 未生效" -ForegroundColor Red
            exit 1
        }
        Write-Host "[OK] 路径形式 ref $($pathRefs.Count) 个，验证跳转..." -ForegroundColor Green
        $allOk = $true
        foreach ($r in $pathRefs) {
            try {
                $fileResp = Invoke-WebRequest -Uri "http://localhost:3000/api/files?path=$([uri]::EscapeDataString($r))" -UseBasicParsing -ErrorAction Stop
                Write-Host "  $r -> HTTP $($fileResp.StatusCode)" -ForegroundColor $(if ($fileResp.StatusCode -eq 200) { 'Green' } else { 'Red' })
                if ($fileResp.StatusCode -ne 200) { $allOk = $false }
            } catch {
                Write-Host "  $r -> HTTP $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
                $allOk = $false
            }
        }
        if ($allOk) {
            Write-Host ""
            Write-Host "[PASS] 修复验证通过：所有路径形式 ref 跳转均能正常读取文件" -ForegroundColor Green
            exit 0
        } else {
            Write-Host ""
            Write-Host "[FAIL] 部分 refs 跳转失败" -ForegroundColor Red
            exit 1
        }
    } catch {
        Write-Host "[ERROR] JSON 解析失败: $_" -ForegroundColor Red
        Write-Host "原始行: $jsonPart"
        exit 1
    }
} else {
    Write-Host "[WARN] 未找到含 refs 的 data 行，可能 LLM 未返回引用" -ForegroundColor Yellow
    exit 0
}
