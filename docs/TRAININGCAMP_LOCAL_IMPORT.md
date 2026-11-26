# 本地睡眠导入与快照选择

这是原 Health AI Bridge 的本地入口，不是新服务。使用已保存的 Training Camp 睡眠采集文件，先离线检查，再由用户单独确认上传；也能查找已导入快照，生成原 MCP 的查询参数。采集助手仍只保存本机文件，没有新增权限或自动上传行为。

当前已完成本地代码及合成往返测试，未部署、未启用生产网页来源、未上传个人健康文件。本工具不会自动准备云端数据库、签发凭据、修改开关或读取手机配置。既有“原七天只留本机”的授权不会被本工具改成上传授权。

## 运行入口

需要 Node.js 24 及以上，并安装项目原有依赖。从项目目录的 PowerShell 运行：

```powershell
./tools/TrainingCamp-Sleep.ps1
```

菜单提供三项独立动作：仅本地准备、确认并上传、列出并选择快照。没有默认日期、默认账号、默认上传目标或默认选中的快照。若电脑策略不允许运行 PowerShell 脚本，不修改全局策略，直接使用下面的 Node 命令。

### 1. 仅离线准备

```powershell
node ./backend/trainingcamp-sleep-command.mts prepare "<采集文件完整路径>" "<授权开始ISO时间>" "<授权结束ISO时间>"
```

时间必须带时区，开始包含、结束不包含。授权范围需要独立选择，不把文件自报的 requestedWindow 当成授权；单次采集范围最多31天。预检检查来源类型、日期与会话/分期边界、原始整数精度和最终请求体不超过2 MiB。

通过后输出任务 ID、批次 ID、日期范围、分类记录数和请求字节数，不输出原始会话/分期值。保存 `private/trainingcamp-imports/<任务ID>/job.json`；这个文件包含睡眠数据，是待发送请求本身，不应分享。原采集文件保持不变。此动作不读取设备配置或浏览器登录态，不联网。

每个任务预先固定 batchId 与请求体并保存内容哈希，之后手动重试使用同一个任务；重新执行 prepare 会创建新批次，不应用它代替一次结果不明的上传重试。相同内容的不同批次虽能复用服务端快照，仍应保留原任务用于核对回执。

### 2. 明确确认后上传

上传前先按 [自托管后端](../backend/SETUP.md) 配置迁移、受限运行权限和独立功能开关。

使用管理员原 `backend/provision.mts` 流程在同一 owner 下另行签发的独立网页采集设备配置，类型至少含 `SleepSessionRecord`，作用域需要 sync/read。沿用原配置结构：schemaVersion、HTTPS baseUrl、ownerId、sourceId、token、allowedTypes。不要复制华为网页登录令牌，不要默认复用手机凭据。工具不会自动搜索或解密现有私人配置。

```powershell
node ./backend/trainingcamp-sleep-command.mts upload "<任务ID>" "<独立Bridge设备config.json路径>"
```

必须在交互终端运行；非交互输入会在读取配置/发请求之前拒绝。程序展示标准化后的 HTTPS 目标、配置声明的 owner/source、请求日期、分类条数、字节数及批次 ID，不显示 token。只有输入屏幕要求的完整“上传 https://目标域名”确认语句才发送一次请求，其他输入取消。配置中的 owner/source 是用户所选配置的声明；真实账号归属仍由后端凭据鉴权决定，不能将显示文本当成服务端已确认的身份。

第一次明确确认后，将目标 origin、owner/source（不含 token）写入任务的 `destination.json`。同一任务再次上传不能改变这些目标信息，凭据轮换但 owner/source 不变可继续使用；换账号或服务器应另行建立任务并明确授权。

网络请求仅发往所选 HTTPS Bridge 的 `/api/health/trainingcamp/sleep/import`，禁止重定向，30秒超时，不自动重试，不使用浏览器 Cookie。后端错误、响应过大或响应结构异常均只显示固定错误，不打印远端原文或凭据。

收到并验证匹配批次/条数的成功回执后，保存同目录的 `receipt.json` 并输出 snapshotId。若网络错误、超时或回执无法确认，`bridge_outcome_unknown` **不表示服务端未写入**：保留任务，核对情况后手动重试同一任务；服务端原子回执保证已提交批次不会重复插入。若报 `uploaded_receipt_not_saved`，上传已获成功回执，但本机保存失败，也应保留原任务处理。

