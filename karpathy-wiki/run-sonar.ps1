$env:SONAR_TOKEN = "***REDACTED-SECRET***"
$logFile = "$env:TEMP\sonar-scan-final.log"
$scanner = "D:\code\sonar\sonar-scanner-8.0.1.6346-windows-x64\bin\sonar-scanner.bat"
$workDir = "d:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\frontend"

Set-Location $workDir
& $scanner "-Dsonar.projectKey=karpathy_wiki_web" "-Dsonar.sources=src" "-Dsonar.host.url=http://localhost:9000" "-Dsonar.token=$env:SONAR_TOKEN" 2>&1 | Out-File -FilePath $logFile -Encoding UTF8
"EXIT_CODE: $LASTEXITCODE" | Out-File -FilePath $logFile -Append -Encoding UTF8
