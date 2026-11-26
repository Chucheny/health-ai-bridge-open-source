# Health AI Bridge

Health AI Bridge 将个人健康记录同步到自己管理的 PostgreSQL，并通过只读 MCP 提供给 ChatGPT 等客户端。项目包含 Android 应用、REST/MCP 后端、浏览器采集助手和 Windows 导入工作台。

```text
华为运动健康 → Health Sync → Health Connect → Android Bridge ─┐
                                                           ├→ REST → PostgreSQL → 只读 MCP
华为训练营网页 → 本地采集文件 → 离线预检与确认 ──────────────┘
```

- Android 读取用户授权的 Health Connect 数据，支持本机查看和手动导出。配对后，可选择记录类型同步到私有后端，也可单独开启后台读取与定时同步。
- 华为训练营采集助手在已登录的浏览器页面读取运动和睡眠。运动续读最多 5 页、100 条，网页来源覆盖仍未知。睡眠导入后可按回执选定快照，逐页读取该快照的分期。
- 服务端区分数据来源。默认查询 Health Sync。MCP 工具只读，按 OAuth 身份、数据类型和日期范围控制访问。

本项目独立维护。浏览器采集使用训练营网页当前的接口，兼容性随网页实现变化。自托管步骤见 [后端部署](backend/SETUP.md)。

## 快速验证

安装 Node.js 24，在仓库根目录运行：

```shell
npm ci
npm run check
npm run bridge
```

后端测试使用合成数据和本地嵌入式 PostgreSQL，无需配置真实账号或生产数据库。下例预检合成运动，输出验证结果和数量：

```shell
npm run bridge -- preview activity examples/activity-preview.synthetic.json "2026-01-01T00:00:00Z" "2026-01-03T00:00:00Z"
```

在 Windows 和 PowerShell 7 中启动工作台：

```powershell
./tools/Bridge.ps1 -Action desktop
```

工作台可以预检文件、准备本地任务、核对上传回执和生成手机查询说明。上传要求在独立终端确认目标。详见 [导入流程](docs/BRIDGE_WORKFLOW.md) 和 [采集助手](tools/trainingcamp-browser/README.md)。

## Android 构建

安装 JDK 17 或 21，以及 Android SDK Platform 36。将 `JAVA_HOME` 指向 JDK，用本机 `local.properties` 的 `sdk.dir` 指定 SDK，或由 Android Studio 配置。

```shell
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Windows 使用 `./gradlew.bat`，或在 PowerShell 7 中运行 `./build.ps1`。中文路径环境可用该脚本建立临时路径别名。调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。真机需要可用的 Health Connect。华为数据可通过 Health Sync 进入 Health Connect。

## 数据与安全

请使用自己的云端实例、数据库和 OAuth 配置。账号、健康导出、配对凭据、签名文件和验收证据保存在私有位置。Android 的 GPS 路线经逐次授权读取，可随手动导出保存，云端同步会排除路线。后台同步时间由 Android 调度，云端回执记录提交确认时间。

[架构和数据边界](docs/ARCHITECTURE.md) · [贡献说明](CONTRIBUTING.md) · [安全问题报告](SECURITY.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

## 许可

项目源码采用 [MIT 许可证](LICENSE)。第三方组件和改编代码的声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
