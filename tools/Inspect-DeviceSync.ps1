param([switch]$Integrity)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
$previousUrl=$env:HEALTH_ADMIN_DATABASE_URL
$previousCa=$env:HEALTH_DATABASE_CA
$previousIntegrity=$env:HEALTH_DEVICE_INTEGRITY
try {
    $device=Read-BridgePrivateConfig 'android-device'
    $admin=Read-BridgePrivateConfig 'database-admin'
    $env:HEALTH_ADMIN_DATABASE_URL='postgresql://'+[Uri]::EscapeDataString($admin.username)+':'+[Uri]::EscapeDataString($admin.password)+'@'+$admin.host+':'+$admin.port+'/postgres'
    $admin.password=$null
    $root=Split-Path -Parent $PSScriptRoot
    $env:HEALTH_DATABASE_CA=[IO.File]::ReadAllText((Join-Path $root '.tools\supabase-ca.crt'))
    $env:HEALTH_DEVICE_INTEGRITY=if($Integrity){'true'}else{$null}
    @{ownerId=$device.configuration.ownerId;sourceId=$device.configuration.sourceId}|ConvertTo-Json -Compress| & node (Join-Path $root 'backend\device-sync-diagnostic.mts')
    if($LASTEXITCODE-ne 0){exit $LASTEXITCODE}
}catch{Write-Output 'DEVICE_SYNC_INSPECTION_FAILED';exit 1}
finally{$env:HEALTH_ADMIN_DATABASE_URL=$previousUrl;$env:HEALTH_DATABASE_CA=$previousCa;$env:HEALTH_DEVICE_INTEGRITY=$previousIntegrity}
