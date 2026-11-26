param([switch]$IncludeTrainingCamp)
$ErrorActionPreference = 'Stop'
$previousUrl = $env:HEALTH_DATABASE_URL
$previousCa = $env:HEALTH_DATABASE_CA
try {
    $root = Split-Path -Parent $PSScriptRoot
    $configPath = Join-Path $root 'private\cloud\database-runtime.dpapi'
    $certificatePath = Join-Path $root '.tools\supabase-ca.crt'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
        throw 'Existing runtime configuration unavailable.'
    }
    . (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
    # Reuse the restricted runtime login, not the administrator or device token.
    # The existing config reader reasserts the private directory ACL locally.
    $config = Read-BridgePrivateConfig 'database-runtime'
    $env:HEALTH_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($config.username) + ':' +
        [Uri]::EscapeDataString($config.password) + '@' + $config.host + ':' + $config.port + '/postgres'
    $config.password = $null
    $env:HEALTH_DATABASE_CA = [IO.File]::ReadAllText($certificatePath)
    $capacityArgs = @()
    if ($IncludeTrainingCamp) { $capacityArgs += '--include-trainingcamp' }
    & node (Join-Path $root 'backend\capacity-diagnostic.mts') @capacityArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Output '{"error":"CAPACITY_CONFIG_UNAVAILABLE"}'
    exit 1
} finally {
    $env:HEALTH_DATABASE_URL = $previousUrl
    $env:HEALTH_DATABASE_CA = $previousCa
}
