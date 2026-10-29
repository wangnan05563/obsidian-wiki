#Requires -Version 5.1
# Karpathy-Wiki 一键发布主逻辑
# 流程：解析 node -> 安装依赖 -> 构建前端 SPA -> 部署到 live -> 重启生产服务 -> 健康检查
# 配置驱动：所有命令/路径从 scripts/config.json 的 publish 节读取，无硬编码
# 分层：本脚本由 一键发布.bat 调用，.bat 仅作纯 ASCII 入口

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [switch]$SkipRestart,
    [switch]$PublishRelease,
    # T02743：显式指定本次发布的正式 Release 说明文件（发布时落地为约定名 release-notes-<版本>.md）
    [string]$ReleaseNotesFile = '',
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# 控制台 UTF-8 输出（避免中文乱码，对应 create-bat 规则 4 / F4）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null

# 加载配置
if (-not (Test-Path $ConfigPath)) { throw "配置文件不存在: $ConfigPath" }
$Config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 切换到项目根目录（config.project.root 相对 scripts/）
$Root = (Resolve-Path (Join-Path $PSScriptRoot $Config.project.root)).Path
Set-Location $Root

# 共享日志 + node 解析模块
. (Join-Path $PSScriptRoot 'logger.ps1')
Initialize-Logger -Config $Config
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
$NodeExe = Resolve-NodeExe -Config $Config
if (-not $NodeExe) { Write-Log "未解析到 node.exe，请检查 config.tools.node" -Level ERROR; exit 1 }
Invoke-WithNodePath -NodeExePath $NodeExe

# 包管理器检测（auto -> pnpm > npm）
$pkgManager = $Config.commands.pkg_manager
if ($pkgManager -eq 'auto') {
    if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { $pkgManager = 'pnpm.cmd' }
    else { $pkgManager = 'npm.cmd' }
} elseif ($pkgManager -eq 'pnpm') { $pkgManager = 'pnpm.cmd' }
elseif ($pkgManager -eq 'npm') { $pkgManager = 'npm.cmd' }
if (-not (Get-Command $pkgManager -ErrorAction SilentlyContinue)) {
    Write-Log "包管理器不可用: $pkgManager" -Level ERROR; exit 1
}

# 安装参数按包管理器区分：pnpm >= 10 拒绝 npm 兼容参数 --no-audit/--no-fund（报 Unknown options），仅 npm 需要
$installArgs = @('install')
if ($pkgManager -eq 'npm.cmd') { $installArgs = @('install', '--no-audit', '--no-fund') }

$apiPort = [int]$Config.ports.api
$p = $Config.publish
$buildArgs = $p.build_args
$prodStartArgs = $p.prod_start_args
$buildLog = Join-Path $Root $p.build_log_file
$prodLog = Join-Path $Root $p.prod_log_file
$deployScript = Join-Path $Root $p.deploy_script
$deploySrc = $p.deploy_src
$healthUrl = "http://localhost:$apiPort$($p.health_path)"
$spaUrl = "http://localhost:$apiPort$($p.spa_probe_path)"

# 计算的部署目标目录（与 spa-resolver.ts 的 api/../../release/spa 一致）
$deployTargetDir = Join-Path (Join-Path (Join-Path (Split-Path $deployScript) '..') '..') (Join-Path 'release' 'spa')

function Join-Args([array]$a) { return ($a -join ' ') }

