# 预防性持久化 ES watermark 阈值
$esHost = "http://127.0.0.1:9001"
$headers = @{ "Content-Type" = "application/json" }

# 1. 检查并解锁
$health = Invoke-RestMethod -Uri "$esHost/_cluster/health" -Method Get -TimeoutSec 5
if ($health.read_only_allow_delete -eq $true) {
    Write-Host "ES_LOCKED: true - unlocking..."
    $unlockBody = '{"index.blocks.read_only_allow_delete": null}'
    Invoke-RestMethod -Uri "$esHost/_settings" -Method Put -Headers $headers -Body $unlockBody -TimeoutSec 10 | Out-Host
} else {
    Write-Host "ES_LOCKED: false - no unlock needed"
}

# 2. 持久化 watermark 阈值
$watermarkBody = @{
    persistent = @{
        "cluster.routing.allocation.disk.watermark.low" = "95%"
        "cluster.routing.allocation.disk.watermark.high" = "97%"
        "cluster.routing.allocation.disk.watermark.flood_stage" = "99%"
    }
} | ConvertTo-Json -Depth 5
Write-Host "WATERMARK_BODY: $watermarkBody"
$watermarkResult = Invoke-RestMethod -Uri "$esHost/_cluster/settings" -Method Put -Headers $headers -Body $watermarkBody -TimeoutSec 10
Write-Host "WATERMARK_ACK: $($watermarkResult.acknowledged)"

# 3. 验证
$verify = Invoke-RestMethod -Uri "$esHost/_cluster/settings?include_defaults=true&flat_settings=true" -Method Get -TimeoutSec 5
$verify.transient.PSObject.Properties | Where-Object { $_.Name -like "*watermark*" } | ForEach-Object { Write-Host "VERIFY_TRANSIENT: $($_.Name)=$($_.Value)" }
$verify.persistent.PSObject.Properties | Where-Object { $_.Name -like "*watermark*" } | ForEach-Object { Write-Host "VERIFY_PERSISTENT: $($_.Name)=$($_.Value)" }
$verify.defaults.PSObject.Properties | Where-Object { $_.Name -like "*watermark*flood*" } | ForEach-Object { Write-Host "VERIFY_DEFAULT: $($_.Name)=$($_.Value)" }
