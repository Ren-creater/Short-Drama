param(
    [string]$ClusterHost = "gpucluster2",
    [string]$RemoteSpecDir = "/vol/bitbucket/zr523/SPEC",
    [int]$RemotePort = 8001,
    [int]$LocalTunnelPort = 8001,
    [int]$LocalWebPort = 3100
)

$ErrorActionPreference = "Stop"

function Import-LocalEnv {
    param([string]$EnvFilePath)
    if (Test-Path $EnvFilePath) {
        . $EnvFilePath
    }
}

function Test-ProcessAlive {
    param([string]$PidFilePath)
    if (-not (Test-Path $PidFilePath)) { return $false }
    $raw = Get-Content $PidFilePath -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $raw) { return $false }
    $pidVal = 0
    if (-not [int]::TryParse($raw, [ref]$pidVal)) { return $false }
    try {
        $null = Get-Process -Id $pidVal -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-ListeningPids {
    param([int]$Port)
    $portPids = @()
    $lines = netstat -ano | Select-String ":$Port"
    foreach ($line in $lines) {
        $text = ($line.ToString()).Trim()
        if ($text -notmatch "LISTENING") { continue }
        $parts = $text -split "\s+"
        if ($parts.Count -lt 5) { continue }
        $local = $parts[1]
        $pidValue = $parts[-1]
        if ($local -match "[:\.]$Port$" -and $pidValue -match "^\d+$") {
            $portPids += [int]$pidValue
        }
    }
    return ($portPids | Select-Object -Unique)
}

function Start-RemoteSpecServer {
    param([string]$ClusterName, [string]$SpecDir, [int]$Port)
    $remoteCmd = @"
bash -lc '
if lsof -i :$Port -sTCP:LISTEN >/dev/null 2>&1; then
  echo SPEC_ALREADY_LISTENING
else
  source /vol/bitbucket/zr523/miniconda3/etc/profile.d/conda.sh &&
  conda activate spec &&
  cd $SpecDir &&
  export HF_HOME=/vol/bitbucket/zr523/.cache/huggingface &&
  export HF_HUB_CACHE=/vol/bitbucket/zr523/.cache/huggingface/hub &&
  export ANISWAP_PROVIDER=local &&
  export ANISWAP_SCHEDULER=slurm &&
  export ANISWAP_REQUIRE_SCHEDULER=1 &&
  nohup python server.py > /tmp/spec_server_gpucluster2.log 2>&1 &
  sleep 2
fi
lsof -i :$Port -sTCP:LISTEN || true
'
"@
    Write-Host "[1/4] Ensuring remote SPEC server is running on ${ClusterName}:$Port ..."
    ssh -o BatchMode=yes $ClusterName $remoteCmd | Out-Host
}

function Start-Tunnel {
    param(
        [string]$ClusterName,
        [int]$LocalPort,
        [int]$RemotePort,
        [string]$TunnelPidFile
    )
    if (Test-ProcessAlive -PidFilePath $TunnelPidFile) {
        $pidVal = Get-Content $TunnelPidFile | Select-Object -First 1
        Write-Host "[2/4] SSH tunnel already running (PID $pidVal)."
        return
    }

    Write-Host "[2/4] Starting SSH tunnel localhost:$LocalPort -> ${ClusterName}:$RemotePort ..."
    $proc = Start-Process -FilePath ssh -ArgumentList @("-N", "-L", "$LocalPort`:localhost:$RemotePort", $ClusterName) -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if (-not $proc -or -not $proc.Id) {
        throw "Failed to start SSH tunnel."
    }
    $proc.Id | Set-Content -Path $TunnelPidFile -Encoding ascii
    Write-Host "      Tunnel PID: $($proc.Id)"
}

function Start-LocalWebServer {
    param(
        [string]$RepoRoot,
        [int]$TunnelPort,
        [int]$WebPort,
        [string]$WebPidFile
    )
    if (Test-ProcessAlive -PidFilePath $WebPidFile) {
        $pidVal = Get-Content $WebPidFile | Select-Object -First 1
        Write-Host "[3/4] Local web server already running (PID $pidVal)."
        return
    }

    $selectedPort = $WebPort
    $ownerPids = Get-ListeningPids -Port $selectedPort
    while ($ownerPids.Count -gt 0) {
        $ownerPid = $ownerPids[0]
        $reuse = $false
        try {
            $existingHealth = Invoke-RestMethod -Method Get -Uri "http://localhost:$selectedPort/api/health" -TimeoutSec 8
            if ($existingHealth.base_url -eq "http://localhost:$TunnelPort") {
                Write-Host "[3/4] Local web server already healthy on port $selectedPort (PID $ownerPid)."
                $reuse = $true
            }
        } catch {
            $reuse = $false
        }
        if ($reuse) {
            $ownerPid | Set-Content -Path $WebPidFile -Encoding ascii
            return $selectedPort
        }
        try {
            $ownerProc = Get-Process -Id $ownerPid -ErrorAction Stop
            if ($ownerProc.ProcessName -ieq "node") {
                Write-Host "[3/4] Port $selectedPort is occupied by node PID $ownerPid. Restarting it in cluster mode..."
                Stop-Process -Id $ownerPid -Force -ErrorAction Stop
                Start-Sleep -Seconds 1
                break
            }
            Write-Host "[3/4] Port $selectedPort is occupied by $($ownerProc.ProcessName) PID $ownerPid. Trying next port..."
            $selectedPort++
            $ownerPids = Get-ListeningPids -Port $selectedPort
            continue
        } catch {
            Write-Host "[3/4] Port $selectedPort is occupied by PID $ownerPid. Trying next port..."
            $selectedPort++
            $ownerPids = Get-ListeningPids -Port $selectedPort
            continue
        }
    }

    Write-Host "[3/4] Starting local web server on http://localhost:$selectedPort ..."
    $runtimeDir = Split-Path -Parent $WebPidFile
    New-Item -Path $runtimeDir -ItemType Directory -Force | Out-Null
    $stdoutLog = Join-Path $runtimeDir "web_stdout.log"
    $stderrLog = Join-Path $runtimeDir "web_stderr.log"
    $oldBase = $env:DASHSCOPE_BASE_URL
    $oldKey = $env:DASHSCOPE_API_KEY
    $oldKimiKey = $env:KIMI_API_KEY
    $oldNvidiaKey = $env:NVIDIA_API_KEY
    $oldKimiModel = $env:KIMI_MODEL
    $oldKimiBase = $env:KIMI_BASE_URL
    $oldPort = $env:PORT
    $env:DASHSCOPE_BASE_URL = "http://localhost:$TunnelPort"
    $env:DASHSCOPE_API_KEY = ""
    $env:PORT = "$selectedPort"
    $proc = Start-Process -FilePath "node" -ArgumentList @("server.js") -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $env:DASHSCOPE_BASE_URL = $oldBase
    $env:DASHSCOPE_API_KEY = $oldKey
    $env:KIMI_API_KEY = $oldKimiKey
    $env:NVIDIA_API_KEY = $oldNvidiaKey
    $env:KIMI_MODEL = $oldKimiModel
    $env:KIMI_BASE_URL = $oldKimiBase
    $env:PORT = $oldPort
    Start-Sleep -Seconds 2
    if (-not $proc -or -not $proc.Id) {
        throw "Failed to start local web server."
    }
    $proc.Id | Set-Content -Path $WebPidFile -Encoding ascii
    Write-Host "      Web server PID: $($proc.Id)"

    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-RestMethod -Method Get -Uri "http://localhost:$selectedPort/api/health" -TimeoutSec 4
            return $selectedPort
        } catch {
            # keep waiting
        }
    }
    $stderr = ""
    if (Test-Path $stderrLog) {
        $stderr = (Get-Content $stderrLog -ErrorAction SilentlyContinue | Select-Object -Last 20) -join "`n"
    }
    throw "Local web server did not become healthy. Last stderr lines:`n$stderr"
}

