# FR-09-2 前端 types.ts 添加 MultimodalOutput 类型与 ChatMessage.multimodal 字段
# 为什么用 PowerShell：types.ts 中文乱码，Edit 工具字符串匹配不可靠，改用 ASCII 锚点 + 字节级插入
$ErrorActionPreference = 'Stop'

$typesPath = Join-Path $PSScriptRoot '..\..\frontend\src\types.ts'
$resolved = Resolve-Path $typesPath
$content = [System.IO.File]::ReadAllText($resolved.Path, [System.Text.UTF8Encoding]::new($false))

# Step 1: 在 ChatMessage 接口的 archived 字段后追加 multimodal 字段
$archivedNeedle = "  archived?: boolean;`r`n}"
$archivedIdx = $content.IndexOf($archivedNeedle)
if ($archivedIdx -lt 0) { throw 'Cannot find ChatMessage archived closing brace' }

$multimodalField = "`r`n  // FR-09-2 multimodal output (mindmap/faq/timeline), rendered as separate card after main answer`r`n  multimodal?: MultimodalOutput;"

$before = $content.Substring(0, $archivedIdx + "  archived?: boolean;".Length)
$after = $content.Substring($archivedIdx + "  archived?: boolean;".Length)
$content = $before + $multimodalField + $after

# Step 2: 在 "// ===== query" 标记之前插入 MultimodalOutput 接口定义
$queryMarker = "// ===== query"
$markerIdx = $content.IndexOf($queryMarker)
if ($markerIdx -lt 0) { throw 'Cannot find query section marker' }

$multimodalInterface = @"
// FR-09-2 multimodal output payload (aligned with backend MultimodalOutput, type-sync-rule CODING-015)
// type: 'mindmap' Mermaid mindmap | 'faq' Q&A pairs | 'timeline' events sorted by created
// content: raw text in corresponding format (mindmap=Mermaid syntax, faq/timeline=Markdown)
export interface MultimodalOutput {
  type: 'mindmap' | 'faq' | 'timeline';
  content: string;
}

"@

$content = $content.Substring(0, $markerIdx) + $multimodalInterface + $content.Substring($markerIdx)

# 写回文件（UTF-8 无 BOM）
[System.IO.File]::WriteAllText($resolved.Path, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Frontend types.ts updated: MultimodalOutput interface + ChatMessage.multimodal field added'
