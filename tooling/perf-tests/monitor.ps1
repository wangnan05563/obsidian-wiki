# monitor.ps1 - Sample the karpathy-wiki backend node process during a JMeter run.
# Outputs a CSV: timestamp_epoch_ms, pid, cpu_pct, working_set_mb, threads, handles, io_read_bps
# Run in a separate terminal while JMeter runs:
#   pwsh -File tooling/perf-tests/monitor.ps1 -Out tooling/perf-tests/results/monitor-A-normal-small.csv
# Stop with Ctrl+C.

param(
  [string]$Out = "tooling/perf-tests/results/monitor.csv",
  [int]$IntervalSec = 2,
  [int]$Pid = 0
)

$ErrorActionPreference = 'SilentlyContinue'

# Resolve backend PID if not supplied (matches `tsx src/index.ts`)
if ($Pid -eq 0) {
  $proc = $null
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    $proc = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' AND CommandLine LIKE '%tsx src/index.ts%'" | Select-Object -First 1
    if (-not $proc) {
      $proc = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%src/index.ts%'" | Select-Object -First 1
    }
    if ($proc) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $proc) {
    Write-Host "ERROR: backend node process (tsx src/index.ts) not found after waiting." -ForegroundColor Red
    exit 1
  }
  $Pid = $proc.ProcessId
}
Write-Host "Monitoring backend PID=$Pid  (interval=${IntervalSec}s)  -> $Out"

$numCores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if (-not $numCores -or $numCores -lt 1) { $numCores = 1 }

# header
$Out = [System.IO.Path]::GetFullPath($Out)
"timestamp_epoch_ms,pid,cpu_pct,working_set_mb,threads,handles,io_read_bps" | Out-File -FilePath $Out -Encoding utf8

$prevCpu = $null
$prevIo = $null
$prevTs = $null

try {
  while ($true) {
    $p = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $Pid" -ErrorAction SilentlyContinue
    if (-not $p) {
      # backend may have been restarted (e.g. large-vault phase). Re-detect by commandline.
      $proc = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%tsx src/index.ts%'" | Select-Object -First 1
      if ($proc) {
        $Pid = $proc.ProcessId
        $prevCpu = $null; $prevIo = $null; $prevTs = $null
        Write-Host "Re-detected backend PID=$Pid"
        Start-Sleep -Seconds $IntervalSec
        continue
      }
      Write-Host "Backend process $Pid exited. Stopping monitor." -ForegroundColor Yellow
      break
    }
    $now = [DateTimeOffset]::UtcNow
    $tsMs = $now.ToUnixTimeMilliseconds()
    $wsMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
    $threads = $p.Threads.Count
    $handles = $p.HandleCount
    $cpuSec = $p.CPU              # total CPU seconds since process start
    $ioBytes = if ($cim) { $cim.ReadTransferCount } else { 0 }

    $cpuPct = 0.0
    $ioBps = 0
    if ($null -ne $prevCpu -and $null -ne $prevTs) {
      $dt = ($tsMs - $prevTs) / 1000.0
      if ($dt -gt 0) {
        $cpuPct = [math]::Round(($cpuSec - $prevCpu) / $dt / $numCores * 100, 1)
        $ioBps = [math]::Round(($ioBytes - $prevIo) / $dt, 0)
      }
    }
    $prevCpu = $cpuSec
    $prevIo = $ioBytes
    $prevTs = $tsMs

    "$tsMs,$Pid,$cpuPct,$wsMb,$threads,$handles,$ioBps" | Out-File -FilePath $Out -Encoding utf8 -Append
    Start-Sleep -Seconds $IntervalSec
  }
} finally {
  Write-Host "Monitor stopped. CSV written to $Out"
}
