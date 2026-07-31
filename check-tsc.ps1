$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path 'd:\code\otherProjects\19_Karpathy-AI+Obsidian*\karpathy-wiki\frontend' | Select-Object -First 1).Path
$out = & npx vue-tsc --noEmit 2>&1
$out | Out-File -FilePath "$env:TEMP\tsc-output.txt" -Encoding utf8
Write-Host "ExitCode: $LASTEXITCODE"
Write-Host "Output lines: $($out.Count)"
Write-Host "----"
Get-Content "$env:TEMP\tsc-output.txt" -TotalCount 100
