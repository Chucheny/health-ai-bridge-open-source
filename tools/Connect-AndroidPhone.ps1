$ErrorActionPreference = 'Stop'
$adb = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools\android-sdk\platform-tools\adb.exe'
$rows = @(& $adb devices)
if (@($rows | Where-Object { $_ -match '\sdevice$' }).Count -eq 1) { Write-Output 'PHONE_CONNECTED'; exit 0 }
$previousLegacy = $env:ADB_USB_LEGACY
$previousLibusb = $env:ADB_LIBUSB
try {
    # Honor's valid vendor WinUSB GUID needs the legacy libusb discovery path on this PC.
    # Only the ADB server process uses these flags; no permanent environment/driver changes.
    $env:ADB_USB_LEGACY = '1'; $env:ADB_LIBUSB = '1'
    & $adb kill-server *> $null
    & $adb start-server *> $null
    $rows = @(& $adb devices)
    if (@($rows | Where-Object { $_ -match '\sdevice$' }).Count -eq 1) { Write-Output 'PHONE_CONNECTED_COMPATIBILITY_MODE' }
    else { Write-Output 'PHONE_CONNECTION_NOT_READY'; exit 1 }
} finally { $env:ADB_USB_LEGACY = $previousLegacy; $env:ADB_LIBUSB = $previousLibusb }
