# Safely (re)start the overlay server, guaranteeing a SINGLE poller against PrusaLink.
# A second poller has wedged the printer board mid-print before, so this stops ONLY an
# existing `node server.js` or `bun server.js` on the configured port, waits for the
# port to free, then starts exactly one Bun process.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing config file: $configPath"
}

$cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = if ($null -ne $cfg.port -and "$($cfg.port)".Trim()) { [int]$cfg.port } else { 8787 }
if ($port -lt 1 -or $port -gt 65535) {
  throw "Invalid overlay port in config.json: $port"
}

$cacheDir = Join-Path $root 'cache'
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$log = Join-Path $cacheDir 'overlay.log'
$err = Join-Path $cacheDir 'overlay.err.log'
$bunExecutable = & bun -p process.execPath
if ($LASTEXITCODE -eq 0 -and $bunExecutable) { $bunExecutable = "$bunExecutable".Trim() }
if ($LASTEXITCODE -ne 0 -or -not $bunExecutable -or [IO.Path]::GetExtension($bunExecutable) -ine '.exe' -or
    -not (Test-Path -LiteralPath $bunExecutable -PathType Leaf)) {
  throw 'Native Bun executable not found. Install the pinned Bun version before restarting the overlay.'
}

Write-Host "Preflighting Bun $(& $bunExecutable --version) before touching the live listener"
Push-Location $root
try {
  & $bunExecutable run check
  if ($LASTEXITCODE -ne 0) { throw "Bun syntax/config checks failed with exit code $LASTEXITCODE." }
  & $bunExecutable test
  if ($LASTEXITCODE -ne 0) { throw "Bun tests failed with exit code $LASTEXITCODE." }
  & $bunExecutable run smoke
  if ($LASTEXITCODE -ne 0) { throw "Bun smoke test failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

function Get-PortListeners {
  try {
    return @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
  } catch {
    # Get-NetTCPConnection can require permissions that a normal OBS-side shell does
    # not have. netstat exposes the same owning PID without elevation.
    $pattern = "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    return @(
      & "$env:SystemRoot\System32\netstat.exe" -ano -p TCP |
        ForEach-Object {
          if ($_ -match $pattern) {
            [pscustomobject]@{ OwningProcess = [int]$Matches[1] }
          }
        }
    )
  }
}

function Get-ErrorLogTail {
  if (-not (Test-Path -LiteralPath $err)) { return '(error log was not created)' }
  $tail = @(Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue)
  if ($tail.Count -eq 0) { return '(error log is empty)' }
  return ($tail -join [Environment]::NewLine)
}

function Test-OverlayApiFingerprint {
  try {
    $existingState = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 2
    return $null -ne $existingState.PSObject.Properties['updatedAt'] -and
      $null -ne $existingState.PSObject.Properties['online'] -and
      $null -ne $existingState.PSObject.Properties['toolCount'] -and
      $null -ne $existingState.PSObject.Properties['toolSlots']
  } catch {
    return $false
  }
}

$listeners = Get-PortListeners
$listenerPids = @($listeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
$overlayProcesses = @()

# Classify every unique listener before stopping anything. If any listener is not this
# repository's Node-to-Bun entrypoint, abort and leave all processes untouched.
foreach ($ownerPid in $listenerPids) {
  $proc = $null
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
  } catch {
    # Some managed shells deny CIM process command-line reads. Fall back to the
    # executable name plus a fingerprint of this overlay's read-only state API.
  }

  if ($proc) {
    $isSupportedRuntime = $proc.Name -match '^(?i:(?:bun|node)(?:\.exe)?)$'
    $isServerJs = $proc.CommandLine -match '(?i)(?:^|[\\/"\s])server\.js(?:["\s]|$)'
    if (-not ($isSupportedRuntime -and $isServerJs)) {
      throw "Port $port is held by a non-overlay process (PID $($proc.ProcessId): $($proc.Name)). Refusing to stop it."
    }
  } else {
    $basicProc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if (-not $basicProc) { continue } # Listener exited between netstat and lookup.
    if ($basicProc.ProcessName -notmatch '^(?i:(?:bun|node))$') {
      throw "Port $port is held by an unsupported process (PID ${ownerPid}: $($basicProc.ProcessName)). Refusing to stop it."
    }
  }

  if (-not (Test-OverlayApiFingerprint)) {
    throw "Port $port is held by runtime PID $ownerPid, but its API is not this overlay. Refusing to stop it."
  }
  $overlayProcesses += [pscustomobject]@{ ProcessId = [int]$ownerPid }
}

foreach ($proc in $overlayProcesses) {
  Write-Host "Stopping existing overlay server (PID $($proc.ProcessId))"
  Stop-Process -Id $proc.ProcessId -Force
}

# Wait up to 10s for the port to actually free before starting a new instance.
$releaseDeadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $heldListeners = Get-PortListeners
  if ($heldListeners.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $releaseDeadline)

if ($heldListeners.Count -gt 0) {
  $heldPids = @($heldListeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique) -join ', '
  throw "Port $port is still held after 10 seconds (PID(s): $heldPids). Overlay was not started."
}

$child = Start-Process -FilePath $bunExecutable -ArgumentList 'server.js' -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err -PassThru

$healthUri = "http://127.0.0.1:$port/api/state"
$healthDeadline = [DateTime]::UtcNow.AddSeconds(15)
$lastHealthError = 'health check was not attempted'

while ([DateTime]::UtcNow -lt $healthDeadline) {
  $child.Refresh()
  if ($child.HasExited) {
    $child.WaitForExit()
    throw ("Overlay process PID {0} exited with code {1} before becoming healthy.`nError log tail ({2}):`n{3}" -f `
      $child.Id, $child.ExitCode, $err, (Get-ErrorLogTail))
  }

  try {
    $response = Invoke-WebRequest -Uri $healthUri -TimeoutSec 2
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      $healthPids = @(Get-PortListeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
      if ($healthPids.Count -eq 1 -and [int]$healthPids[0] -eq [int]$child.Id) {
        Write-Host "Overlay server healthy on port $port (PID $($child.Id); logs: cache\overlay.log)"
        return
      }
      $lastHealthError = "HTTP was healthy, but port $port belongs to PID(s): $($healthPids -join ', ')"
      Start-Sleep -Milliseconds 400
      continue
    }
    $lastHealthError = "HTTP $($response.StatusCode)"
  } catch {
    $lastHealthError = $_.Exception.Message
  }
  Start-Sleep -Milliseconds 400
}

$errorTail = Get-ErrorLogTail
$child.Refresh()
if (-not $child.HasExited) {
  Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
  $childDisposition = " The unhealthy child PID $($child.Id) was stopped."
} else {
  $childDisposition = " Child PID $($child.Id) had already exited."
}
throw ("Overlay did not become healthy at {0} within 15 seconds. Last health error: {1}.{2}`nError log tail ({3}):`n{4}" -f `
  $healthUri, $lastHealthError, $childDisposition, $err, $errorTail)
