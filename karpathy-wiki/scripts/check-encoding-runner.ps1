# check-encoding-runner.ps1
#
# 作用：check-encoding.bat 的 .ps1 包装器
# 原因：.bat 文件是纯 ASCII 无法解析 config.json，需委托 .ps1 读取 config
#       解析出 node.exe 路径后，用该 node 执行 scripts/check-encoding.js
#
# 调用方：scripts/check-encoding.bat
# 参数：透传给 check-encoding.js（如 --fix / --json / --meta-only / --src-only）

param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$JsArgs
)

$ErrorActionPreference = "Stop"

# 加载 node 路径解析模块
. (Join-Path $PSScriptRoot 'node-resolver.ps1')

# 读取 scripts/config.json
$configPath = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path $configPath)) {
    Write-Host "[ERROR] config.json not found: $configPath" -ForegroundColor Red
    exit 1
}
$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 解析 node.exe 路径
$nodeExe = Resolve-NodeExe -Config $cfg
if (-not $nodeExe) {
    Write-Host "[ERROR] node.exe not resolved. Check tools.node in config.json" -ForegroundColor Red
    exit 1
}

# 切换到项目根目录（与原 check-encoding.bat 的 cd /d "%~dp0\.." 等价）
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

# 执行 check-encoding.js，透传所有参数
$jsScript = Join-Path $PSScriptRoot 'check-encoding.js'
if ($JsArgs) {
    & $nodeExe $jsScript @JsArgs
} else {
    & $nodeExe $jsScript
}
exit $LASTEXITCODE
