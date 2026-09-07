# 共享模块：构建前生成 patch 号写回 package.json
#
# 设计目标：
#   - 每次构建版本号唯一（同一天递增，跨日重置）
#   - 主.次版本保留在 package.json 中（不依赖外部配置）
#   - 计数持久化到 .build/patch-counter.json，跨构建可追踪
#   - 写回 package.json 时保留原文件格式（缩进、字段顺序），仅替换 version 行
#
# 版本号拼接规则（与用户确认的方案 A 一致）：
#   - 主.次版本：从 package.json 读取，如 "0.1.0" 取前两段 "0.1"
#   - patch = 当天日期（YYYYMMDD, 8 位）+ 当天递增序号（字符串拼接）
#   - 最终 version："{major}.{minor}.{YYYYMMDD}{seq}"
#   - 例如：0.1.202607201、0.1.202607202 ... 0.1.2026072010
#   - patch 是纯数字（虽然很大），仍符合 SemVer 三段式
#
# 计数文件格式（.build/patch-counter.json）：
#   {
#     "date": "20260720",
#     "seq": 3,
#     "version": "0.1.202607203"
#   }
#
# 用法：
#   . (Join-Path $PSScriptRoot 'bump-version.ps1')
#   $newVersion = Invoke-VersionBump -RepoRoot $repoRoot
#   if (-not $newVersion) { throw "版本号生成失败" }

function Invoke-VersionBump {
    # 主函数：生成 patch 号并写回 package.json
    # 参数 $RepoRoot：项目根目录（package.json 与 .build/ 所在目录）
    # 返回：新版本号字符串（如 "0.1.202607201"），失败返回 $null
    param([Parameter(Mandatory)][string]$RepoRoot)

    $pkgPath = Join-Path $RepoRoot 'package.json'
    if (-not (Test-Path $pkgPath)) {
        Write-Host "[BumpVersion] [ERROR] package.json not found: $pkgPath" -ForegroundColor Red
        return $null
    }

    # 1. 读取 package.json 当前 version（提取主.次版本作为前缀）
    #    为什么用正则而非 ConvertFrom-Json：避免改写其他字段格式与顺序
    $pkgRaw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.UTF8Encoding]::new($false))
    $versionMatch = [regex]::Match($pkgRaw, '"version"\s*:\s*"([^"]+)"')
    if (-not $versionMatch.Success) {
        Write-Host "[BumpVersion] [ERROR] version field not found in package.json" -ForegroundColor Red
        return $null
    }
    $currentVersion = $versionMatch.Groups[1].Value

    # 提取主.次版本（如 "0.1.0" -> "0.1"，"0.1.202607201" -> "0.1"）
    # 为什么从现有 version 提取而非硬编码：未来升主次版本时无需改本脚本
    $parts = $currentVersion -split '\.'
    if ($parts.Count -lt 2) {
        Write-Host "[BumpVersion] [ERROR] invalid version format: $currentVersion" -ForegroundColor Red
        return $null
    }
    $majorMinor = "$($parts[0]).$($parts[1])"

    # 2. 计算当天日期字符串（YYYYMMDD，8 位）
    $today = (Get-Date).ToString('yyyyMMdd')

    # 3. 读取计数文件
    $buildDir = Join-Path $RepoRoot '.build'
    if (-not (Test-Path $buildDir)) {
        New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
    }
    $counterPath = Join-Path $buildDir 'patch-counter.json'

    $date = $today
    $seq = 0
    if (Test-Path $counterPath) {
        try {
            $counter = [System.IO.File]::ReadAllText($counterPath, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
            if ($counter.date -eq $today) {
                # 同一天：序号 +1
                $seq = [int]$counter.seq
            }
            # 跨日：date 已重置为 $today，seq 保持 0（下面会 +1）
        } catch {
            Write-Host "[BumpVersion] [WARN] counter file corrupted, reset to 1: $counterPath" -ForegroundColor Yellow
        }
    }
    $seq++

    # 4. 拼接新版本号并写回计数文件
    $newVersion = "${majorMinor}.${today}${seq}"

    $counterObj = [PSCustomObject]@{
        date    = $today
        seq     = $seq
        version = $newVersion
    }
    $counterJson = $counterObj | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($counterPath, $counterJson, (New-Object System.Text.UTF8Encoding($false)))

    # 5. 写回 package.json（仅替换 version 行，保留其他字段原样）
    #    为什么不用 ConvertFrom/ConvertTo-Json：会改写缩进风格、字段顺序，污染 diff
    #    用正则只替换 version 字段值，其他字段保持原样
    $newPkgRaw = [regex]::Replace(
        $pkgRaw,
        '("version"\s*:\s*")[^"]+(")',
        "`${1}${newVersion}`${2}"
    )
    [System.IO.File]::WriteAllText($pkgPath, $newPkgRaw, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "[BumpVersion] [OK] version: $currentVersion -> $newVersion (date=$today, seq=$seq)" -ForegroundColor Green
    return $newVersion
}