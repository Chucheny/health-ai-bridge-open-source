#requires -Version 7.0
param(
  [Parameter(Mandatory)][guid]$TaskId,
  [Parameter(Mandatory)][string]$ConfigPath,
  [string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
$result = 1
try {
  if (-not $PSBoundParameters.ContainsKey('NodeExecutable')) {
    $NodeExecutable = (Get-Command node -CommandType Application -TotalCount 1).Source
  }
  if (-not [IO.Path]::IsPathFullyQualified($NodeExecutable) -or
      -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw '未找到工作台指定的 Node.js。'
  }
  $command = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend/bridge-command.mts'
  & $NodeExecutable $command upload $TaskId.ToString() $ConfigPath
  $result = $LASTEXITCODE
} catch { Write-Output '{"error":"BRIDGE_UPLOAD_TERMINAL_FAILED"}' }
Write-Host '回到工作台后，点击“查看 / 刷新状态”核对本地回执。'
$null = Read-Host '按回车关闭此终端'
exit $result
