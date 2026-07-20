# 共享模块：解析 node.exe 路径
# 设计目标：
#   - 配置驱动：所有可变参数从 scripts/config.json 的 tools.node 节读取
#   - 容错 fallback 链：exe_path > search_paths > PATH > 抛错
#   - 不破坏调用方 $Config 变量（dot-source 加载时仅注入函数）
#
# 解析优先级（与 create-bat 技能规则 6 一致）：
#   1. config.tools.node.exe_path（已验证版本的精确路径，避免 PATH 旧版优先）
#   2. config.tools.node.search_paths（候选路径列表，按顺序检查）
#   3. config.tools.node.use_path_fallback=true 时回退 Get-Command node
#   4. 全部失败时返回 $null，调用方决定如何处理（通常抛错）
#
# 版本约束：找到的 node.exe 必须满足 config.tools.node.min_version，否则跳过继续 fallback
#
# 用法：
#   . (Join-Path $PSScriptRoot 'node-resolver.ps1')
#   $nodeExe = Resolve-NodeExe -Config $Config
#   if (-not $nodeExe) { throw "未找到满足版本要求的 node.exe" }
#   & $nodeExe script.js

function Get-NodeVersionFromExe {
    # 调用 node --version 解析版本号
    # 返回 PSCustomObject { Major; Minor; Patch } 或 $null
    param([Parameter(Mandatory)][string]$ExePath)

    if (-not (Test-Path $ExePath)) { return $null }
    try {
        # 2>&1 合并 stderr，避免部分 node 版本把警告输出到 stderr
        $output = & $ExePath --version 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        if ($output -match 'v?(\d+)\.(\d+)\.(\d+)') {
            return [PSCustomObject]@{
                Major = [int]$Matches[1]
                Minor = [int]$Matches[2]
                Patch = [int]$Matches[3]
            }
        }
    } catch { }
    return $null
}

function Test-NodeVersionSatisfy {
    # 比较版本号：当前版本 >= 最低要求
    param($Current, [int[]]$MinVersion)
    if ($null -eq $Current) { return $false }
    if ($MinVersion.Count -lt 1) { return $true }
    if ($Current.Major -gt $MinVersion[0]) { return $true }
    if ($Current.Major -lt $MinVersion[0]) { return $false }
    if ($MinVersion.Count -ge 2) {
        return $Current.Minor -ge $MinVersion[1]
    }
    return $true
}

function Resolve-NodeExe {
    # 核心解析函数：返回满足版本要求的 node.exe 完整路径
    # 参数 $Config 为 scripts/config.json 反序列化后的对象
    # 返回 string（node.exe 路径）或 $null（未找到）
    param([Parameter(Mandatory)]$Config)

    $nodeCfg = $Config.tools.node
    if (-not $nodeCfg) {
        # 配置缺失时回退 PATH 中的 node，保持向后兼容
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        return $null
    }

    # min_version 默认 [18, 0]，与 package.json engines 对齐
    $minVersion = if ($nodeCfg.min_version) { [int[]]$nodeCfg.min_version } else { ,18, 0 }
    $usePathFallback = if ($null -ne $nodeCfg.use_path_fallback) { [bool]$nodeCfg.use_path_fallback } else { $true }

    # 候选路径集合（按优先级排列，去重）
    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($nodeCfg.exe_path -and (Test-Path $nodeCfg.exe_path)) {
        $candidates.Add($nodeCfg.exe_path)
    }
    if ($nodeCfg.search_paths) {
        foreach ($p in $nodeCfg.search_paths) {
            if ($p -and (Test-Path $p) -and -not $candidates.Contains($p)) {
                $candidates.Add($p)
            }
        }
    }

    # 按优先级逐一验证版本
    foreach ($candidate in $candidates) {
        $ver = Get-NodeVersionFromExe -ExePath $candidate
        if ($ver -and (Test-NodeVersionSatisfy -Current $ver -MinVersion $minVersion)) {
            return $candidate
        }
    }

    # PATH 回退：避免配置路径全部失效时完全不可用
    if ($usePathFallback) {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) {
            $ver = Get-NodeVersionFromExe -ExePath $cmd.Source
            if ($ver -and (Test-NodeVersionSatisfy -Current $ver -MinVersion $minVersion)) {
                return $cmd.Source
            }
        }
    }

    return $null
}

function Invoke-WithNodePath {
    # 工具函数：将 node.exe 所在目录临时加入 PATH 头部
    # 用途：让 pnpm.cmd / npm.cmd 自动找到指定版本的 node，无需改写调用链
    # 调用方应在子作用域中使用（如 & { Invoke-WithNodePath $nodeExe; pnpm install }）
    param([string]$NodeExePath)
    if ($NodeExePath -and (Test-Path $NodeExePath)) {
        $nodeDir = Split-Path -Parent $NodeExePath
        # 头部插入确保优先于系统 PATH 中可能存在的旧版 nodejs
        $env:Path = "$nodeDir;$env:Path"
    }
}
