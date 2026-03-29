param()

$ErrorActionPreference = "Stop"

function Stop-ByPidFile {
    param([string]$PidFilePath, [string]$Label)
    if (-not (Test-Path $PidFilePath)) {
        Write-Host "${Label}: no pid file."
        return
    }
    $raw = Get-Content $PidFilePath -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $raw) {
        Remove-Item $PidFilePath -Force -ErrorAction SilentlyContinue
        Write-Host "${Label}: empty pid file removed."
        return
    }
    $pidVal = 0
    if (-not [int]::TryParse($raw, [ref]$pidVal)) {
        Remove-Item $PidFilePath -Force -ErrorAction SilentlyContinue
        Write-Host "${Label}: invalid pid file removed."
        return
    }
    try {
        Stop-Process -Id $pidVal -Force -ErrorAction Stop
        Write-Host "${Label}: stopped PID $pidVal."
    } catch {
        Write-Host "${Label}: process $pidVal not running."
    }
    Remove-Item $PidFilePath -Force -ErrorAction SilentlyContinue
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $repoRoot ".runtime"

$tunnelPidFile = Join-Path $runtimeDir "cluster_tunnel.pid"
$webPidFile = Join-Path $runtimeDir "cluster_web.pid"

Stop-ByPidFile -PidFilePath $webPidFile -Label "Web server"
Stop-ByPidFile -PidFilePath $tunnelPidFile -Label "SSH tunnel"

Write-Host "Done."
