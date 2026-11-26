// Fixed local messages only. Never reflect a path, credential, source text, or remote response.
const catalog = {
  invalid_bridge_command: ['命令或参数不正确。', '请核对命令及参数数量；查看整体能力可运行 overview。'],
  invalid_bridge_client_config: ['Bridge 设备配置无效，或未允许所选数据类别。', '核对独立 Bridge 配置的 HTTPS 目标、账号/安装及允许类型；保留原任务，不通过更换账号或删除目标绑定绕过校验。'],
  invalid_bridge_import_job: ['输入或任务未通过校验。', '核对所选文件、睡眠/运动类别、含时区的日期范围及格式；最多31天。已有任务及原文件应保留，不自动修改。'],
  invalid_activity_capture_set: ['所选运动文件无法合成一个任务。', '核对 2 至 31 份首批采集文件来自同一账号，日期相接或重叠并在授权范围内。同一记录的版本与内容须一致。任务最多 100 条记录、31 天和 2 MiB 上传数据。'],
  invalid_bridge_import_receipt: ['回执或目标绑定缺失、损坏，或与任务不匹配。', '保留原任务及已有文件，先查看状态，不靠重新上传覆盖冲突。回执缺失不代表云端未保存；目标绑定一致且仅缺回执时，可核对后明确重试同一任务。缺失或损坏回执不能生成已确认的查询参数或手机说明。'],
  invalid_bridge_task_cursor: ['任务目录的分页游标无效。', '从任务列表第一页重新查看，不使用旧游标，也不自动选择任务。'],
  interactive_terminal_required: ['上传需要可交互的确认终端。', '从工作台打开上传确认终端，或在真实终端运行 upload；核对目标、账号和日期后输入完整确认语句。'],
  local_file_invalid: ['本地文件无法读取，或未通过格式及大小校验。', '核对明确选择的文件路径、可读权限、UTF-8 JSON 格式及大小限制；保留原文件和已有任务，不自动覆盖或上传。'],
  import_task_not_saved: ['本地任务尚未完成保存，本次未执行上传。', '保留原输入和未完成任务文件，核对目录权限及可用空间后重新创建。未完成目录使用 .preparing- 前缀，不可上传；不自动清理、覆盖或重试。'],
  upload_cancelled: ['本次上传已取消。', '本次没有发送上传请求；保留原任务，需要上传时重新核对并明确确认。'],
  upload_task_changed: ['任务内容已变更，或无法重新核对，本次未发送请求。', '保留原任务及文件，重新查看状态，核对类别、日期、批次和内容后再明确确认；不自动采用变更后的内容、覆盖文件或重试。'],
  upload_destination_changed: ['目标绑定不一致，或绑定文件无法读取或保存。', '本次未发送请求；保留原任务和绑定文件，核对原目标及账号/安装。不要删除绑定后改投其他账号。'],
  uploaded_receipt_not_saved: ['服务端已确认保存，但本地回执未能保存。', '保留原任务及已有文件，不重新 prepare；核对任务内容、目标绑定、文件权限及回执冲突，确认仍是原任务后，明确确认重试同一任务和目标。'],
  query_bundle_not_saved: ['查询参数无法保存，或与已有文件冲突。', '保留任务和已有参数文件，先核对本地权限及文件一致性；不自动覆盖、修复或调用 MCP。'],
  chatgpt_guide_not_saved: ['手机使用说明无法保存，或与已有文件冲突。', '保留任务及已有说明，核对本地权限和文件一致性；不自动覆盖、上传或发送。'],
  bridge_outcome_unknown: ['本次上传结果无法确认，服务端可能已经保存。', '保留同一任务、批次和目标，不重新 prepare；先查看本地状态，核对后明确确认重试同一任务。'],
  bridge_rejected_400: ['服务端未接受此上传请求（400）。', '保留原任务，核对数据格式、日期及服务端版本；不自动裁剪数据或重新生成批次。'],
  bridge_rejected_401: ['服务端未接受上传凭据（401）。', '核对配置是否仍有效；如需更新凭据，保持原目标及账号/安装绑定，不把令牌交给 ChatGPT，不自动重试。'],
  bridge_rejected_403: ['服务端未允许本次上传（403）。', '核对配置允许的数据类别、服务端权限和来源是否启用；此状态码不能确定具体原因，不自动改权限或开启来源。'],
  bridge_rejected_404: ['当前目标未提供所请求的上传接口（404）。', '保留原任务，核对目标及部署是否支持此来源；不自动更换目标、部署或开启来源。'],
  bridge_rejected_409: ['上传批次或数据版本存在冲突（409）。', '保留原任务、批次、目标及已有回执，核对冲突；不要新建批次或删除绑定来绕过冲突。'],
  bridge_rejected_413: ['服务端拒绝了请求大小（413）。', '保留原任务，核对目标的请求大小限制；不自动裁剪、拆分任务或重传。'],
  bridge_rejected_415: ['服务端未接受请求格式（415）。', '保留原任务，核对客户端与服务端协议版本；不自动转换原始健康文件或重试。'],
  bridge_rejected_429: ['服务端暂时限制了请求频率（429）。', '停止本次操作并保留原任务；稍后核对状态，需要重试时仍使用同一任务和目标，不自动循环请求。'],
  local_command_failed: ['本地操作未完成，结果无法确认。', '保留原任务与已有文件，先查看任务状态。若发生在上传过程中，服务端可能已保存，不重新 prepare，也不自动重试。'],
} as const;

export function bridgeCommandError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const safe = Object.hasOwn(catalog, code) ? code as keyof typeof catalog : 'local_command_failed';
  const [message, recovery] = catalog[safe];
  return { error: safe, automaticRetry: false as const, message, recovery };
}
