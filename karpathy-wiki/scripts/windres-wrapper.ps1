# scripts/windres-wrapper.ps1
# windres wrapper — 解决 GNU windres 在中文路径下的编码问题
#
# windres 用 GBK 解析命令行参数和 .rc 文件中的路径，
# 但 cargo 传递的是 UTF-8 编码的中文路径，导致 "Invalid argument" 错误。
#
# 此 wrapper 的策略：
# 1. 把所有输入文件（.rc 文件和 .rc 中引用的文件如 .ico）复制到 %TEMP%（英文路径）
# 2. 修改 .rc 文件中的中文路径引用为临时目录下的相对路径
# 3. 把 --input, --output, --include-dir 参数都改为临时目录下的路径
# 4. 调用真正的 windres.exe
# 5. 把输出文件复制回原位置

# 真正的 windres 路径
$realWindres = "d:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\w64devkit\w64devkit\bin\windres.exe"

if (-not (Test-Path $realWindres)) {
    Write-Error "windres.exe not found at: $realWindres"
    exit 1
}

# 创建唯一的临时工作目录（纯 ASCII 路径）
$tempBase = Join-Path $env:TEMP ("windres_" + [System.Diagnostics.Process]::GetCurrentProcess().Id + "_" + (Get-Random))
New-Item -ItemType Directory -Force $tempBase | Out-Null

try {
    # 解析参数，找到关键参数
    $inputRc = $null
    $outputFile = $null
    $includeDir = $null
    $otherArgs = @()

    $i = 0
    while ($i -lt $args.Count) {
        switch -CaseSensitive ($args[$i]) {
            "--input" {
                $i++
                $inputRc = $args[$i]
            }
            "--output" {
                $i++
                $outputFile = $args[$i]
            }
            "--include-dir" {
                $i++
                $includeDir = $args[$i]
            }
            default {
                $otherArgs += $args[$i]
            }
        }
        $i++
    }

    # 如果没有 --input 参数，直接调用 windres
    if (-not $inputRc) {
        & $realWindres @args
        exit $LASTEXITCODE
    }

    # 读取 .rc 文件内容
    $rcContent = Get-Content $inputRc -Raw -Encoding UTF8

    # 查找 .rc 文件中引用的所有文件路径（形如 "path" 的字符串，包含中文/全角字符）
    # 匹配 CJK 统一汉字(\u4e00-\u9fff)、CJK 符号(\u3000-\u303f)、全角字符(\uff00-\uffef)
    $pattern = '"((?:[A-Za-z]:\\|\\\\)[^"]*[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef][^"]*)"'
    $matches = [regex]::Matches($rcContent, $pattern)

    $fileMap = @{}  # 原路径 -> 临时文件名
    $copyIndex = 0

    foreach ($m in $matches) {
        # .rc 文件中路径用双反斜杠，复制文件时需要转换为单反斜杠的实际路径
        $rcPath = $m.Groups[1].Value
        $actualPath = $rcPath -replace '\\\\', '\'
        if (-not $fileMap.ContainsKey($rcPath)) {
            if (Test-Path $actualPath -ErrorAction SilentlyContinue) {
                $ext = [System.IO.Path]::GetExtension($actualPath)
                $tempName = "asset_$copyIndex$ext"
                $tempPath = Join-Path $tempBase $tempName
                Copy-Item -Force $actualPath $tempPath
                $fileMap[$rcPath] = $tempName
                $copyIndex++
            }
        }
    }

    # 替换 .rc 文件中的中文路径为临时文件名
    $processedContent = $rcContent
    foreach ($origPath in $fileMap.Keys) {
        # $origPath 已经是 .rc 文件中的双反斜杠格式，直接用于替换
        $processedContent = $processedContent -replace [regex]::Escape("`"$origPath`""), "`"$($fileMap[$origPath])`""
    }

    # 写入临时 .rc 文件
    $tempRc = Join-Path $tempBase "resource.rc"
    $processedContent | Out-File -FilePath $tempRc -Encoding UTF8 -NoNewline

    # 临时输出文件（在临时目录中）
    $tempOutput = Join-Path $tempBase "output.o"

    # 构建新的参数列表
    $newArgs = @()
    # 添加其他参数（--target, -c, -C, -no-preprocess, --output-format=coff 等）
    $newArgs += $otherArgs
    $newArgs += @("--input", $tempRc)
    $newArgs += @("--output", $tempOutput)
    # --include-dir 指向临时目录
    $newArgs += @("--include-dir", $tempBase)

    # 调用真正的 windres
    & $realWindres @newArgs
    $exitCode = $LASTEXITCODE

    # 如果成功，把输出文件复制回原位置
    if ($exitCode -eq 0 -and $outputFile -and (Test-Path $tempOutput)) {
        $outDir = Split-Path -Parent $outputFile
        if ($outDir -and -not (Test-Path $outDir)) {
            New-Item -ItemType Directory -Force $outDir | Out-Null
        }
        Copy-Item -Force $tempOutput $outputFile
    }

    exit $exitCode
}
finally {
    # 清理临时目录
    if (Test-Path $tempBase) {
        Remove-Item -Recurse -Force $tempBase -ErrorAction SilentlyContinue
    }
}
