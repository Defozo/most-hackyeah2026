$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$metadata=Get-Content artifacts/private/public-demo/processes.json -Raw | ConvertFrom-Json
$origin=$metadata.origin
$supervisor=Get-Content artifacts/private/public-demo/supervisor-state.json -Raw | ConvertFrom-Json
if(!$supervisor.serverReady -or !(Get-Process -Id $supervisor.supervisorPid -ErrorAction SilentlyContinue)){throw 'Nadzorca lub API nie jest gotowe.'}
$localBefore=Invoke-RestMethod http://localhost:8137/api/health/ready
$guest=Invoke-RestMethod "$origin/api/auth/demo" -Method Post -Headers @{Origin=$origin} -ContentType application/json -Body '{}' -SessionVariable demoCookies
$before=Invoke-RestMethod "$origin/api/snapshot" -WebSession $demoCookies
$listener=Get-NetTCPConnection -LocalPort 8127 -State Listen
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'ops[\\/]start-public-demo\.ts'){throw 'Nie rozpoznano własnego procesu API MOST.'}
$oldPid=$listener.OwningProcess
$started=Get-Date
Stop-Process -Id $oldPid
$newPid=$null
for($attempt=0;$attempt -lt 18;$attempt++){
    Start-Sleep -Seconds 5
    $candidate=Get-NetTCPConnection -LocalPort 8127 -State Listen -ErrorAction SilentlyContinue
    if($candidate -and $candidate.OwningProcess -ne $oldPid){
        try{if((Invoke-RestMethod http://localhost:8127/api/health/ready -TimeoutSec 3).ready){$newPid=$candidate.OwningProcess;break}}catch{}
    }
}
if(!$newPid){throw 'API nie wróciło w oknie weryfikacji.'}
$after=Invoke-RestMethod "$origin/api/snapshot" -WebSession $demoCookies
$localAfter=Invoke-RestMethod http://localhost:8137/api/health/ready
$afterMetadata=Get-Content artifacts/private/public-demo/processes.json -Raw | ConvertFrom-Json
$passed=$before.organizationId -eq $after.organizationId -and $before.serverEpoch -eq $after.serverEpoch -and $after.model.services.Count -eq 3 -and $localBefore.serverEpoch -eq $localAfter.serverEpoch -and $afterMetadata.origin -eq $origin -and $afterMetadata.tunnelPid -eq $metadata.tunnelPid
$report=[pscustomobject]@{verifiedAt=[DateTime]::UtcNow.ToString('o');passed=$passed;test='Kontrolowane zakończenie wyłącznie procesu publicznego API; automatyczne wznowienie na istniejącej bazie';oldApiPid=$oldPid;newApiPid=$newPid;recoveryMs=[Math]::Round(((Get-Date)-$started).TotalMilliseconds);sameOrganization=$before.organizationId -eq $after.organizationId;sameEpoch=$before.serverEpoch -eq $after.serverEpoch;sameSessionWorks=$true;separateLocal8137Unchanged=$localBefore.serverEpoch -eq $localAfter.serverEpoch;samePublicUrl=$afterMetadata.origin -eq $origin;tunnelRestartTested=$false}
$report | ConvertTo-Json | Set-Content artifacts/public-demo-supervisor-verification.json -Encoding utf8NoBOM
$report | ConvertTo-Json
if(!$passed){throw 'Nie wszystkie warunki odtworzenia procesu zostały potwierdzone.'}
