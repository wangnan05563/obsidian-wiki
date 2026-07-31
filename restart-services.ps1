$ErrorActionPreference = 'Continue'
$projectRoot = (Resolve-Path 'd:\code\otherProjects\19_Karpathy-AI+Obsidian*\').Path
Set-Location $projectRoot

# 1. 清理 Vite 缓存
$frontendDir = Join-Path $projectRoot 'karpathy-wiki\frontend'
Get-ChildItem -Path $frontendDir -Recurse -Force -Directory | Where-Object { $_.Name -eq 'node_modules' -or $_.Name -eq '.vite' } | ForEach-Object {
    Get-ChildItem -Path $_.FullName -Directory | Where-Object { $_.Name -eq '.vite' -or $_.Name -eq 'cache' } | ForEach-Object {
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Cleaned: $($_.FullName)"
    }
}

# 2. 停止现有服务
Write-Host "--- Stopping services ---"
& "$projectRoot\karpathy-wiki\scripts\stop-service.bat" 2>&1 | Out-Null
Start-Sleep -Seconds 3

# 3. 重启服务
Write-Host "--- Starting services ---"
& "$projectRoot\karpathy-wiki\scripts\start-service.bat" 2>&1 | Out-Null
Write-Host "--- Services started ---"
