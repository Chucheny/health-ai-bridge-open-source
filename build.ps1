param([switch]$SkipChecks)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
$previousJava = $env:JAVA_HOME
$previousGradle = $env:GRADLE_USER_HOME
try {
    if (-not $env:JAVA_HOME -and -not (Get-Command java -ErrorAction SilentlyContinue)) {
        throw 'JDK 17 or 21 is required. Set JAVA_HOME to your JDK installation.'
    }
    $buildRoot = $PSScriptRoot
    if ($IsWindows -and $PSScriptRoot -match '[^\x00-\x7F]') {
        # A directory alias preserves originals and avoids the Windows JVM argfile encoding bug.
        $projectHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($PSScriptRoot))).Substring(0, 12)
        $buildRoot = Join-Path $env:TEMP "health-ai-bridge-$projectHash"
        if (Test-Path -LiteralPath $buildRoot) {
            $aliasItem = Get-Item -LiteralPath $buildRoot
            if ($aliasItem.LinkType -ne 'Junction' -or @($aliasItem.Target) -notcontains $PSScriptRoot) {
                throw 'Temporary build alias exists with an unexpected target.'
            }
        } else {
            New-Item -ItemType Junction -Path $buildRoot -Target $PSScriptRoot | Out-Null
        }
        Set-Location -LiteralPath $buildRoot
    }
    $env:GRADLE_USER_HOME = Join-Path $buildRoot '.tools\gradle-home'
    $sdkPath = Join-Path $buildRoot '.tools\android-sdk'
    if (Test-Path -LiteralPath (Join-Path $sdkPath 'platforms\android-36\android.jar')) {
        $portablePath = $sdkPath.Replace('\', '/').Replace(':', '\:')
        Set-Content -LiteralPath 'local.properties' -Value ('sdk.dir=' + $portablePath) -Encoding ascii
    } elseif (-not (Test-Path -LiteralPath 'local.properties')) {
        throw 'Android SDK 36 is required. Configure sdk.dir in local.properties.'
    }
    $tasks = @(':app:assembleDebug')
    if (-not $SkipChecks) { $tasks += ':app:testDebugUnitTest', ':app:lintDebug' }
    & (Join-Path $buildRoot 'gradlew.bat') --project-dir $buildRoot --no-daemon @tasks --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE" }
} finally {
    $env:JAVA_HOME = $previousJava
    $env:GRADLE_USER_HOME = $previousGradle
    Pop-Location
}
