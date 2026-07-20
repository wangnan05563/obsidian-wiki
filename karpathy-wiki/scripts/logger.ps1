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
    # 为什么保留 netstat：PID 查询只能通过 netstat，TcpClient 无法获取 PID
    # 仅在端口已就绪后调用一次（不在 Wait-PortReady 循环中调用），避免性能问题
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

function Test-PortListening {
    # 工具函数：用 TcpClient 探测端口是否监听（同时尝试 IPv4 和 IPv6）
    # 为什么不用 netstat：netstat -aon 输出全部连接再过滤，单次耗时 0.5~2s
    # 在 Wait-PortReady 循环中累计 15~60s 额外开销，导致超时判断失真
    # TcpClient 直接 TCP 握手，单次 <10ms，且能区分"端口未监听"和"进程已崩溃"
    # 为什么同时尝试 IPv4 和 IPv6：Vite 默认监听 [::1]:5173（仅 IPv6），
    # Fastify 默认同时监听 127.0.0.1 和 [::1]，仅探测 IPv4 会导致 Vite 端口永远判为未就绪
    param([Parameter(Mandatory)][int]$Port)
    foreach ($host_ in @('127.0.0.1', '::1')) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            # 200ms 超时：本机回环足够，避免卡在 SYN 排队
            $iar = $client.BeginConnect($host_, $Port, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(200)
            if ($ok -and $client.Connected) {
                $client.EndConnect($iar)
                $client.Close()
                return $true
            }
            $client.Close()
        } catch {
            # 当前地址族不匹配或连接被拒，继续尝试下一个地址
        }
    }
    return $false
}

function Wait-PortReady {
    # 工具函数：轮询等待端口就绪
    # 对标闲鱼启动脚本的 :wait_web 循环逻辑
    # 为什么用 Test-PortListening 而非 Get-PidOnPort：
    # 循环中只需判断"是否监听"，不需要 PID；PID 查询留到就绪后调用一次
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$MaxTries,
        [Parameter(Mandatory)][int]$IntervalSeconds
    )
    for ($i = 1; $i -le $MaxTries; $i++) {
        Start-Sleep -Seconds $IntervalSeconds
        if (Test-PortListening -Port $Port) { return $true }
    }
    return $false
}