# ---- GitHub Release 发布参数解析（dry-run 与真实执行共用，只读不落盘）----
# token 不在此读取：publish-release.py 自行按 环境变量 GH_TOKEN > 本地 .env > git credential fill 解析
$pyExe = $null; $relVer = $null; $relAsset = $null
$pyCands = @($p.python_candidates); if (-not $pyCands -or $pyCands.Count -eq 0) { $pyCands = @('python', 'python3', 'py') }
if ($PublishRelease) {
    foreach ($cand in $pyCands) {
        $c = Get-Command $cand -ErrorAction SilentlyContinue
        if ($c) { $pyExe = $c.Source; break }
    }
    # 版本：package.json 单一真相源；文件名版本仅作缺失兜底
    $pkgPath = Join-Path $Root $p.version_source
    if (Test-Path $pkgPath) {
        try { $relVer = (Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
    }
    # 资产：glob 取最新，优先选与版本匹配的安装包（防 bump 后忘构建、旧包装进新 tag）
    $allAssets = @(Get-ChildItem (Join-Path $Root $p.release_asset_glob) -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($relVer) {
        $relAsset = $allAssets | Where-Object { $_.Name -like "*v$relVer.*" -or $_.Name -like "*-$relVer.*" } | Select-Object -First 1
    }
    if (-not $relAsset) {
        $relAsset = $allAssets | Select-Object -First 1
        if ($relAsset) { $relAssetNote = "未找到与版本 $relVer 匹配的安装包，使用最新" }
    }
    if (-not $relVer -and $relAsset -and $relAsset.Name -match 'v?([0-9][0-9A-Za-z._-]*)\.exe$') { $relVer = $Matches[1] }

    # T02743 发布说明解析：显式 -ReleaseNotesFile 优先（真实发布时落地为约定文件名）；
    # 否则只认约定文件 release-notes-<VER>.md——缺失或仅剩 .auto.md（旧 git log 兜底产物）
    # 一律视为「说明未备好」：正式发布阻断，DryRun 仅告警。不再用 git log 自动生成兜底。
    $relNotes = $null; $relNotesIssue = $null; $relNotesNote = $null
    if ($relVer) {
        $relNotes = Join-Path $Root "$($p.release_notes_prefix)$relVer.md"
        if ($ReleaseNotesFile) {
            if (-not (Test-Path $ReleaseNotesFile)) {
                $relNotesIssue = "指定的 -ReleaseNotesFile 不存在: $ReleaseNotesFile"
            } else {
                $relNotesNote = "已指定 -ReleaseNotesFile，发布时写入约定文件 $relNotes"
            }
        } elseif (-not (Test-Path $relNotes)) {
            $autoNotes = Join-Path $Root "$($p.release_notes_prefix)$relVer.auto.md"
            if (Test-Path $autoNotes) {
                $relNotesIssue = "只有 git log 兜底产物 $autoNotes，缺少正式说明 $($p.release_notes_prefix)$relVer.md"
            } else {
                $relNotesIssue = "正式 Release 说明缺失: $($p.release_notes_prefix)$relVer.md（写好后放项目根，或用 -ReleaseNotesFile 指定）"
            }
        }
    }
}

Write-LogBanner -Title "$($Config.project.name) 一键发布 [会话: $($script:LogSessionId)]"
Write-Log "项目根: $Root" -Level INFO
Write-Log "Node: $NodeExe" -Level INFO
Write-Log "包管理器: $pkgManager" -Level INFO

if ($DryRun) {
    Write-Log "[DRY-RUN] 仅打印将执行的命令，不实际构建/部署/重启" -Level WARN
    Write-Log "1) 安装依赖 : $pkgManager $(Join-Args $installArgs)" -Level INFO
    Write-Log "2) 构建前端 : $pkgManager $(Join-Args $buildArgs)" -Level INFO
    Write-Log "3) 部署      : $NodeExe $($p.deploy_script) $deploySrc" -Level INFO
    $dt = Resolve-Path $deployTargetDir -ErrorAction SilentlyContinue
    Write-Log "   部署目标  : $dt (每次新建 public_live_<ts>，由 index.ts 自动选用最新)" -Level INFO
    Write-Log "4) 重启生产  : 停止端口 $apiPort -> $pkgManager $(Join-Args $prodStartArgs) (日志 $prodLog)" -Level INFO
    Write-Log "5) 健康检查  : $healthUrl / $spaUrl" -Level INFO
    if ($PublishRelease) {
        if ($pyExe -and $relAsset -and $relVer) {
            Write-Log "6) 发布 Release: $pyExe publish-release.py $($relAsset.Name) (GH_TAG=$relVer GH_DRY_RUN=1)" -Level INFO
        } else {
            Write-Log "6) 发布 Release: 解析失败 (python=$pyExe 资产=$(if ($relAsset) { $relAsset.Name } else { '无' }) 版本=$relVer)" -Level WARN
        }
        if ($relNotesIssue) {
            Write-Log "[DRY-RUN] 发布说明未备好: $relNotesIssue" -Level WARN
            Write-Log "[DRY-RUN] 正式发布将在此处阻断（不再用 git log 兜底）" -Level WARN
        } elseif ($relNotesNote) {
            Write-Log "   发布说明  : $relNotesNote" -Level INFO
        } elseif ($relNotes) {
            Write-Log "   发布说明  : $relNotes" -Level INFO
        }
    } else {
        Write-Log "6) 发布 Release: 未启用（加 -PublishRelease 开启；资产 $($p.release_asset_glob)）" -Level SKIP
    }
    exit 0
}

# ============ 1) 安装依赖 ============
Write-Log "步骤 1/6 安装依赖..." -Level STEP -Step "1/6"
if ($SkipInstall) {
    Write-Log "跳过安装（-SkipInstall）" -Level SKIP -Step "1/6"
} else {
    & $pkgManager @installArgs
    if ($LASTEXITCODE -ne 0) { Write-Log "依赖安装失败" -Level ERROR -Step "1/6"; exit 1 }
    Write-Log "依赖安装完成" -Level OK -Step "1/6"
}

# ============ 2) 构建前端 SPA ============
Write-Log "步骤 2/6 构建前端 SPA..." -Level STEP -Step "2/6"
if ($SkipBuild) {
    Write-Log "跳过构建（-SkipBuild）" -Level SKIP -Step "2/6"
} else {
    $buildProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "$pkgManager $(Join-Args $buildArgs) > `"$buildLog`" 2>&1" -WorkingDirectory $Root -Wait -PassThru -NoNewWindow
    if ($buildProc.ExitCode -ne 0) {
        Write-Log "前端构建失败，日志尾部:" -Level ERROR -Step "2/6"
        if (Test-Path $buildLog) { Get-Content $buildLog -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray } }
        exit 1
    }
    Write-Log "前端构建完成 -> $deploySrc" -Level OK -Step "2/6"
}

# ============ 3) 部署到 live ============
Write-Log "步骤 3/6 部署到 live 目录..." -Level STEP -Step "3/6"
if ($SkipDeploy) {
    Write-Log "跳过部署（-SkipDeploy）" -Level SKIP -Step "3/6"
} else {
    if (-not (Test-Path (Join-Path (Join-Path $Root $deploySrc) 'index.html'))) {
        Write-Log "未找到构建产物 index.html: $deploySrc（请先构建）" -Level ERROR -Step "3/6"
        exit 1
    }
    & $NodeExe $deployScript $deploySrc
    if ($LASTEXITCODE -ne 0) { Write-Log "部署失败" -Level ERROR -Step "3/6"; exit 1 }
    Write-Log "部署完成，已生成 public_live_<ts>" -Level OK -Step "3/6"
}

# ============ 4) 重启生产服务 ============
Write-Log "步骤 4/6 重启生产服务 (端口 $apiPort)..." -Level STEP -Step "4/6"
if ($SkipRestart) {
    Write-Log "跳过重启（-SkipRestart）" -Level SKIP -Step "4/6"
} else {
    # 停止端口上的旧进程（dev api / 旧 prod 都监听 3000）
    $oldPids = Get-PidOnPort -Port $apiPort
    foreach ($procId in $oldPids) {
        try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { }
        Write-Log "已停止旧进程 PID $procId" -Level OK -Step "4/6"
    }
    if ($oldPids.Count -eq 0) { Write-Log "端口 $apiPort 无旧进程" -Level SKIP -Step "4/6" }
    Start-Sleep -Seconds 1

    # 后台启动生产服务（单端口：API + 内置 SPA）
    Start-Process cmd.exe -ArgumentList "/c", "$pkgManager $(Join-Args $prodStartArgs) > `"$prodLog`" 2>&1" -WorkingDirectory $Root -WindowStyle Hidden
    Write-Log "生产服务已启动（日志 $prodLog）" -Level INFO -Step "4/6"

    $ready = Wait-PortReady -Port $apiPort -MaxTries ([int]$p.wait_max_tries) -IntervalSeconds ([int]$p.ping_interval_seconds)
    if (-not $ready) {
        Write-Log "端口 $apiPort 在超时内未就绪" -Level ERROR -Step "4/6"
        if (Test-Path $prodLog) { Get-Content $prodLog -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray } }
        exit 1
    }
    $newPids = Get-PidOnPort -Port $apiPort
    Write-Log "生产服务已就绪 (PID: $($newPids -join ', '))" -Level OK -Step "4/6"
}

# ============ 5) 健康检查 ============
Write-Log "步骤 5/6 健康检查..." -Level STEP -Step "5/6"
try {
    $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10 -ErrorAction Stop
    if ($h.ok) { Write-Log "API 健康: $healthUrl -> ok" -Level OK -Step "5/6" } else { Write-Log "API 健康检查返回非 ok" -Level WARN -Step "5/6" }
} catch {
    Write-Log "API 健康检查失败: $_" -Level WARN -Step "5/6"
}
try {
    $r = Invoke-WebRequest -Uri $spaUrl -TimeoutSec 10 -ErrorAction Stop
    if ($r.Content -match '<!DOCTYPE|<title>|index\.html') {
        Write-Log "SPA 可访问: $spaUrl ($( $r.StatusCode ))" -Level OK -Step "5/6"
    } else {
        Write-Log "SPA 返回内容异常 ($( $r.StatusCode ))" -Level WARN -Step "5/6"
    }
} catch {
    Write-Log "SPA 访问失败: $_" -Level WARN -Step "5/6"
}

# ============ 6) 发布 GitHub Release（可选，-PublishRelease）============
if ($PublishRelease) {
    Write-Log "步骤 6/6 发布 GitHub Release..." -Level STEP -Step "6/6"
    if (-not $pyExe) { Write-Log "未找到 Python（候选: $($pyCands -join ' / ') 均不可用）" -Level ERROR -Step "6/6"; exit 1 }
    if (-not $relAsset) { Write-Log "未找到安装包资产: $($p.release_asset_glob)（请先运行 scripts\build-exe.bat 打包）" -Level ERROR -Step "6/6"; exit 1 }
    if (-not $relVer) { Write-Log "无法推导版本号（version_source 与资产文件名均未取到）" -Level ERROR -Step "6/6"; exit 1 }
    if ($relAssetNote) { Write-Log $relAssetNote -Level WARN -Step "6/6" }

    # T02743：说明未备好一律阻断，不再静默 git log 兜底；显式指定时在此落地为约定文件名
    if ($relNotesIssue) {
        Write-Log "发布阻断：$relNotesIssue" -Level ERROR -Step "6/6"
        Write-Log "请先准备正式 Release 说明后重跑（可先用 -DryRun 预检）" -Level ERROR -Step "6/6"
        exit 1
    }
    if ($ReleaseNotesFile) {
        Copy-Item -Path $ReleaseNotesFile -Destination $relNotes -Force
        Write-Log "说明文件已落地: $relNotes（来自 -ReleaseNotesFile）" -Level INFO -Step "6/6"
    }

    $env:GH_TAG = $relVer
    Write-Log "Python: $pyExe" -Level INFO -Step "6/6"
    Write-Log "资产  : $($relAsset.FullName)" -Level INFO -Step "6/6"
    Write-Log "版本  : $relVer  说明: $relNotes" -Level INFO -Step "6/6"
    & $pyExe (Join-Path $PSScriptRoot 'publish-release.py') $relAsset.FullName $relNotes $relAsset.Name
    if ($LASTEXITCODE -ne 0) { Write-Log "GitHub Release 发布失败（检查 .env 的 GH_TOKEN 或 git 凭据库 github.com 凭证）" -Level ERROR -Step "6/6"; exit 1 }
    Write-Log "GitHub Release 发布完成 (tag=$relVer)" -Level OK -Step "6/6"
} else {
    Write-Log "步骤 6/6 跳过 GitHub Release 发布（未加 -PublishRelease）" -Level SKIP -Step "6/6"
}

Write-LogBanner -Title "$($Config.project.name) 一键发布完成 [会话: $($script:LogSessionId)]"
Write-Log "访问地址: $spaUrl" -Level INFO
Write-Log "API 健康: $healthUrl" -Level INFO
Write-Log "生产日志: $prodLog" -Level INFO
Write-Log "停止服务: 双击 scripts\stop-service.bat" -Level INFO
exit 0
