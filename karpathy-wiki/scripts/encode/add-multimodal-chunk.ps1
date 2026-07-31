# FR-09-2: Append multimodal field to AnswerChunk in api/src/types.ts
$ErrorActionPreference = 'Stop'
$typesPath = 'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\types.ts'

$content = [System.IO.File]::ReadAllText($typesPath, [System.Text.UTF8Encoding]::new($false))

# Locate the AnswerChunk closing pattern: `messageIndex?: number;` followed by `\r\n}`
$needle = "messageIndex?: number;`r`n}"
$idx = $content.IndexOf($needle)
if ($idx -lt 0) { throw 'Cannot find AnswerChunk closing brace after messageIndex' }

# Insert new field between `messageIndex?: number;` and `\r\n}`
$insertion = "`r`n  // FR-09-2 multimodal output (appended after main answer in SSE stream)`r`n  multimodal?: MultimodalOutput;"

$before = $content.Substring(0, $idx + "messageIndex?: number;".Length)
$after = $content.Substring($idx + "messageIndex?: number;".Length)
$newContent = $before + $insertion + $after

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($typesPath, $newContent, $utf8NoBom)

Write-Host ('FR-09-2 AnswerChunk.multimodal field added at offset ' + $idx)
