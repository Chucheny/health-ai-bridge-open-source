param([ValidateSet('prepare','upload','select')][string]$Action)
$ErrorActionPreference = 'Stop'
try {
  $root = Split-Path -Parent $PSScriptRoot
  $command = Join-Path $root 'backend/trainingcamp-sleep-command.mts'
  if (-not $Action) {
    Write-Host '1. 仅本地预检并准备任务（不联网）'
    Write-Host '2. 确认并上传已有任务（会发送睡眠数据）'
    Write-Host '3. 选择已有快照并生成手机说明（仅读取所选范围的快照目录）'
    $choice = Read-Host '输入编号，其他输入退出'
    $Action = switch ($choice) { '1' { 'prepare' }; '2' { 'upload' }; '3' { 'select' }; default { '' } }
  }
  switch ($Action) {
    'prepare' {
      $capturePath = Read-Host '本机睡眠采集文件完整路径'
      $rangeStart = Read-Host '独立确认的授权开始时间，含时区，例如 YYYY-MM-DDT00:00:00+08:00'
      $rangeEnd = Read-Host '授权结束时间（不包含），含时区'
      & node $command prepare $capturePath $rangeStart $rangeEnd
    }
    'upload' {
      $jobId = Read-Host '预检时生成的任务ID'
      $configPath = Read-Host '明确选用的 Bridge 独立采集设备配置文件路径（不要使用华为登录信息）'
      & node $command upload $jobId $configPath
    }
    'select' {
      $configPath = Read-Host 'Bridge 独立采集设备配置文件路径'
      $rangeStart = Read-Host '要查找快照的开始时间（含时区）'
      $rangeEnd = Read-Host '要查找快照的结束时间（不包含，含时区）'
      & node $command select $configPath $rangeStart $rangeEnd
    }
    default { return }
  }
  exit $LASTEXITCODE
} catch { Write-Output '{"error":"LOCAL_SLEEP_COMMAND_FAILED"}'; exit 1 }
