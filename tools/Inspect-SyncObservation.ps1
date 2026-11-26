param(
  [ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$StartDate,
  [ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$EndDate
)
$ErrorActionPreference='Stop'
$oldUrl=$env:HEALTH_DATABASE_URL; $oldCa=$env:HEALTH_DATABASE_CA
try {
  $root=Split-Path -Parent $PSScriptRoot
  $today=[DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).Date
  if(-not $StartDate){$StartDate=$today.AddDays(-6).ToString('yyyy-MM-dd')}
  if(-not $EndDate){$EndDate=$today.AddDays(1).ToString('yyyy-MM-dd')}
  . (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
  $device=Read-BridgePrivateConfig 'android-device'
  $runtime=Read-BridgePrivateConfig 'database-runtime'
  $env:HEALTH_DATABASE_URL='postgresql://'+[Uri]::EscapeDataString($runtime.username)+':'+
    [Uri]::EscapeDataString($runtime.password)+'@'+$runtime.host+':'+$runtime.port+'/postgres'
  $runtime.password=$null
  $env:HEALTH_DATABASE_CA=[IO.File]::ReadAllText((Join-Path $root '.tools/supabase-ca.crt'))
  @{ownerId=$device.configuration.ownerId;sourceId=$device.configuration.sourceId;
    types=@($device.configuration.allowedTypes);start=$StartDate+'T00:00:00+08:00';end=$EndDate+'T00:00:00+08:00'}|
    ConvertTo-Json -Compress| & node (Join-Path $root 'backend/sync-observation-diagnostic.mts')
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}catch{Write-Output '{"error":"SYNC_OBSERVATION_CONFIG_UNAVAILABLE"}';exit 1}
finally{$env:HEALTH_DATABASE_URL=$oldUrl;$env:HEALTH_DATABASE_CA=$oldCa}
