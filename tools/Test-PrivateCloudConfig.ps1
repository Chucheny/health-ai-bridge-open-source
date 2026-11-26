#Requires -Version 7.0
<#
Windows / CurrentUser DPAPI regression checks using an isolated .tools fixture.
Copies the helper into the fixture; never reads or updates the project's real private configuration.
No Pester, network, external credentials or phone is required.
#>
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This test requires Windows CurrentUser DPAPI.' }

$projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$toolsDirectory = [IO.Path]::GetFullPath((Join-Path $projectDirectory '.tools'))
$fixtureLeaf = 'private-config-test-' + [Guid]::NewGuid().ToString('N')
$fixtureDirectory = [IO.Path]::GetFullPath((Join-Path $toolsDirectory $fixtureLeaf))
$expectedPrivateDirectory = [IO.Path]::GetFullPath((Join-Path $fixtureDirectory 'private\cloud'))
$workers = [Collections.Generic.List[object]]::new()
$ready = $null
$start = $null
$script:assertions = 0

function Assert-ConfigTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions++
}

function Assert-FixturePath {
    $resolved = [IO.Path]::GetFullPath($fixtureDirectory)
    $expected = [IO.Path]::GetFullPath((Join-Path $toolsDirectory $fixtureLeaf))
    if (-not $resolved.Equals($expected, [StringComparison]::OrdinalIgnoreCase) -or
        -not $resolved.StartsWith($toolsDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $resolved.Equals($toolsDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unexpected synthetic fixture path.'
    }
    if ((Test-Path -LiteralPath $toolsDirectory) -and
        ((Get-Item -LiteralPath $toolsDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Synthetic fixture parent must not be a link.'
    }
    if ((Test-Path -LiteralPath $resolved) -and
        ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Synthetic fixture must not be a link.'
    }
}

function Assert-PrivateFixtureDirectory {
    $actual = [IO.Path]::GetFullPath((Get-BridgePrivateDirectory))
    Assert-ConfigTest ($actual.Equals($expectedPrivateDirectory, [StringComparison]::OrdinalIgnoreCase)) `
        'Private helper did not resolve to the synthetic fixture.'
}

try {
    Assert-FixturePath
    [IO.Directory]::CreateDirectory((Join-Path $fixtureDirectory 'tools')) | Out-Null
    $helper = Join-Path $fixtureDirectory 'tools\PrivateCloudConfig.ps1'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1') -Destination $helper
    . $helper
    Assert-ConfigTest ((Get-Command Get-BridgePrivateDirectory).ScriptBlock.File.Equals(
        $helper, [StringComparison]::OrdinalIgnoreCase)) 'Fixture helper was not loaded.'
    Assert-PrivateFixtureDirectory

    # Normal replacement and a fresh helper load must preserve complete synthetic JSON.
    Save-BridgePrivateConfig 'synthetic' '{"fixture":true,"revision":1,"marker":"synthetic-first"}'
    $first = Read-BridgePrivateConfig 'synthetic'
    Assert-ConfigTest ($first.fixture -eq $true -and $first.revision -eq 1 -and $first.marker -eq 'synthetic-first') `
        'Initial synthetic configuration did not round-trip.'
    Save-BridgePrivateConfig 'synthetic' '{"fixture":true,"revision":2,"marker":"synthetic-second"}'
    . $helper
    Assert-PrivateFixtureDirectory
    $second = Read-BridgePrivateConfig 'synthetic'
    Assert-ConfigTest ($second.fixture -eq $true -and $second.revision -eq 2 -and $second.marker -eq 'synthetic-second') `
        'Replacement synthetic configuration did not survive reopening.'
    $ciphertext = [IO.File]::ReadAllBytes((Join-Path $expectedPrivateDirectory 'synthetic.dpapi'))
    Assert-ConfigTest (-not [Text.Encoding]::UTF8.GetString($ciphertext).Contains('synthetic-second')) `
        'Synthetic configuration was stored as plaintext.'

    # A pre-existing fixed .tmp hard link must never be opened or removed by Save.
    $sentinel = Join-Path $fixtureDirectory 'hardlink-sentinel.bin'
    $fixedTemporary = Join-Path $expectedPrivateDirectory 'synthetic.tmp'
    [IO.File]::WriteAllBytes($sentinel, [Text.Encoding]::UTF8.GetBytes('synthetic-hardlink-sentinel'))
    $beforeHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($sentinel)))
    New-Item -ItemType HardLink -Path $fixedTemporary -Target $sentinel | Out-Null
    Save-BridgePrivateConfig 'synthetic' '{"fixture":true,"revision":3,"marker":"synthetic-third"}'
    $afterHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($sentinel)))
    Assert-ConfigTest ($beforeHash -eq $afterHash) 'Saving altered the hard-link sentinel.'
    Assert-ConfigTest ([IO.File]::Exists($fixedTemporary)) 'Saving removed a pre-existing temporary file.'
    Assert-ConfigTest ((Read-BridgePrivateConfig 'synthetic').revision -eq 3) `
        'Saving with an unrelated fixed temporary file did not succeed.'

    # Start independent in-process PowerShell runspaces together, writing one name.
    $ready = [Threading.CountdownEvent]::new(4)
    $start = [Threading.ManualResetEventSlim]::new($false)
    $workerScript = {
        param([string]$Helper, [string]$ExpectedPrivate, [int]$Writer,
              [Threading.CountdownEvent]$Ready, [Threading.ManualResetEventSlim]$Start)
        $ErrorActionPreference = 'Stop'
        . $Helper
        $actual = [IO.Path]::GetFullPath((Get-BridgePrivateDirectory))
        if (-not $actual.Equals($ExpectedPrivate, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Worker resolved an unexpected private directory.'
        }
        $Ready.Signal() | Out-Null
        if (-not $Start.Wait(15000)) { throw 'Synthetic concurrency start timed out.' }
        $json = @{ fixture = $true; writer = $Writer; marker = ('synthetic-writer-' + $Writer) * 128 } |
            ConvertTo-Json -Compress
        Save-BridgePrivateConfig 'concurrent' $json
        'SYNTHETIC_WORKER_OK'
    }
    foreach ($writer in 1..4) {
        $pipeline = [Management.Automation.PowerShell]::Create()
        $pipeline.AddScript($workerScript.ToString()).AddArgument($helper).AddArgument($expectedPrivateDirectory).
            AddArgument($writer).AddArgument($ready).AddArgument($start) | Out-Null
        $worker = [pscustomobject]@{ Pipeline = $pipeline; Handle = $null; Ended = $false }
        $workers.Add($worker)
        $worker.Handle = $pipeline.BeginInvoke()
    }
    Assert-ConfigTest ($ready.Wait(20000)) 'Synthetic workers did not become ready.'
    $start.Set()
    foreach ($worker in $workers) {
        try { $output = @($worker.Pipeline.EndInvoke($worker.Handle)) }
        catch { throw 'Concurrent synthetic configuration save failed.' }
        finally { $worker.Ended = $true }
        Assert-ConfigTest (-not $worker.Pipeline.HadErrors -and $output.Count -eq 1 -and
            $output[0] -eq 'SYNTHETIC_WORKER_OK') 'A synthetic worker did not finish successfully.'
    }
    $concurrent = Read-BridgePrivateConfig 'concurrent'
    Assert-ConfigTest ($concurrent.fixture -eq $true -and $concurrent.writer -in 1..4) `
        'Concurrent saves did not leave one valid complete configuration.'
    Assert-ConfigTest ($concurrent.marker -eq (('synthetic-writer-' + $concurrent.writer) * 128)) `
        'Concurrent saves mixed or truncated synthetic JSON.'
    Assert-ConfigTest (@(Get-ChildItem -LiteralPath $expectedPrivateDirectory -Filter '.concurrent.*.tmp').Count -eq 0) `
        'Concurrent saves left an owned temporary file.'

    # Force final replacement to fail. Preserve both destination content and unrelated tmp.
    $blockedDestination = Join-Path $expectedPrivateDirectory 'blocked.dpapi'
    [IO.Directory]::CreateDirectory($blockedDestination) | Out-Null
    $blockedSentinel = Join-Path $blockedDestination 'sentinel.txt'
    [IO.File]::WriteAllText($blockedSentinel, 'synthetic-destination-sentinel')
    $unownedTemporary = Join-Path $expectedPrivateDirectory '.blocked.11111111111111111111111111111111.tmp'
    [IO.File]::WriteAllText($unownedTemporary, 'synthetic-unowned-temporary')
    $failed = $false
    try { Save-BridgePrivateConfig 'blocked' '{"fixture":true,"revision":1}' }
    catch { $failed = $true }
    Assert-ConfigTest $failed 'Replacing a directory unexpectedly succeeded.'
    Assert-ConfigTest ([IO.File]::ReadAllText($blockedSentinel) -eq 'synthetic-destination-sentinel') `
        'Failed replacement altered the existing destination.'
    Assert-ConfigTest ([IO.File]::ReadAllText($unownedTemporary) -eq 'synthetic-unowned-temporary') `
        'Failure cleanup altered an unrelated temporary file.'
    $remainingTemporary = @(Get-ChildItem -LiteralPath $expectedPrivateDirectory -Filter '.blocked.*.tmp')
    Assert-ConfigTest ($remainingTemporary.Count -eq 1 -and
        $remainingTemporary[0].FullName.Equals($unownedTemporary, [StringComparison]::OrdinalIgnoreCase)) `
        'Failed replacement did not clean only its own temporary file.'

    # All invalid path candidates resolve inside the disposable fixture even if validation regresses.
    foreach ($invalidName in @('', '..\escaped', 'child/config', 'invalid.name', (Join-Path $fixtureDirectory 'absolute'))) {
        $saveRejected = $false
        $readRejected = $false
        try { Save-BridgePrivateConfig $invalidName '{"fixture":true}' }
        catch { $saveRejected = $_.Exception.Message -eq 'Invalid config name.' }
        try { Read-BridgePrivateConfig $invalidName | Out-Null }
        catch { $readRejected = $_.Exception.Message -eq 'Invalid config name.' }
        Assert-ConfigTest ($saveRejected -and $readRejected) 'An invalid configuration name was accepted.'
    }

    Write-Output ('PRIVATE_CLOUD_CONFIG_TESTS_PASSED assertions=' + $script:assertions)
} finally {
    # End/dispose every runspace before deleting any fixture files, including failure paths.
    if ($null -ne $start) { $start.Set() }
    foreach ($worker in $workers) {
        try {
            if (-not $worker.Ended -and $null -ne $worker.Handle) {
                $worker.Pipeline.Stop()
                try { $worker.Pipeline.EndInvoke($worker.Handle) | Out-Null } catch { }
                $worker.Ended = $true
            }
        } finally { $worker.Pipeline.Dispose() }
    }
    if ($null -ne $ready) { $ready.Dispose() }
    if ($null -ne $start) { $start.Dispose() }
    Assert-FixturePath
    if (Test-Path -LiteralPath $fixtureDirectory) {
        Remove-Item -LiteralPath $fixtureDirectory -Recurse -Force
    }
}
