# FR-09-2: Append multimodal output types to api/src/types.ts
# Why PowerShell: source file content is corrupted (GBK-as-UTF8), Edit tool can't match exact bytes
# Strategy: read raw bytes, decode as UTF-8, find anchor by ASCII-only pattern, insert new fields

$ErrorActionPreference = 'Stop'
$typesPath = 'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\types.ts'

# Read file as UTF-8 (preserve existing bytes; file is already UTF-8 encoded even though content is corrupted)
$content = [System.IO.File]::ReadAllText($typesPath, [System.Text.UTF8Encoding]::new($false))

# Find the QueryInput closing brace by locating the second `model?: string;` occurrence
# (first is in updateConfig signature). Use ASCII-only anchor to avoid encoding pitfalls.
$modelIdx = $content.IndexOf('model?: string;')
if ($modelIdx -lt 0) { throw 'Cannot find first model?: string; (updateConfig signature)' }
$secondModelIdx = $content.IndexOf('model?: string;', $modelIdx + 1)
if ($secondModelIdx -lt 0) { throw 'Cannot find second model?: string; (QueryInput)' }

# Find the closing brace of QueryInput after the second model?: string;
$closingBrace = $content.IndexOf('}', $secondModelIdx)
if ($closingBrace -lt 0) { throw 'Cannot find QueryInput closing brace' }

# Build the insertion: new field inside QueryInput + new MultimodalOutput interface after closing brace
$insertion = "`r`n  // FR-09-2 multimodal output mode: 'normal' default | 'mindmap' Mermaid | 'faq' Q&A pairs | 'timeline' events"
$insertion += "`r`n  outputMode?: 'normal' | 'mindmap' | 'faq' | 'timeline';"

$multimodalInterface = "`r`n`r`n// FR-09-2 multimodal output payload (sent to frontend for rendering)"
$multimodalInterface += "`r`nexport interface MultimodalOutput {"
$multimodalInterface += "`r`n  type: 'mindmap' | 'faq' | 'timeline';"
$multimodalInterface += "`r`n  content: string;"
$multimodalInterface += "`r`n}"
$multimodalInterface += "`r`n"

# Insert closing-brace insertion: field before brace, interface after brace
$newContent = $content.Substring(0, $closingBrace) + $insertion + $content.Substring($closingBrace)
# Recompute closing brace position after first insertion shifted offsets
$newClosingIdx = $closingBrace + $insertion.Length + 1  # +1 for the `}` char itself
$newContent = $newContent.Substring(0, $newClosingIdx) + $multimodalInterface + $newContent.Substring($newClosingIdx)

# Write back as UTF-8 no BOM
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($typesPath, $newContent, $utf8NoBom)

Write-Host 'FR-09-2 types added successfully:'
Write-Host ('  - QueryInput.outputMode field at offset ' + $secondModelIdx)
Write-Host ('  - MultimodalOutput interface at offset ' + $newClosingIdx)
