#requires -Version 7.0
param([switch]$BuildOnly, [switch]$Wait)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw '此工作台需要 Windows；其他系统可使用原 Node 命令。' }
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'bridge-desktop/Workbench.cs'
$output = Join-Path $root '.tools/bridge-desktop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '未找到 Windows 自带的 .NET Framework 编译器；请使用原 Node 入口。不会自动安装组件。' }
$null = New-Item -ItemType Directory -Path $output -Force
$executable = Join-Path $output 'HealthBridgeWorkbench.exe'
if (-not (Test-Path -LiteralPath $executable) -or (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $executable).LastWriteTimeUtc) {
  & $compiler /nologo /target:winexe "/out:$executable" /reference:System.Windows.Forms.dll,System.Drawing.dll,System.Web.Extensions.dll,System.Core.dll $source
  if ($LASTEXITCODE -ne 0) { throw '本地工作台编译未完成。' }
}
if ($BuildOnly) { Write-Output 'BRIDGE_DESKTOP_BUILD_PASS'; return }
$nodeExecutable = (Get-Command node -CommandType Application -TotalCount 1).Source
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $executable; $info.UseShellExecute = $true
foreach ($argument in @($root,$nodeExecutable,(Join-Path $PSHOME 'pwsh.exe'))) {
  $info.ArgumentList.Add($argument)
}
$process = [Diagnostics.Process]::Start($info)
try { if ($Wait) { $process.WaitForExit(); if ($process.ExitCode -ne 0) { throw '工作台已停止，请保留本地任务并核对启动环境。' } } }
finally { if ($Wait -and -not $process.HasExited) { $process.Kill() }; $process.Dispose() }
