$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

function Get-BridgePrivateDirectory {
    $projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    $privateDirectory = Join-Path $projectDirectory 'private\cloud'
    foreach ($candidate in @((Join-Path $projectDirectory 'private'), $privateDirectory)) {
        if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Private directory must not be a link.'
        }
    }
    [IO.Directory]::CreateDirectory($privateDirectory) | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    # icacls updates the directory's DACL without PowerShell Set-Acl's audit privilege request.
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $privateDirectory '/inheritance:r' '/grant:r' ('*' + $identity.Value + ':(OI)(CI)F') *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the private directory.' }
    $directoryAcl = Get-Acl -LiteralPath $privateDirectory
    $foreignAllow = @($directoryAcl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value
    })
    if ($foreignAllow.Count -ne 0) { throw 'Unexpected access to private directory.' }
    return $privateDirectory
}

function Save-BridgePrivateConfig([string]$Name, [string]$Json) {
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid config name.' }
    $directory = Get-BridgePrivateDirectory
    $destination = Join-Path $directory ($Name + '.dpapi')
    # A fixed temporary name could overwrite a pre-existing hard-link target and
    # lets concurrent saves consume each other's files. Create our own file atomically.
    $temporary = Join-Path $directory ('.' + $Name + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $createdTemporary = $false
    $plain = [Text.Encoding]::UTF8.GetBytes($Json)
    try {
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $plain, [Text.Encoding]::UTF8.GetBytes('Health AI Bridge cloud config v1'),
            [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $createdTemporary = $true
        try {
            $stream.Write($encrypted, 0, $encrypted.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $destination, $true)
    } finally {
        [Array]::Clear($plain, 0, $plain.Length)
        if ($createdTemporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Read-BridgePrivateConfig([string]$Name) {
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Invalid config name.' }
    $directory = Get-BridgePrivateDirectory
    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
        [IO.File]::ReadAllBytes((Join-Path $directory ($Name + '.dpapi'))),
        [Text.Encoding]::UTF8.GetBytes('Health AI Bridge cloud config v1'),
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { return [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
}
