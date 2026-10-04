param([int]$Port = 8080, [switch]$Exercise, [switch]$Production)
$ErrorActionPreference = 'Stop'
if ($Exercise -and $Production) { throw 'Wybierz Exercise albo Production.' }
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:PORT = "$Port"
$env:APP_ORIGIN = "http://localhost:$Port"
if ($Exercise) {
    $env:DEMO_MODE = 'true'
    $env:DATA_DIR = Join-Path (Get-Location) (Join-Path 'data/exercises' ([guid]::NewGuid().ToString()))
    Write-Host "Osobna syntetyczna instalacja ćwiczenia: http://localhost:$Port"
    Write-Host "Dane: $env:DATA_DIR"
}
if ($Production) {
    $env:DEMO_MODE = 'false'
    $env:DATA_DIR = Join-Path (Get-Location) 'data/production'
    Write-Host "Pusta instalacja organizacji: http://localhost:$Port"
}
psst MOST_SIGNING_PRIVATE_KEY -- pnpm start
