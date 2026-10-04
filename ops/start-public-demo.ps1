param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$project = (Get-Location).Path
$private = Join-Path $project 'artifacts/private/public-demo'
New-Item -ItemType Directory -Path $private -Force | Out-Null
$supervisorState=Join-Path $private 'supervisor-state.json'
if(Test-Path -LiteralPath $supervisorState){
    $previous=Get-Content -LiteralPath $supervisorState -Raw | ConvertFrom-Json
    $running=Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.supervisorPid)" -ErrorAction SilentlyContinue
    if($running -and $running.CommandLine -match 'maintain-public-demo\.ps1'){throw 'Nadzorca MOST już działa i sam wznawia API. Nie uruchomiono drugiego tunelu.'}
}
$listener = Get-NetTCPConnection -LocalPort 8127 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw 'Port 8127 jest zajęty. Sprawdź aktywną instancję; ten skrypt nie zatrzymuje istniejących procesów.' }
$binary = Join-Path $private 'cloudflared.exe'
if (!(Test-Path -LiteralPath $binary)) {
    $release = Invoke-RestMethod https://api.github.com/repos/cloudflare/cloudflared/releases/latest
    $asset = $release.assets | Where-Object name -eq 'cloudflared-windows-amd64.exe'
    if (!$asset -or !$asset.digest) { throw 'Brak oficjalnego pliku cloudflared z sumą kontrolną.' }
    Invoke-WebRequest $asset.browser_download_url -OutFile $binary
    $actual = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($asset.digest -ne "sha256:$actual") { throw 'Niepoprawna suma kontrolna cloudflared.' }
}
$manifest = Join-Path $private 'web-release/release-manifest.json'
if ($Rebuild -or !(Test-Path -LiteralPath $manifest)) {
    $env:MOST_PUBLIC_DEMO_BUILD = 'true'
    try { pnpm build; if ($LASTEXITCODE -ne 0) { throw 'Budowa publicznego pakietu nie powiodła się.' } }
    finally { Remove-Item Env:MOST_PUBLIC_DEMO_BUILD -ErrorAction SilentlyContinue }
}
$stamp = Get-Date -Format yyyyMMdd-HHmmss
$tunnelLog = Join-Path $private "tunnel-$stamp.stderr.log"
$tunnel = Start-Process -FilePath $binary -ArgumentList @('tunnel','--url','http://127.0.0.1:8127','--no-autoupdate') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $private "tunnel-$stamp.stdout.log") -RedirectStandardError $tunnelLog -PassThru
$origin = $null
for ($attempt = 0; $attempt -lt 150; $attempt++) {
    if ($tunnel.HasExited) { throw "Tunel zakończył działanie. Sprawdź $tunnelLog" }
    $match = Select-String -LiteralPath $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { $origin = $match.Matches.Value; break }
    Start-Sleep -Milliseconds 200
}
if (!$origin) { throw "Tunel nie opublikował adresu. Sprawdź $tunnelLog" }
$env:MOST_PUBLIC_DEMO_ORIGIN = $origin
$launcher = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoProfile','-Command','psst MOST_SIGNING_PRIVATE_KEY -- pnpm exec tsx ops/start-public-demo.ts') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $private "server-$stamp.stdout.log") -RedirectStandardError (Join-Path $private "server-$stamp.stderr.log") -PassThru
$metadata = [pscustomobject]@{origin=$origin;url="$origin/demo";launcherPid=$launcher.Id;tunnelPid=$tunnel.Id;port=8127;releaseManifestHash=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant();startedAt=[DateTime]::UtcNow.ToString('o')}
$metadata | ConvertTo-Json | Set-Content (Join-Path $private 'processes.json') -Encoding utf8NoBOM
$supervisor = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoProfile','-File',(Join-Path $PSScriptRoot 'maintain-public-demo.ps1')) -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $private "supervisor-$stamp.stdout.log") -RedirectStandardError (Join-Path $private "supervisor-$stamp.stderr.log") -PassThru
Write-Output "Demo: $origin/demo"
Write-Output "Materiały: $origin/materialy/"
Write-Output "Nadzorca procesów MOST: PID $($supervisor.Id)"
Write-Output 'Nowy tunel ma nowy adres. Zweryfikuj go i zaktualizuj linki zgłoszenia przed użyciem.'
