# prepend-node-path.ps1
#
# 作用：输出配置的 node.exe 所在目录，供 .bat 用 for /f 捕获并设置 PATH
# 原因：PowerShell 子进程修改 $env:Path 不会回传到父 cmd.exe 进程，
#       改为输出路径让 .bat 自行 set PATH=... 才能生效
#
# 调用方：build-web.bat 等 .bat 脚本
# 输出：单行 node.exe 所在目录的完整路径（如 D:\code\nodejs24）
#       若解析失败则输出空行，调用方可通过 errorlevel 判断

$ErrorActionPreference = "Stop"

# 加载 node 路径解析模块
. (Join-Path $PSScriptRoot 'node-resolver.ps1')

# 读取 scripts/config.json
$configPath = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path $configPath)) {
    # 配置缺失时不阻塞，输出空行让 .bat 走 PATH 默认 node
    Write-Output ""
    exit 0
}
$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 解析 node.exe 路径
$nodeExe = Resolve-NodeExe -Config $cfg
if (-not $nodeExe) {
    # 解析失败输出空行，.bat 会回退到 PATH 中的 node
    Write-Output ""
    exit 0
}

# 输出 node.exe 所在目录（.bat 用 for /f 捕获）
$nodeDir = Split-Path -Parent $nodeExe
Write-Output $nodeDir
exit 0
