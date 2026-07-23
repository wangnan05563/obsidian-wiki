# Bug #2 cache invalidation E2E verification
$ErrorActionPreference = 'Continue'
$target = 'entities/hundsun-bill-trading-platform.md'

function Invoke-HealthCheck {
  param([string]$Label)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/health-check' -Method POST -UseBasicParsing -TimeoutSec 60 -ContentType 'application/json' -Body '{}'
  $sw.Stop()
  $j = $r.Content | ConvertFrom-Json
  Write-Host ("[{0}] elapsed={1}ms orphans={2}" -f $Label, [int]$sw.Elapsed.TotalMilliseconds, $j.orphans.Count)
  return @{ ms = $sw.Elapsed.TotalMilliseconds; json = $j }
}

Write-Host "=== Bug #2 cache invalidation verification ==="
$r1 = Invoke-HealthCheck 'Step1-initial'
$r2 = Invoke-HealthCheck 'Step2-cache-hit'

Write-Host ""
Write-Host "--- Step 3: Trigger fix (should invalidate cache via finally) ---"
Write-Host "Fix target: $target"
$body = @{ issueType = 'orphan'; target = $target } | ConvertTo-Json -Compress
$sw3 = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $req = [System.Net.HttpWebRequest]::Create('http://localhost:3000/api/health-check/fix')
  $req.Method = 'POST'
  $req.ContentType = 'application/json'
  $req.Timeout = 120000
  $req.ReadWriteTimeout = 120000
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $req.ContentLength = $bytes.Length
  $reqStream = $req.GetRequestStream()
  $reqStream.Write($bytes, 0, $bytes.Length)
  $reqStream.Close()
  $resp = $req.GetResponse()
  $stream = $resp.GetResponseStream()
  $reader = New-Object System.IO.StreamReader($stream)
  $eventCount = 0
  $lastEvent = ''
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line -match '^event: ') { $lastEvent = $line }
    if ($line -match '^data: ') { $eventCount++ }
  }
  $reader.Close()
  $resp.Close()
  $sw3.Stop()
  Write-Host ("Step3 fix done: {0}s events={1} last={2}" -f [int]$sw3.Elapsed.TotalSeconds, $eventCount, $lastEvent)
} catch {
  $sw3.Stop()
  Write-Host ("Step3 fix ended: {0}s error={1}" -f [int]$sw3.Elapsed.TotalSeconds, $_.Exception.Message)
}

Write-Host ""
$r4 = Invoke-HealthCheck 'Step4-post-fix'
$r5 = Invoke-HealthCheck 'Step5-new-cache'

Write-Host ""
Write-Host "=== Summary ==="
$cacheHit2 = $r2.ms -lt 50
$cacheMiss4 = $r4.ms -gt 100
$cacheHit5 = $r5.ms -lt 50
Write-Host ("Step2 cache hit (fast):  {0} ({1}ms)" -f $cacheHit2, [int]$r2.ms)
Write-Host ("Step4 cache MISS (slow): {0} ({1}ms)" -f $cacheMiss4, [int]$r4.ms)
Write-Host ("Step5 cache hit (fast):  {0} ({1}ms)" -f $cacheHit5, [int]$r5.ms)
if ($cacheHit2 -and $cacheMiss4 -and $cacheHit5) {
  Write-Host "PASS: Bug #2 fix verified - cache invalidated after fix"
} else {
  Write-Host "FAIL: Cache behavior unexpected"
}
