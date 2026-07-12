$ErrorActionPreference = 'Stop'

$scriptPath = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.bat' |
    Where-Object { (Get-Content -LiteralPath $_.FullName -Raw -Encoding Default) -match '(?m)^set PKG_CMD=' } |
    Select-Object -First 1

if (-not $scriptPath) {
    throw 'Could not locate the frontend build batch script.'
}

$content = Get-Content -LiteralPath $scriptPath.FullName -Raw -Encoding Default

if ($content -notmatch '(?m)^call %PKG_CMD% run build\r?$') {
    throw 'The frontend build script must use call so control returns after npm.cmd/pnpm.cmd.'
}

Write-Host '[PASS] The frontend build command returns to the current batch script.'
