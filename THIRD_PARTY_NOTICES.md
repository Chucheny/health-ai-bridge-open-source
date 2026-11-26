# 第三方来源

## Health Connect Data Exporter

- 作者：Maksim Aitov
- 仓库：https://github.com/maksimaitov/health-connect-data-exporter
- 分支：master，核对日期 2026-11-05
- 许可证：MIT，全文见 licenses/health-connect-data-exporter-MIT.txt。
- RecordJson.kt 改编其 ExportWorker.kt 的显式元数据及字段序列化模式；新增血压、血糖、体温和速度等字段，改为 7 天窗口，由本应用记录读取状态。没有复制全历史请求、旧文件清理或 XML UI。

## Android Health Samples

- 仓库：https://github.com/android/health-samples/tree/main/health-connect/HealthConnectSample
- Android Open Source Project，Apache-2.0。
- 参考官方 Compose/Health Connect SDK 可用性、权限 contract 和按会话时间查询的 API 用法，未复制样例的随机记录、写入或删除实现。

## 其他评估，未引入

- https://github.com/Monkopedia/health-disconnect ：Apache-2.0，Compose 图表应用；范围大于本项目第一阶段。
- https://github.com/angeloanan/HealthConnectExports ：查询时未发现根目录明确的开源许可证，不作为复用来源。
- https://github.com/the-momentum/open_wearables_android_sdk ：查询时 GitHub license 字段为空，未完成授权确认，不作为复用来源。

Android、AndroidX、Kotlin、Gradle、Gson 等依赖分别依其上游许可证使用；构建工具缓存不作为应用源代码或发布包的组成部分。

Gradle Wrapper JAR 随源码提供，采用 Apache-2.0。许可证见 [Gradle 许可证](licenses/gradle-Apache-2.0.txt)。

## ChatGPT MCP 服务端依赖

- `@modelcontextprotocol/sdk` 1.32.2：Anthropic, PBC，MIT；全文见 `licenses/model-context-protocol-sdk-MIT.txt`。
- `jose` 6.2.15：Filip Skokan，MIT；全文见 `licenses/jose-MIT.txt`。
- 两者仅用于 MCP 协议与 OAuth JWT 校验，不调用 OpenAI 模型 API。
