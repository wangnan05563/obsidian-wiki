# SonarQube 分析令牌必须由调用方在环境中提供，禁止写死在脚本里（历史提交中的旧令牌需轮换）
if (-not $env:SONAR_TOKEN) { Write-Error "请先设置环境变量 SONAR_TOKEN（SonarQube 分析令牌）"; exit 1 }
$logFile = "$env:TEMP\sonar-scan-final.log"
$scanner = "D:\code\sonar\sonar-scanner-8.0.1.6346-windows-x64\bin\sonar-scanner.bat"
$workDir = "d:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\frontend"

Set-Location $workDir
& $scanner "-Dsonar.projectKey=karpathy_wiki_web" "-Dsonar.sources=src" "-Dsonar.host.url=http://localhost:9000" "-Dsonar.token=$env:SONAR_TOKEN" 2>&1 | Out-File -FilePath $logFile -Encoding UTF8
"EXIT_CODE: $LASTEXITCODE" | Out-File -FilePath $logFile -Append -Encoding UTF8
