cd "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki"
$env:PATH = "D:\code\nodejs24;" + $env:PATH
$NodeExe = "D:\code\nodejs24\node.exe"
$pkgBin = "node_modules\@yao-pkg\pkg\lib-es5\bin.js"
$bundleFile = ".build\bundle.cjs"
$exeDir = "dist\karpathy-wiki"
$exePath = Join-Path $exeDir "karpathy-wiki.exe"

if (Test-Path $exePath) { Remove-Item $exePath -Force -ErrorAction SilentlyContinue }
if (Test-Path $exeDir) { Remove-Item $exeDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force $exeDir | Out-Null

Write-Host "Running pkg..."
& $NodeExe $pkgBin $bundleFile --sea --output $exePath --options "max-old-space-size=512"
Write-Host "pkg exit: $LASTEXITCODE"
