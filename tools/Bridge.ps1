param([ValidateSet('overview','preview','prepare','upload','inspect','queries','chatgpt','select-snapshot','desktop')][string]$Action)
$ErrorActionPreference = 'Stop'
try {
  $command = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend/bridge-command.mts'
  if (-not $Action) {
    Write-Host 'Health AI Bridge 统一入口'
    Write-Host '1. 查看整体框架与来源能力（不联网）'
    Write-Host '2. 从已提供文件准备睡眠/运动任务（不联网）'
    Write-Host '3. 查看任务与回执状态（不联网）'
    Write-Host '4. 核对并上传任务（明确确认后发送）'
    Write-Host '5. 明确选择已有任务回执，保存 MCP 查询参数（不联网、不调用MCP）'
    Write-Host '6. 从云端睡眠目录选择快照并生成手机说明（读取目录）'
    Write-Host '7. 打开本地工作台（文件选择 / 任务与查询参数）'
    Write-Host '8. 生成手机 ChatGPT 中文使用说明（不联网、不发送）'
    Write-Host '9. 仅预检已提供文件（不联网、不创建任务）'
    $choice = Read-Host '输入编号，其他输入退出'
    $Action = switch ($choice) { '1' { 'overview' }; '2' { 'prepare' }; '3' { 'inspect' }; '4' { 'upload' }; '5' { 'queries' }; '6' { 'select-snapshot' }; '7' { 'desktop' }; '8' { 'chatgpt' }; '9' { 'preview' }; default { '' } }
  }
  switch ($Action) {
    'desktop' { & (Join-Path $PSScriptRoot 'Bridge-Desktop.ps1'); return }
    'overview' { & node $command overview }
    { $_ -eq 'prepare' -or $_ -eq 'preview' } {
      $kind = Read-Host '输入 sleep（睡眠采集文件）或 activity（运动采集文件/记录数组）'
      $sourcePath = Read-Host '已提供文件的完整路径'
      $rangeStart = Read-Host '独立确认的授权开始ISO时间（含时区）'
      $rangeEnd = Read-Host '授权结束ISO时间（不包含，含时区）'
      & node $command $Action $kind $sourcePath $rangeStart $rangeEnd
    }
    'upload' {
      $taskId = Read-Host '统一入口生成的任务ID'
      $configPath = Read-Host '明确选用的独立 Bridge 设备配置路径（非华为登录信息）'
      & node $command upload $taskId $configPath
    }
    'inspect' { $taskId = Read-Host '任务ID'; & node $command inspect $taskId }
    'queries' { $taskId = Read-Host '明确选择的任务ID（需已保存成功回执）'; & node $command queries $taskId }
    'chatgpt' {
      $taskId = Read-Host '明确选择的任务ID（需已保存成功回执）'
      $result = & node $command chatgpt $taskId
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      Write-Host '以下说明已保存在任务目录的 chatgpt.json；含所选日期和睡眠快照标识，不含健康正文或凭据。可自行复制到已连接原插件的手机 ChatGPT：'
      Write-Output (($result -join "`n" | ConvertFrom-Json).prompt)
    }
    'select-snapshot' { & (Join-Path $PSScriptRoot 'TrainingCamp-Sleep.ps1') -Action select }
    default { return }
  }
  exit $LASTEXITCODE
} catch { Write-Output '{"error":"BRIDGE_COMMAND_FAILED"}'; exit 1 }
