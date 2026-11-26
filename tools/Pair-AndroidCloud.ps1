param([Parameter(Mandatory)][uri]$BaseUrl)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
$root = Split-Path -Parent $PSScriptRoot
$previousAdmin = $env:HEALTH_ADMIN_DATABASE_URL
$previousCa = $env:HEALTH_DATABASE_CA
try {
    if (-not $BaseUrl.IsAbsoluteUri -or $BaseUrl.Scheme -ne 'https' -or $BaseUrl.UserInfo -or
        $BaseUrl.PathAndQuery -ne '/' -or $BaseUrl.Fragment) { throw 'Supply an HTTPS origin.' }
    $baseOrigin = $BaseUrl.GetLeftPart([UriPartial]::Authority)
    $adb = Join-Path $root '.tools\android-sdk\platform-tools\adb.exe'
    if (-not (Test-Path -LiteralPath $adb)) { $adb = (Get-Command adb -CommandType Application | Select-Object -First 1).Source }
    $deviceList = & $adb devices
    $devices = @($deviceList | Where-Object { $_ -match '^([A-Za-z0-9._:-]+)\s+device$' } | ForEach-Object { $Matches[1] })
    if ($devices.Count -ne 1) { Write-Output 'CONNECT_ONE_UNLOCKED_AUTHORIZED_PHONE'; exit 1 }
    $serial = $devices[0]
    $directory = Get-BridgePrivateDirectory
    if (Test-Path -LiteralPath (Join-Path $directory 'android-device.dpapi')) {
        $saved = Read-BridgePrivateConfig 'android-device'
        if ($saved.deviceSerial -ne $serial) { throw 'Different phone: requires separate pairing.' }
        $config = $saved.configuration
        if ($config.baseUrl -cne $baseOrigin) { throw 'Saved pairing belongs to a different origin.' }
    } else {
        $config = @{
            schemaVersion = 1; baseUrl = $baseOrigin
            ownerId = [Guid]::NewGuid().ToString(); sourceId = [Guid]::NewGuid().ToString()
            token = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_')
            allowedTypes = @('HeartRateRecord','SleepSessionRecord','ExerciseSessionRecord','DistanceRecord','SpeedRecord','ActiveCaloriesBurnedRecord','RestingHeartRateRecord','HeartRateVariabilityRmssdRecord','StepsRecord','OxygenSaturationRecord','RespiratoryRateRecord','WeightRecord','BloodPressureRecord','BloodGlucoseRecord','BodyTemperatureRecord')
        }
        Save-BridgePrivateConfig 'android-device' (@{ deviceSerial = $serial; configuration = $config } | ConvertTo-Json -Depth 5 -Compress)
    }
    $json = $config | ConvertTo-Json -Depth 5 -Compress
    $admin = Read-BridgePrivateConfig 'database-admin'
    $env:HEALTH_ADMIN_DATABASE_URL = 'postgresql://' + [Uri]::EscapeDataString($admin.username) + ':' + [Uri]::EscapeDataString($admin.password) + '@' + $admin.host + ':' + $admin.port + '/postgres'
    $admin.password = $null
    $env:HEALTH_DATABASE_CA = [IO.File]::ReadAllText((Join-Path $root '.tools\supabase-ca.crt'))
    $json | & node (Join-Path $root 'backend\register-device.mts') $baseOrigin
    if ($LASTEXITCODE -ne 0) { throw 'Registration not verified.' }
    $apk = Join-Path $root 'app\build\outputs\apk\debug\app-debug.apk'
    $installResult = & $adb -s $serial install -r $apk 2>&1
    if ($LASTEXITCODE -ne 0 -or -not ($installResult -match 'Success')) { throw 'Installation not verified.' }
    & $adb -s $serial shell am start -n 'dev.healthaibridge/.MainActivity' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'App launch failed.' }
    & $adb -s $serial exec-out run-as dev.healthaibridge mkdir -p files *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Private app directory unavailable.' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $adb
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-s',$serial,'exec-in','run-as','dev.healthaibridge','tee','files/cloud-pairing.json')) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Private transfer failed.' }
    $discardOutput = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $discardError = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $process.StandardInput.Write($json); $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw 'Private transfer timed out.' }
    $null = $discardOutput.GetAwaiter().GetResult(); $null = $discardError.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'Private transfer failed.' }
    & $adb -s $serial exec-out run-as dev.healthaibridge chmod 600 files/cloud-pairing.json *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Private transfer permissions not verified.' }
    Write-Output 'PHONE_APP_UPDATED_AND_PAIRING_READY_NO_HEALTH_UPLOADED'
} catch { Write-Output 'PHONE_PAIRING_NOT_COMPLETE'; exit 1 }
finally { $env:HEALTH_ADMIN_DATABASE_URL = $previousAdmin; $env:HEALTH_DATABASE_CA = $previousCa }
