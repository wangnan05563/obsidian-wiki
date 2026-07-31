$ErrorActionPreference = 'Continue'
$path = "$env:TEMP\e2e-output.txt"
if (Test-Path $path) {
    $content = Get-Content $path -Tail 80
    Write-Host "=== Last 80 lines ==="
    $content | ForEach-Object { Write-Host $_ }
    Write-Host "=== END ==="
} else {
    Write-Host "File not found: $path"
}
