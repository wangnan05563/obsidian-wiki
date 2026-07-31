$path = 'd:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\.trae\skills\wiki-auto-testing\templates\test_result.json'
if (Test-Path $path) {
    Get-Content $path | Select-String -Pattern '"summary"|total|passed|failed|skipped' | Select-Object -First 10
}
