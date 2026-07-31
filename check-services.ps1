$ErrorActionPreference = 'Continue'

Write-Host '=== Port 3000 ===' -ForegroundColor Cyan
$p3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p3000) {
    $p3000 | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
} else {
    Write-Host 'NOT LISTENING'
}

Write-Host '=== Port 5173 ===' -ForegroundColor Cyan
$p5173 = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($p5173) {
    $p5173 | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
} else {
    Write-Host 'NOT LISTENING'
}

Write-Host '=== Health Check ===' -ForegroundColor Cyan
try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3000/health' -UseBasicParsing -TimeoutSec 5
    Write-Host "Status: $($r.StatusCode)"
    Write-Host $r.Content
} catch {
    Write-Host "HEALTH FAILED: $($_.Exception.Message)"
}
