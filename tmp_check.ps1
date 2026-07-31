$file = 'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\api\src\routes\prompts.ts'
$bytes = [System.IO.File]::ReadAllBytes($file)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$lines = $text -split "`r?`n"
for ($i = 69; $i -lt 76; $i++) {
    Write-Host ("{0:D3}: [{1}]" -f ($i+1), $lines[$i])
}
