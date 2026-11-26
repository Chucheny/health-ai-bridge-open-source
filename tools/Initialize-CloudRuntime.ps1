param([Parameter(Mandatory)][ValidatePattern('^[a-z]{20}$')][string]$ProjectRef,[switch]$ApplyTrainingCampMigrations)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
$previousAdmin = $env:HEALTH_ADMIN_DATABASE_URL
$previousRuntime = $env:HEALTH_RUNTIME_DATABASE_URL
$previousCa = $env:HEALTH_DATABASE_CA
try {
    $admin = Read-BridgePrivateConfig 'database-admin'
    if ($admin.username -cne "postgres.$ProjectRef") { throw 'Unexpected project.' }
    $directory = Get-BridgePrivateDirectory
    if (Test-Path -LiteralPath (Join-Path $directory 'database-runtime.dpapi')) {
        $runtime = Read-BridgePrivateConfig 'database-runtime'
    } else {
        if ($ApplyTrainingCampMigrations) { throw 'Migration requires an existing runtime configuration.' }
        $runtime = @{
            username = 'health_bridge_runtime.' + $ProjectRef
            password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_')
            host = $admin.host; port = $admin.port
        }
        # Persist BEFORE remote commit so retries never lose a generated credential.
        Save-BridgePrivateConfig 'database-runtime' ($runtime | ConvertTo-Json -Compress)
    }
    $env:HEALTH_ADMIN_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($admin.username) + ':' + [Uri]::EscapeDataString($admin.password) + '@' + $admin.host + ':' + $admin.port + '/postgres'
    $env:HEALTH_RUNTIME_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($runtime.username) + ':' + [Uri]::EscapeDataString($runtime.password) + '@' + $runtime.host + ':' + $runtime.port + '/postgres'
    $admin.password = $null; $runtime.password = $null
    $env:HEALTH_DATABASE_CA = [IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) '.tools\supabase-ca.crt'))
    $bootstrapArgs = @()
    if ($ApplyTrainingCampMigrations) { $bootstrapArgs += '--apply-trainingcamp-migrations' }
    & node (Join-Path (Split-Path -Parent $PSScriptRoot) 'backend\hosted-bootstrap.mts') @bootstrapArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch { Write-Output 'RUNTIME_CONFIG_NOT_READY'; exit 1 }
finally {
    $env:HEALTH_ADMIN_DATABASE_URL = $previousAdmin
    $env:HEALTH_RUNTIME_DATABASE_URL = $previousRuntime
    $env:HEALTH_DATABASE_CA = $previousCa
}
