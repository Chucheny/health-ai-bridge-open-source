# Windows 工作台实现与验证

用户入口与边界见 [统一工作流](../../docs/BRIDGE_WORKFLOW.md)。`Workbench.cs` 是独立原生 WinForms 窗口；它只调用原 Node 应用层，不实现第二套导入/存储/网络协议。

`Bridge-Desktop.ps1` 使用系统现有 .NET Framework 编译器在 `.tools/bridge-desktop` 生成本机程序；不下载编译器、不安装依赖或修改系统设置。运行参数为启动脚本确定的工作区、node.exe 与 pwsh.exe 路径。所有子进程使用独立 argv，不构建 `-Command` 或可执行的用户字符串。

本地动作只允许 overview/preview/prepare/list/inspect/queries/chatgpt。上传按钮用工作台已选定的 Node 路径启动原 `Bridge-Upload.ps1` 确认终端，原 CLI 继续要求 TTY 和完整确认语句。单个工作台同时只打开一个确认终端。终端关闭后，若仍选中同一任务，先清除旧详情，再提示手动刷新回执。窗口只把配置路径交给终端。

“仅预检，不创建任务”调用同一任务校验，显示类别、日期、数量、预计上传字节数和覆盖限制，不保存任务、不使能上传或导出。窗口中的类别/文件/日期变化会清除正在显示的预览；摘要仍明确是上次读取结果，因为文件可能被外部修改。“创建本地任务（重新预检）”始终重新调用 prepare 读取并校验，不依赖已显示预览。旧任务及原一步 prepare 命令保持兼容。

选中运动类别后，可单选一个续读采集文件，或多选同一账号的首批采集文件。工作台把每个路径作为独立参数交给原 CLI，由任务层校验。多份首批文件由任务层去重。[运动多文件预检](../../docs/BRIDGE_WORKFLOW.md#运动多文件预检)

“生成手机使用说明”调用同一任务层，在成功回执状态生成中文说明，直接显示 CLI 返回的 `prompt`；“复制当前内容”复制当前显示的参数或说明。切换/刷新任务或再次生成时先清除旧导出，失败时不能复制上次内容。说明含日期及睡眠快照标识，保存在 ignored 的任务目录内；不含健康正文或凭据，不自动发送给客户端。

「查看 / 刷新状态」在任务已有匹配回执时显示北京时间提交时间和本批接收条数。运动同时显示实际新增或更新条数，睡眠显示快照 ID 及本批新建或复用。可用快照 ID 和会话数核对手机读回。

所有本地操作异常统一清除详情和导出，禁用上传、查询、说明生成及复制；保留明确任务编号，重新查看状态后才恢复可用操作。新预检开始时清除上个任务选择，目录刷新/翻页开始时清除旧页及游标，防止失败后继续使用上次结果。原任务文件不因此删除或修复。

任务详情和手机说明显示 Node 任务层提供的采集覆盖限制。运动首批最多 20 条，运动续读最多 5 页、100 条。运动数组、睡眠单次采集和旧任务各自显示输入格式对应的说明。文件预检和后端分页的核验范围是已取得的记录。

本地命令失败时，`LocalErrorMessage` 读取原CLI固定错误合同中的中文原因及恢复建议，不再另写一套翻译。只接受已知错误码、字符串消息/建议、有界长度和 `automaticRetry=false`；未知、超限或损坏输出使用固定通用提示，不显示原始 stderr。CLI消息来自 `backend/bridge-errors.mts` 的固定字典，不反射远端正文、内部异常或私人路径。

创建任务仅在完整文件保存并发布到正式UUID目录后返回成功。若提示 `import_task_not_saved`，表示本次没有上传；未完成文件可能保留在 `.preparing-` 目录，不出现在任务列表，也不能用于上传或生成说明。工作台显示原CLI的核对建议，清除旧可用操作，不自动删除文件或创建替代任务。原输入与旧UUID任务保持。

上传前的目标/回执核对由原任务层执行，不能只依赖工作台按钮禁用：确认终端在显示确认前和确认后、发送前均重新检查本地绑定及已有回执。检测到损坏、孤立或不匹配文件时不发送、不覆盖；仅回执缺失仍可明确重试原任务。具体错误仍由统一固定字典提示，工作台完成后手动刷新状态。

同一核对会重读任务并比较类别、请求哈希及输入格式。若等待确认时文件实质改变，`upload_task_changed` 表示本次没有发送；不会自动改用新文件内容。若已经收到服务端成功响应后才发现本地任务/目标改变，提示仍为服务端已确认但本地回执未保存，不能据此重新创建任务或改投账号。原文件不自动恢复，先核实原任务，再按原恢复流程处理。

`WorkbenchTests.cs` 是无界面的日期/Windows argv 往返、只读预检摘要及错误提示合同验证，不实例化窗口、读取个人健康数据或连接网络。预检检查只创建并清理本次合成文件，实际运行CLI并验证摘要格式函数不显示源记录ID或输入路径，损坏预检报告不能显示为成功；错误检查实际启动本地CLI尝试准备一个不存在的合成文件，验证中文建议进入工作台格式函数、私人路径不回显，以及损坏错误输出使用固定回退；不是完整GUI验收。可按下列方式复现（PowerShell 7，项目根目录）：

```powershell
./tools/Bridge-Desktop.ps1 -BuildOnly
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$application = (Resolve-Path tools/bridge-desktop/Workbench.cs).Path
$tests = (Resolve-Path tools/bridge-desktop/WorkbenchTests.cs).Path
$target = Join-Path $PWD '.tools/bridge-desktop/WorkbenchTests.exe'
& $compiler /nologo /utf8output /target:exe /main:WorkbenchTests "/out:$target" /reference:System.Windows.Forms.dll,System.Drawing.dll,System.Web.Extensions.dll,System.Core.dll $application $tests
if ($LASTEXITCODE -eq 0) { & $target }
```