function Invoke-Health {
    param([string]$Url)
    try {
        return Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 20
    } catch {
        throw "Health check failed at $Url : $($_.Exception.Message)"
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $repoRoot ".runtime"
New-Item -Path $runtimeDir -ItemType Directory -Force | Out-Null
$localEnvFile = Join-Path $runtimeDir "local_env.ps1"

Import-LocalEnv -EnvFilePath $localEnvFile

$tunnelPidFile = Join-Path $runtimeDir "cluster_tunnel.pid"
$webPidFile = Join-Path $runtimeDir "cluster_web.pid"

Start-RemoteSpecServer -ClusterName $ClusterHost -SpecDir $RemoteSpecDir -Port $RemotePort
Start-Tunnel -ClusterName $ClusterHost -LocalPort $LocalTunnelPort -RemotePort $RemotePort -TunnelPidFile $tunnelPidFile
$resolvedWebPort = Start-LocalWebServer -RepoRoot $repoRoot -TunnelPort $LocalTunnelPort -WebPort $LocalWebPort -WebPidFile $webPidFile

Write-Host "[4/4] Verifying health ..."
$clusterHealth = Invoke-Health -Url "http://localhost:$LocalTunnelPort/health"
$webHealth = Invoke-Health -Url "http://localhost:$resolvedWebPort/api/health"

Write-Host ""
Write-Host "Cluster API: http://localhost:$LocalTunnelPort/health"
Write-Host ("  provider: {0}, all_ready: {1}" -f $clusterHealth.provider, $clusterHealth.all_ready)
Write-Host "Web Proxy:   http://localhost:$resolvedWebPort/api/health"
Write-Host ("  base_url: {0}" -f $webHealth.base_url)
Write-Host ("  message:  {0}" -f $webHealth.message)
if ($webHealth.llm) {
    Write-Host ("  llm:      {0} ({1})" -f $webHealth.llm.provider, $webHealth.llm.model)
}
Write-Host ""
if (-not (Test-Path $localEnvFile)) {
    Write-Host "Tip: create $localEnvFile to persist local-only secrets like KIMI_API_KEY."
    Write-Host '$env:KIMI_API_KEY="your-key"'
    Write-Host '$env:KIMI_MODEL="moonshotai/kimi-k2.5"'
    Write-Host ""
}
Write-Host "Ready: open http://localhost:$resolvedWebPort"
