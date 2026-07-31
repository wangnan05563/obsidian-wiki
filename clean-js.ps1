$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path 'd:\code\otherProjects\19_Karpathy-AI+Obsidian*\').Path
$src = Join-Path $projectRoot 'karpathy-wiki\frontend\src'
Write-Host "src: $src"
Get-ChildItem -Path $src -Recurse -Filter '*.js' | Where-Object { $_.Name -ne 'main.js' } | ForEach-Object {
    Remove-Item -Path $_.FullName -Force
    Write-Host "Removed: $($_.FullName)"
}
Write-Host '---DONE---'
