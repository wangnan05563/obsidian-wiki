# 共享日志模块：对标闲鱼 logger.py 的日志风格
# 设计要点：
# - 会话级流水号 sess-{YYYYMMDDHHmmss}-{4hex}，对标闲鱼 req-{YYYYMMDDHHMMSSfff}-{6hex}
#   启动脚本级别秒级精度+4位hex足够，无需毫秒级
# - 日志格式：时间 | 级别 | [sess=xxx|#001] | [步骤] 消息
#   对标闲鱼：时间 | 级别 | [req=xxx] | 模块:函数:行号 - 消息
# - 分段彩色输出：时间灰、级别按类型、流水号青、步骤号紫、消息白
#   对标 loguru 的 <green>...</green> 标签着色机制
# - 颜色配置从 config.json 读取，无硬编码

# 全局状态：会话流水号 + 递增序号
# 会话号在模块加载时生成一次，整个脚本周期不变（对标闲鱼的 request_id 作用域）
# 注意：变量名用 LogConfig 而非 Config，避免 dot-source 加载时覆盖调用方的 $Config 变量
$script:LogSessionId = $null
$script:LogSeq = 0
$script:LogConfig = $null

function Initialize-Logger {
    # 初始化日志模块：生成会话流水号并保存配置引用
    # 必须在调用 Write-Log 之前调用一次
    param([Parameter(Mandatory)]$Config)

    $script:LogConfig = $Config
    $logCfg = $Config.log
    $prefix = $logCfg.session_id_prefix
    $tsFormat = $logCfg.session_id_format
    $hexLen = [int]$logCfg.random_hex_length

    # 生成 hex 随机数（对标闲鱼 secrets.token_hex，PowerShell 用 Get-Random 模拟）
    $hexChars = @()
    for ($i = 0; $i -lt $hexLen; $i++) {
        $hexChars += '{0:x}' -f (Get-Random -Maximum 16)
    }
    $hex = -join $hexChars
    $timestamp = Get-Date -Format $tsFormat
    $script:LogSessionId = "$prefix-$timestamp-$hex"
}

function Write-Log {
    # 核心日志函数：分段彩色输出，对标闲鱼 logger.py 的 sink 格式
    # 颜色方案：时间灰 | 级别按类型 | 流水号青 | 步骤号紫 | 消息白
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('INFO','WARN','ERROR','STEP','OK','FAIL','SKIP')]
        [string]$Level = 'INFO',
        [string]$Step = ''
    )

    if (-not $script:LogConfig) {
        # 无配置时降级为纯文本输出（容错）
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
        Write-Host "$ts | $Level | $Message"
        return
    }

    $script:LogSeq++
    $logCfg = $script:LogConfig.log
    $colorCfg = $script:LogConfig.log_colors

    $ts = Get-Date -Format $logCfg.timestamp_format
    $seqStr = $script:LogSeq.ToString("D$($logCfg.seq_padding)")
    $sessTag = "[sess=$($script:LogSessionId)|#$seqStr]"

    # 从配置读取颜色（对标闲鱼从 loguru format 字符串解析 <green> 等标签）
    $levelColor = $colorCfg.levels.$Level
    $sepColor = $colorCfg.separator
    $tsColor = $colorCfg.timestamp
    $sessColor = $colorCfg.session_id
    $stepColor = $colorCfg.step_tag
    $msgColor = $colorCfg.message

    # 分段输出：每段用独立 Write-Host -NoNewline 着色，最后一段用 Write-Host 换行
    # 对标 loguru format 中每个 <color>...</color> 标签段
    Write-Host -NoNewline $ts -ForegroundColor $tsColor
    Write-Host -NoNewline " | " -ForegroundColor $sepColor
    Write-Host -NoNewline ("{0,-5}" -f $Level) -ForegroundColor $levelColor
    Write-Host -NoNewline " | " -ForegroundColor $sepColor
    Write-Host -NoNewline $sessTag -ForegroundColor $sessColor
    Write-Host -NoNewline " | " -ForegroundColor $sepColor
    if ($Step) {
        Write-Host -NoNewline "[$Step] " -ForegroundColor $stepColor
    }
    Write-Host $Message -ForegroundColor $msgColor
}

function Write-LogBanner {
    # 横幅输出：用于流程开始/结束的视觉分隔
    param([Parameter(Mandatory)][string]$Title)
    $bannerColor = $script:LogConfig.log_colors.levels.STEP
    $border = '=' * 60
    Write-Host $border -ForegroundColor $bannerColor
    Write-Host "  $Title" -ForegroundColor $bannerColor
    Write-Host $border -ForegroundColor $bannerColor
}

function Get-PidOnPort {
    # 工具函数：获取监听指定端口的进程 PID 列表
    # 对标闲鱼启动脚本中的 netstat + findstr 端口扫描逻辑
    param([Parameter(Mandatory)][int]$Port)
    $pids = @()
    # 用 Select-String 替代 findstr，保持 PowerShell 原生风格
    $netstat = netstat -aon 2>$null | Select-String ":$Port.*LISTENING"
    foreach ($line in $netstat) {
        $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
        if ($parts.Count -ge 5) {
            $pids += $parts[4]
        }
    }
    return $pids | Sort-Object -Unique
}

function Wait-PortReady {
    # 工具函数：轮询等待端口就绪
    # 对标闲鱼启动脚本的 :wait_web 循环逻辑
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$MaxTries,
        [Parameter(Mandatory)][int]$IntervalSeconds
    )
    for ($i = 1; $i -le $MaxTries; $i++) {
        Start-Sleep -Seconds $IntervalSeconds
        $pids = Get-PidOnPort -Port $Port
        if ($pids.Count -gt 0) { return $true }
    }
    return $false
}
