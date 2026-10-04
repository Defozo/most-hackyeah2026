$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$project = (Get-Location).Path
$private = Join-Path $project 'artifacts/private/public-demo'
$created = $false
$mutex = [Threading.Mutex]::new($true, 'Local\MOST-public-demo-8127', [ref]$created)
if (!$created) { $mutex.Dispose(); throw 'Nadzorca MOST dla portu 8127 już działa.' }
$binary = Join-Path $private 'cloudflared.exe'
$metadataPath = Join-Path $private 'processes.json'
$statePath = Join-Path $private 'supervisor-state.json'
$failedHealth = 0
$lastRecovery = $null
function Own-Api([int]$processId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    return $process -and $process.Name -eq 'node.exe' -and $process.CommandLine -match 'ops[\\/]start-public-demo\.ts'
}
try {
    while (!(Test-Path -LiteralPath (Join-Path $private 'stop-supervisor'))) {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        $stamp = Get-Date -Format yyyyMMdd-HHmmss
        $tunnel = Get-Process -Id $metadata.tunnelPid -ErrorAction SilentlyContinue
        $changedOrigin = $false
        if (!$tunnel -or $tunnel.ProcessName -ne 'cloudflared' -or $tunnel.Path -ne $binary) {
            $log = Join-Path $private "tunnel-recovery-$stamp.stderr.log"
            $tunnel = Start-Process -FilePath $binary -ArgumentList @('tunnel','--url','http://127.0.0.1:8127','--no-autoupdate') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $private "tunnel-recovery-$stamp.stdout.log") -RedirectStandardError $log -PassThru
            $origin = $null
            for ($attempt=0; $attempt -lt 150; $attempt++) {
                if ($tunnel.HasExited) { throw 'Proces tunelu MOST zakończył działanie.' }
                $match = Select-String -LiteralPath $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($match) { $origin=$match.Matches.Value; break }
                Start-Sleep -Milliseconds 200
            }
            if (!$origin) { throw 'Tunel MOST nie zwrócił nowego adresu.' }
            $metadata.origin=$origin; $metadata.url="$origin/demo"; $metadata.tunnelPid=$tunnel.Id; $changedOrigin=$true
            $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM
            if (Test-Path -LiteralPath 'DEMO_ACCESS.json') {
                $access=Get-Content DEMO_ACCESS.json -Raw | ConvertFrom-Json
                $access.url=$metadata.url; $access.materialsUrl="$origin/materialy/"; $access.passed=$false
                $access | Add-Member -NotePropertyName 'linkUpdateRequired' -NotePropertyValue $true -Force
                $access | Add-Member -NotePropertyName 'recoveryAt' -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
                $access | ConvertTo-Json -Depth 8 | Set-Content DEMO_ACCESS.json -Encoding utf8NoBOM
            }
            $lastRecovery='Tunel uruchomiony ponownie; nowy adres wymaga weryfikacji i aktualizacji opublikowanych odsyłaczy.'
        }
        $healthy=$false
        try { $healthy=(Invoke-RestMethod http://127.0.0.1:8127/api/health/ready -TimeoutSec 5).ready -eq $true } catch { }
        if ($healthy) { $failedHealth=0 } else { $failedHealth++ }
        if ($changedOrigin -or !$healthy -and $failedHealth -ge 3) {
            $listener=Get-NetTCPConnection -LocalPort 8127 -State Listen -ErrorAction SilentlyContinue
            if ($listener) {
                if (!(Own-Api $listener.OwningProcess)) { throw 'Port 8127 zajmuje inny proces; nadzorca nie przejmie portu.' }
                Stop-Process -Id $listener.OwningProcess
            }
            $env:MOST_PUBLIC_DEMO_ORIGIN=$metadata.origin
            $launcher=Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoProfile','-Command','psst MOST_SIGNING_PRIVATE_KEY -- pnpm exec tsx ops/start-public-demo.ts') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $private "server-recovery-$stamp.stdout.log") -RedirectStandardError (Join-Path $private "server-recovery-$stamp.stderr.log") -PassThru
            $metadata.launcherPid=$launcher.Id
            $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM
            $failedHealth=0
            $lastRecovery='API MOST uruchomione ponownie na tej samej bazie publicznego ćwiczenia.'
        }
        [pscustomobject]@{supervisorPid=$PID;checkedAt=[DateTime]::UtcNow.ToString('o');serverReady=$healthy;tunnelPid=$metadata.tunnelPid;origin=$metadata.origin;lastRecovery=$lastRecovery} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8NoBOM
        Start-Sleep -Seconds 15
    }
} catch {
    [pscustomobject]@{supervisorPid=$PID;stoppedAt=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8NoBOM
    throw
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
