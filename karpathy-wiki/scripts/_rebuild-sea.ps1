$distDir = "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\release\app\karpathy-wiki"
$NodeExe = "D:\code\nodejs24\node.exe"
$bundleFile = "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\.build\bundle.cjs"
$exePath = "$distDir\karpathy-wiki.exe"

# Remove old dist
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }

# Build SEA exe
& $NodeExe "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\node_modules\@yao-pkg\pkg\lib-es5\bin.js" $bundleFile --sea --output $exePath --options "max-old-space-size=512"

# Copy resources
Copy-Item -Path "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\prompts" -Destination $distDir -Recurse -Force
Copy-Item -Path "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\llm-presets.json" -Destination $distDir -Force -ErrorAction SilentlyContinue
if (Test-Path "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\release\spa\public") {
    Copy-Item -Path "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\release\spa\public" -Destination $distDir -Recurse -Force
}
$apiNodeModules = "D:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\node_modules"
$distNodeModules = "$distDir\node_modules"
if (Test-Path "$apiNodeModules\pdf-parse") {
    New-Item -ItemType Directory -Path $distNodeModules -Force | Out-Null
    Copy-Item -Path "$apiNodeModules\pdf-parse" -Destination "$distNodeModules\pdf-parse" -Recurse -Force
}

Write-Host "Build complete"
Get-ChildItem $distDir -Name
