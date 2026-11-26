$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
$previousAdminUrl = $env:HEALTH_ADMIN_DATABASE_URL
$previousDatabaseCa = $env:HEALTH_DATABASE_CA
try {
    $config = Read-BridgePrivateConfig 'database-admin'
    $env:HEALTH_ADMIN_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($config.username) + ':' +
        [Uri]::EscapeDataString($config.password) + '@' + $config.host + ':' + $config.port + '/postgres'
    $config.password = $null
    $certificatePath = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools\supabase-ca.crt'
    if (Test-Path -LiteralPath $certificatePath) { $env:HEALTH_DATABASE_CA = [IO.File]::ReadAllText($certificatePath) }
    & node (Join-Path (Split-Path -Parent $PSScriptRoot) 'backend\hosted-probe.mts')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch { Write-Output 'DATABASE_CONFIG_NOT_READY'; exit 1 }
finally { $env:HEALTH_ADMIN_DATABASE_URL = $previousAdminUrl; $env:HEALTH_DATABASE_CA = $previousDatabaseCa }
