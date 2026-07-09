# 创建 karpathy-wiki SonarQube 项目并生成项目 token
$sonarHost = "http://localhost:9000"
$adminCreds = "admin:admin"
$headers = @{ "Content-Type" = "application/x-www-form-urlencoded" }
$basicAuth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($adminCreds))
$authHeaders = @{ "Authorization" = "Basic $basicAuth"; "Content-Type" = "application/x-www-form-urlencoded" }

# 1. 验证 admin/admin 是否可用
Write-Host "=== Testing admin login ==="
try {
    $me = Invoke-RestMethod -Uri "$sonarHost/api/users/search?q=login" -Headers $authHeaders -Method Get -TimeoutSec 5
    Write-Host "ADMIN_LOGIN: OK"
} catch {
    Write-Host "ADMIN_LOGIN: FAILED - $($_.Exception.Message)"
    Write-Host "Need user-provided SONAR_TOKEN"
    exit 1
}

# 2. 创建项目
Write-Host "=== Creating karpathy-wiki project ==="
$projBody = "name=Karpathy%20Wiki&project=karpathy_wiki&visibility=public"
try {
    $projResult = Invoke-RestMethod -Uri "$sonarHost/api/projects/create" -Headers $authHeaders -Method Post -Body $projBody -TimeoutSec 10
    Write-Host "PROJECT_CREATED: key=$($projResult.project.key)"
} catch {
    $err = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($err)
    $errBody = $reader.ReadToEnd()
    if ($errBody -match '"key.*?already exists"') {
        Write-Host "PROJECT_EXISTS: karpathy_wiki"
    } else {
        Write-Host "PROJECT_CREATE_FAILED: $errBody"
    }
}

# 3. 生成项目分析 token
Write-Host "=== Generating project analysis token ==="
$tokenName = "karpathy-wiki-token-" + (Get-Date -Format "yyyyMMddHHmmss")
$tokenBody = "name=$tokenName&type=PROJECT_ANALYSIS&projectKey=karpathy_wiki"
try {
    $tokenResult = Invoke-RestMethod -Uri "$sonarHost/api/user_tokens/generate" -Headers $authHeaders -Method Post -Body $tokenBody -TimeoutSec 10
    $token = $tokenResult.token
    Write-Host "TOKEN_GENERATED: name=$tokenName"
    # 写入临时文件供后续脚本读取
    $token | Out-File -FilePath "$env:TEMP\sonar_karpathy_token.txt" -NoNewline -Encoding ASCII
    Write-Host "TOKEN_FILE: $env:TEMP\sonar_karpathy_token.txt"
} catch {
    $err = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($err)
    $errBody = $reader.ReadToEnd()
    Write-Host "TOKEN_GENERATE_FAILED: $errBody"
}
