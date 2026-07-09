$drive = Get-PSDrive -Name $env:SystemDrive.TrimEnd(':')
$usedPct = [math]::Round(($drive.Used / ($drive.Used + $drive.Free)) * 100, 2)
Write-Host "DISK_USED_PCT: $usedPct"
Write-Host "FREE_GB: $([math]::Round($drive.Free/1GB, 2))"

if ($env:SONAR_TOKEN) {
    Write-Host "SONAR_TOKEN: present (length=$($env:SONAR_TOKEN.Length))"
} else {
    Write-Host "SONAR_TOKEN: missing"
}
