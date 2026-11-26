# Stops the server listening on $Port (default from PORT env or 4343).
#   npm run stop            # stops whatever listens on 4343
#   npm run stop -- 4343    # explicit

param([int]$Port = 0)
$ErrorActionPreference = "SilentlyContinue"

if (-not $Port -and $env:PORT) { $Port = [int]$env:PORT }
if (-not $Port) { $Port = 4343 }

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen
if (-not $conns) {
  Write-Host "Nothing is listening on port $Port."
  exit 0
}

$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $pids) {
  Stop-Process -Id $procId -Force
  Write-Host "Stopped PID $procId (port $Port)."
}
