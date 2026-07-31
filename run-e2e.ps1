$ErrorActionPreference = 'Continue'
$projectRoot = (Resolve-Path 'd:\code\otherProjects\19_Karpathy-AI+Obsidian*\').Path
Set-Location $projectRoot
Write-Host "Working dir: $projectRoot"

# 检查服务是否已经在运行
$port3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$port5173 = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue

if ($port3000 -and $port5173) {
    Write-Host "[INFO] Ports 3000 and 5173 already listening. Skip startup."
} else {
    Write-Host "[INFO] Starting services..."
    & "$projectRoot\karpathy-wiki\scripts\start-service.bat"
    Start-Sleep -Seconds 10
}

# 运行测试（保持在项目根目录，让 defaults.yaml 通过 os.getcwd 路径解析命中）
$configPath = "$projectRoot\.trae\skills\wiki-auto-testing\config.yaml"
$templateDir = "$projectRoot\.trae\skills\wiki-auto-testing\templates"

# 显式 import 测试模块，避免 sys.path 包含 templates 目录但当前目录不是项目根
$env:PYTHONPATH = "$templateDir;$env:PYTHONPATH"
# 用环境变量传递 config 路径，避开 PowerShell 路径含中文时参数解析的边界问题
$env:WIKI_TEST_CONFIG = $configPath
& python "$templateDir\test_suite_full.py" 2>&1 | Tee-Object -FilePath "$env:TEMP\e2e-output.txt"
Write-Host "ExitCode: $LASTEXITCODE"
