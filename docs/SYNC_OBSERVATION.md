# 云端提交回执诊断

本地操作员可用此工具核对同步回执和当前检查点。入口在 Windows 的 PowerShell 7。

## 运行

已有本机 DPAPI 配置时：

```powershell
./tools/Inspect-SyncObservation.ps1
./tools/Inspect-SyncObservation.ps1 -StartDate 2026-01-01 -EndDate 2026-01-08
```

默认取北京时间今天及前六天；起日含、止日不含，每次最多31天。默认只输出JSON，不自动写报告。实际验收如需保存，重定向到 ignored 的 `private/verification/`，不要将提交时间线放入公共文档或Git。退出码0表示元数据检查完成；2表示4000条回执上限导致范围未读完，或已有检查点的回执证据不完整；1表示输入、配置、连接、权限或执行失败。

沿用 `PrivateCloudConfig.ps1`、已有 `database-runtime` 与 `android-device` 的加密配置，严格验证TLS/CA。只把原配对的owner/source、已有授权类型和日期交给操作员进程，设备token不会进入SQL参数或输出。账号密码仅在当前进程环境中使用，退出时恢复原环境。不创建角色、不修改云端数据、不连接手机。

## 输出语义

- 在 `REPEATABLE READ, READ ONLY` 事务中，只查原安装的 `sync_batches` 提交回执与 `sync_streams` 当前检查点。5秒SQL、2秒锁等待上限；不读取健康记录、采样、分期、设备token表或手机状态。
- 日统计固定UTC+08:00；边界是`[start,end)`。提交回执由服务端Date生成、精度为毫秒；比毫秒更细的操作员输入或返回时间会明确拒绝，不通过PostgreSQL时间精度静默四舍五入。此约束不改变健康查询的纳秒支持。
- `operationCount`为提交操作数（含更新、删除），不代表新增健康记录数；以精确十进制字符串求和。`emptyReceiptCount`为空操作批次的确认数，这些批次可能用于确认Changes checkpoint，不能直接跳过。
- `confirmationGroups`仅按相邻回执间隔不超过五分钟聚类。它们不具有手机运行ID，不能当作一次完整同步，不能从批次数猜测已选类型全部完成。当前回执也不含历史record_type，不能可靠追溯每批属于哪个类型。
- 最多读4001条，以识别4000条输出上限。超限时 `complete=false`、`status=receipt_limit_reached`、`resultScope=earliest_receipts_only`，禁止将首段描述为整段统计。可按更短日期分别检查；这不是健康记录分页接口。
- 当前检查点独立于查询日期窗，可能晚于查询范围。按sequence与确认时间核对当前receipt；唯一已提交匹配为matched，无匹配为missing，非唯一为ambiguous，唯一但未提交为unconfirmed。由于回执不含类型，同序号同时间多匹配不能擅自断定损坏。
- `typesWithoutCheckpoint`只说明这些已配置授权类型没有云端流，可能未选上传或未开始；不等于失败。现有15流对得上回执也不证明手机本轮上传选择、完整成功状态或来源新鲜度。

没有回执只能说明该云端窗口没有收到可见提交，不能证明没有活动、没有新数据或系统没调度。回执时间是服务端提交时间，不能代替测量或Health Sync同步时间。即使呈现约六小时间隔，`backgroundPeriodicAcceptance`仍为`not_verifiable_from_cloud_receipts`，必须结合手机WorkManager、后台尝试/确认时间及前后台状态验收自然周期、隔夜和重启可靠性。

## 验证与下一步

后端回归覆盖owner/安装/类型隔离、北京时间跨日及右端排除、精确大整数、等时批次不去重、聚类边界、检查点与历史窗分离、非唯一回执不误判、空数据、无效元数据、范围上限、实际PostgreSQL只读写入拒绝，以及CLI对中文路径/错误的处理。测试只用合成数据。

验收自然后台周期时，按同一时间窗对比现有任务状态、后台尝试及完整确认时间和云端回执。