错误输出保留固定 `error` 和 `automaticRetry: false`，并为取消、目标绑定失败、结果未知和回执保存失败提供固定中文 `recovery` 提示。已有回执不可读、损坏、超限或与本次回执不一致时，均报告 `uploaded_receipt_not_saved`，不会把已确认的上传降为通用失败，也不会覆盖已有文件。目标绑定无法保存/读取或不一致时，均在发送请求前停止；不要通过删除绑定文件让旧任务改投其他账号。修复本地文件问题前保留原任务和已有文件，不重新 prepare、不自动重试。目录读取的结果未知提示则只要求核对配置/日期，不把它描述成上传结果。

### 3. 列出并明确选择快照

```powershell
node ./backend/trainingcamp-sleep-command.mts select "<独立Bridge设备config.json路径>" "<查找开始ISO时间>" "<查找结束ISO时间>"
```

此命令是有网络请求的只读操作，需交互终端与 SleepSessionRecord 读取权限。列出同一账号在所选最多31天范围内的快照，每页最多20条，只包含完整落在查询范围内的快照请求窗；部分相交的快照不会出现。没有结果不能证明没有睡眠，应核对日期范围、权限和是否曾经导入。

列表按 UUID 排序，**不是更新时间排序**；采集时间只是文件声明的观察时间，导入时间也不是源修改时间。显示 snapshotId、安装 source、请求范围、采集声明/导入时间和会话数；不读取会话/分期明细。按本页编号选定，输入 n 才读取下一页，其他输入退出。不会自动挑最新快照，不合并不同快照。

选定后保存 `private/trainingcamp-choices/<选择ID>/selection.json`，输出 `selection_saved` 与选择 ID。终端显示可复制到手机 ChatGPT 的中文说明，含两项 MCP 工具的参数。两项工具使用同一快照及其自身日期范围，`health_records` 默认带 `sleepStages=paged`。说明生成只使用选定的目录项，联网范围为目录读取，查询由用户在客户端发起。手机端仍受 MCP 账号、类型与服务端日期授权限制。[分页规则](ARCHITECTURE.md#查询边界)

## 文件与当前限制

- 所有任务、目标绑定、回执和快照选择都在 Git 忽略的 private 内；不保存设备 token，不移动或覆盖原采集文件。Windows 新任务/选择目录按当前用户设置访问权限，POSIX 使用私有目录/文件模式。
- 尚无图形化文件选择或与浏览器弹窗的一键衔接；这是可运行的本地菜单/命令入口。原 Node 命令已通过真实 TTY 合成演练；用户手动操作 PowerShell 菜单及真实云端往返尚未验收。
- 本工具不进行同步调度、自动刷新网页登录、自动补取或自动扩大日期范围；没有新增付费服务、AI API 或依赖包。
- 数据库迁移、专用运行角色和部署校验见 [自托管后端](../backend/SETUP.md)。

## 可重复的终端合成演练

安装原项目开发依赖后，在交互终端运行：

```powershell
node ./backend/test/support/trainingcamp-terminal-drill.mts
```

演练只生成自己的合成配置、采集文件和 UUID 任务，逐步显示需要输入的确认语句。原 CLI 在独立子进程中使用真实 stdin/stdout TTY 和 readline，未绕过非交互拒绝；测试专用 preload 将全部 fetch 经 IPC 交给原 REST 处理器与内存 PGlite，禁止回退到真实网络，没有监听服务。它不寻找私人配置、不读取个人采集文件、不联系华为或真实 Bridge。

覆盖取消前零请求、云端已提交后丢回执、原任务重试不重复写入、回执路径不可读时保留“服务端已确认”状态、已有回执重放保持原文件、改安装被目标绑定拦截，以及明确选择快照后仅保存同一快照的原 MCP 参数。检查失败退出非零；全部成功显示 `SYNTHETIC_TERMINAL_DRILL_PASS`。正常结束及断言失败会关闭内存数据库并逐项清理本次创建的文件/目录，不递归删除 private。

2026-11-14 已在 Windows 真实 PTY 中由 Codex 逐步输入并通过。此证据覆盖 Node CLI 的交互和持久化，不是用户人工操作验收；未覆盖 PowerShell 菜单的人工输入、真实 HTTPS 网络、生产凭据或生产数据库。
