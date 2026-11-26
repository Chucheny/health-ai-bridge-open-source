param([switch]$Https,[uri]$BaseUrl,[switch]$LargeBatch)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
$names = @('HEALTH_ADMIN_DATABASE_URL','HEALTH_RUNTIME_DATABASE_URL','HEALTH_DATABASE_CA','HEALTH_SMOKE_BASE_URL','HEALTH_SMOKE_LARGE_BATCH')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    if ([bool]$Https -ne [bool]$BaseUrl) { throw 'Specify -Https and -BaseUrl together.' }
    if ($Https -and (-not $BaseUrl.IsAbsoluteUri -or $BaseUrl.Scheme -ne 'https' -or $BaseUrl.UserInfo -or
        $BaseUrl.PathAndQuery -ne '/' -or $BaseUrl.Fragment)) { throw 'Supply an HTTPS origin.' }
    $admin = Read-BridgePrivateConfig 'database-admin'
    $runtime = Read-BridgePrivateConfig 'database-runtime'
    $env:HEALTH_ADMIN_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($admin.username) + ':' + [Uri]::EscapeDataString($admin.password) + '@' + $admin.host + ':' + $admin.port + '/postgres'
    $env:HEALTH_RUNTIME_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($runtime.username) + ':' + [Uri]::EscapeDataString($runtime.password) + '@' + $runtime.host + ':' + $runtime.port + '/postgres'
    $admin.password = $null; $runtime.password = $null
    $root = Split-Path -Parent $PSScriptRoot
    $env:HEALTH_DATABASE_CA = [IO.File]::ReadAllText((Join-Path $root '.tools\supabase-ca.crt'))
    $env:HEALTH_SMOKE_BASE_URL = if ($Https) { $BaseUrl.GetLeftPart([UriPartial]::Authority) } else { $null }
    $env:HEALTH_SMOKE_LARGE_BATCH = if ($LargeBatch) { 'true' } else { $null }
    & node (Join-Path $root 'backend\hosted-smoke.mts')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch { Write-Output 'CLOUD_API_TEST_NOT_READY'; exit 1 }
finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') } }
