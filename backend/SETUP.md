# Health AI Bridge 自托管部署

本指南从本地验证开始，使用你自己的 Supabase PostgreSQL、Netlify 项目和 OAuth 提供方。只使用手机数据时，完成第 1 至 4 节即可。ChatGPT 和训练营网页导入可以分别启用。

## 1. 本地准备

安装 Git、Node.js 24。构建 Android 另需 JDK 17 或 21、Android SDK Platform 36 和 Build Tools 36。Windows 图形工作台和配对工具使用 PowerShell 7。

```sh
git clone https://github.com/Chucheny/health-ai-bridge-open-source.git
cd health-ai-bridge-open-source
npm ci
npm run check
npm run bridge:check
```

这两组验证使用本地合成数据，可在配置数据库之前执行。所有服务地址、数据库角色密码和 OAuth 配置使用你自己的值。示例域名 `bridge.example.com` 仅用于说明。

## 2. PostgreSQL 初始化

1. 创建专用 Supabase 项目。取该项目的事务连接池地址和 CA 证书。在 SQL Editor 以迁移管理员运行 [001_health_bridge.sql](migrations/001_health_bridge.sql)。首次应得到 `health_bridge` schema 下的 7 张表。保留 RLS，确保 Supabase Data API 的暴露 schema 不包含 `health_bridge`。 [Supabase PostgreSQL 连接说明](https://supabase.com/docs/guides/database/connecting-to-postgres)
2. 生成 32 字节随机密码，以无填充 base64url 编码，共 43 字符。用本地密码管理器保存。以私密方式向本地 shell 提供 `HEALTH_ADMIN_DATABASE_URL`、`HEALTH_RUNTIME_DATABASE_URL` 和包含 PEM 正文的 `HEALTH_DATABASE_CA`。事务池管理员用户名形如 `postgres.<project-ref>`，运行角色用户名为 `health_bridge_runtime.<project-ref>`。两个 URL 用同一连接池主机、端口和 `/postgres`，分别使用各自的密码。对 URL 中的密码做百分号编码，CA 单独传入环境变量。
3. 在已配置上一步变量的 shell 运行以下命令创建并验证受限角色。脚本应输出 `runtimeTls: true`、`leastPrivilege: true`、`rlsTables: 7`。数据库权限由 [运行角色实现](runtime-role.mts) 管理。

```sh
node backend/hosted-bootstrap.mts
```

Windows 也可将 CA 文件放在 `.tools/supabase-ca.crt`，按以下步骤用当前 Windows 用户的 DPAPI 保存本机配置。两个示例变量需先设成自己的项目引用和事务池主机。若通过脚本生成运行角色密码，配置 Netlify 时应使用同一密码，运行角色的记录存于本机加密的 `database-runtime` 配置。操作员可在本机私密会话加载 `tools/PrivateCloudConfig.ps1`，调用 `Read-BridgePrivateConfig 'database-runtime'` 将结果赋给变量，避免将配置对象输出到终端。

```powershell
./tools/Configure-CloudDatabase.ps1 -ProjectRef $projectRef -DatabaseHost $poolerHost
./tools/Initialize-CloudRuntime.ps1 -ProjectRef $projectRef
./tools/Test-CloudDatabase.ps1
```

其他 PostgreSQL 服务可使用同样的 SQL 迁移，并按 [运行角色实现](runtime-role.mts) 配置等效权限。上面的初始化工具按 Supabase 事务池用户名约定验证目标。管理员连接只用于本机迁移、签发配置和维护。

## 3. Netlify 发布并验证 REST

在 Netlify 中新建专用项目。可以连接自己的 GitHub fork，也可在本地安装官方 Netlify CLI，使用 `netlify login` 和 `netlify link` 选择目标。仓库自带 [netlify.toml](../netlify.toml)，从仓库根目录构建，静态发布目录为 `web`，函数入口为 `netlify/functions`。构建 Node 版本由 `.nvmrc` 固定为 24，如需在站点显式指定函数运行时，在 Netlify UI 设置 `AWS_LAMBDA_JS_RUNTIME=nodejs24.x`。 [Netlify 函数配置](https://docs.netlify.com/build/functions/configuration/?fn-language=js)

在 Netlify 项目环境变量页面配置。将生产值限于 Production，套餐支持时选 Functions 范围，连接和 OAuth 值标为 Secret。部署预览及分支部署使用独立的合成环境，函数还会检查发布上下文。

| 环境变量 | 首次部署 |
| --- | --- |
| `HEALTH_DATABASE_URL` | 受限运行角色的 PostgreSQL URL |
| `HEALTH_DATABASE_CA` | 数据库服务要求时填写受信任的 CA PEM 正文 |
| `HEALTH_API_ENABLED` | `false`，核对初始化后改为 `true` |
| `HEALTH_MCP_ENABLED` | `false`，OAuth 准备完成后才启用 |
| `HEALTH_MCP_CONFIG` | MCP 未启用时留空 |
| `HEALTH_TRAININGCAMP_ENABLED` | `false`，可选迁移和权限验证完成后才启用 |

以 CLI 手工发布时，先在本地跑 `npm run check`，再创建草稿。确认项目和内容后才发布到正式 URL。Git 部署可在项目配置中选择正式分支并查看相同的构建产物。每次更改函数环境变量后重新部署。 [Netlify 函数环境变量](https://docs.netlify.com/build/functions/environment-variables/)

```sh
netlify deploy
netlify deploy --prod
```

初次生产发布后检查首页和 REST 关闭状态，再开启 `HEALTH_API_ENABLED=true` 并重新部署。将下方 URL 换成自己的地址。

```sh
curl -i https://bridge.example.com/
curl -i https://bridge.example.com/api/health/status
curl -i -X POST https://bridge.example.com/api/health/sync/receipt
```

首页应返回 `200`。查询和回执端点关闭时返回 `503`，启用后拒绝匿名请求，返回 `401`。受团队登录保护的草稿可能先由 Netlify 拒绝访问。应用路由验证以已发布的目标为准。

在你控制的独立验收实例，用 Windows 脚本做 HTTPS 合成往返。`-Https` 要和 `-BaseUrl` 一起传。脚本创建两个临时测试账号，验证鉴权、批次重放、去重和账号隔离，最后清理测试数据。检查输出中的 `syntheticCleanup`，并保留失败时留在 `private/cloud/` 的本机恢复记录。

```powershell
./tools/Test-CloudApi.ps1 -Https -BaseUrl https://bridge.example.com
```

## 4. 构建和配对 Android

在 Android Studio 配置 SDK，或在 `local.properties` 设置 `sdk.dir`。用 `adb devices` 核对只连接一台已授权设备。Windows 使用 `.\gradlew.bat`，或用 PowerShell 7 的 `./build.ps1` 构建调试版。

```sh
./gradlew :app:testDebugUnitTest :app:lintRelease :app:assembleDebug :app:assembleRelease
```

已有第 2 节 Windows 私密配置时，用下列命令首次安装并准备配对。它使用预先构建的调试 APK，经 ADB 将配置直接写入应用私有目录。用手机打开「私人云端同步」，点击「接收电脑配对配置」，核对自己的服务域名。App 验证服务端凭据并加密保存后清理临时配对文件。

```powershell
./tools/Pair-AndroidCloud.ps1 -BaseUrl https://bridge.example.com
```

需要个人长期使用时，可以用自己的密钥签署 Release。现有配对随同包名、同证书覆盖安装保留。采用调试包进行首次配对时，随后使用与该调试包相同的证书签署 Release，避免换签卸载造成的本机配置丢失。已经使用不同证书的安装应独立安排迁移。不要公开签名私钥。以下 Linux/macOS 示例将密钥路径和别名由当前 shell 提供，Windows 可调用 SDK 对应的 `.exe` 和 `.bat`。 [Android 应用签名](https://developer.android.com/studio/publish/app-signing)

```sh
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -f 4 \
  app/build/outputs/apk/release/app-release-unsigned.apk app-release-aligned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" sign --ks "$BRIDGE_KEYSTORE" --ks-key-alias "$BRIDGE_KEY_ALIAS" \
  --out app-release-signed.apk app-release-aligned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs app-release-signed.apk
adb install -r app-release-signed.apk
```

在手机给 Bridge 自己授予 Health Connect 读取权限，选择上传类型。先保持同步页在前台完成一次手动同步，核对完整确认。需要自动同步时，单独授予后台读取权限并开启开关。让手机退回桌面后观察自然周期，核对手机「后台完整确认」和云端提交回执。面板上的最早重试时间是可运行下限，由 Android 决定实际运行时间。

## 5. 配置只读 MCP

1. 在自己的 OAuth 提供方创建资源服务器，标识为部署后的 HTTPS `/mcp` 全地址。创建独立客户端和允许的登录账号。授权码流程使用 S256 PKCE，回调地址使用 ChatGPT 创建配置时显示的精确值。客户端密钥只填在需要它的客户端配置内。 [ChatGPT 插件认证](https://developers.openai.com/plugins/build/auth)
2. 让访问令牌使用 RS256 或 ES256，生命周期不超过 3600 秒。检查 `aud` 为 MCP 资源，`iss`、`sub`、`client_id` 与配置一致，`scope` 含 `health:read`。使用 Auth0 时，可选择 RFC 9068 访问令牌格式并开启资源参数兼容配置，将 `health:read` 授予该客户端。 [Auth0 resource 配置](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)
3. 在 Netlify Production 设置 `HEALTH_MCP_CONFIG`。下面是字段示例，`ownerId` 要填写实际配对配置对应的 Bridge 账号 UUID。`readWindow` 如需设置，使用含时区的 ISO 8601 起止时间。`jwksUrl` 必须与 `issuer` 同源。

```json
{
  "resource": "https://bridge.example.com/mcp",
  "issuer": "https://identity.example.com/",
  "jwksUrl": "https://identity.example.com/.well-known/jwks.json",
  "subject": "example-account-subject",
  "clientId": "example-oauth-client",
  "ownerId": "00000000-0000-4000-8000-000000000001",
  "types": ["StepsRecord", "SleepSessionRecord"],
  "readWindow": {
    "start": "2026-01-01T00:00:00+08:00",
    "end": "2026-02-01T00:00:00+08:00"
  }
}
```

4. 单独开启 `HEALTH_MCP_ENABLED=true` 并重新部署。先验证公开发现和匿名拒绝，再在 ChatGPT 支持自定义插件的界面添加你的 HTTPS `/mcp`，完成授权后用合成或明确允许的数据验证 `health_summary`、`health_records` 及分页。重新打开一个新聊天确认实际注册的工具。客户端可用性取决于账号或工作区。

```sh
node backend/mcp-provider-diagnostic.mts --issuer https://identity.example.com/
curl -i https://bridge.example.com/.well-known/oauth-protected-resource/mcp
curl -i https://bridge.example.com/mcp
```

启用后，发现端点应返回 `200`，未授权的 MCP 访问应返回 `401`。如果提供方未在公开的 `scopes_supported` 声明自定义 scope，发现诊断可能报告不完整。实际访问令牌和授权请求仍需确认。紧急停止 MCP 时关闭其独立开关并重新部署。

## 6. 可选的训练营网页来源

先在隔离环境验证迁移。使用 Supabase 事务池和既有受限角色配置时，在 001 上按顺序应用 [002 运动](migrations/002_trainingcamp_activities.sql)、[003 睡眠](migrations/003_trainingcamp_sleep.sql)，并重新验证权限。Windows 可用 `./tools/Initialize-CloudRuntime.ps1 -ProjectRef $projectRef -ApplyTrainingCampMigrations`，或在本机已提供第 2 节变量时运行：

```sh
node backend/hosted-bootstrap.mts --apply-trainingcamp-migrations
```

迁移完成应报告 `rlsTables: 10`。以管理员本机使用下面的命令为导入工作台签发独立、按类型受限的配置。最后的 UUID 是你已经核对过的现有 Bridge 账号，用于让归档归同一账号。文件写入 `private/device-*/config.json`，配置由工作台在上传前读取。

```sh
node backend/provision.mts https://bridge.example.com "SleepSessionRecord,ExerciseSessionRecord" "$BRIDGE_OWNER_ID"
```

开启 `HEALTH_TRAININGCAMP_ENABLED=true` 并重新部署。Chrome 加载 `tools/trainingcamp-browser`，在已登录的网页内采集指定类别和日期。先用 `npm run bridge:check` 核对合成流程，再用 `./tools/Bridge.ps1 -Action desktop` 执行采集文件预检、核对目标、确认上传和回执。已导入的睡眠通过快照 ID 查询。读取分期时用 `sleepStages=paged` 连续分页至 `nextCursor=null`。 [浏览器采集助手](../tools/trainingcamp-browser/README.md) · [导入流程](../docs/BRIDGE_WORKFLOW.md)

## 7. 更新、备份和恢复

1. 记录正在使用的源码提交、Netlify Deploy ID、APK 版本与签名证书指纹。函数更新按第 3 节先验证草稿，确认生产目标后发布。SQL 迁移由操作员单独执行，Netlify 发布不执行数据库迁移。
2. 升级数据库前，用服务商备份，或在受控设备上用与服务器版本兼容的 `pg_dump --format=custom --schema=health_bridge` 生成加密保存的备份。数据库连接凭据通过本机私密机制提供。备份含健康数据。
3. 用新的隔离 PostgreSQL 实例和 `pg_restore` 演练恢复，预先准备备份策略引用的角色，并按受限运行角色校验 RLS、表数和权限。核对数据并用合成账号验证 REST 回执、MCP 查询和训练营分页。保留可用备份，记录恢复验证结果。
4. Android 更新递增 `versionCode`，核对包名和签名一致后执行覆盖安装。发布后保留原配对，分别验收前台同步、网络中断重试和 Android 自然后台运行。观察云端提交只证明服务端收到了批次，手机完整确认时间用来核对客户端是否已消费回执。 [同步回执诊断](../docs/SYNC_OBSERVATION.md)

凭据、备份、健康导出和模型访问授权保存在各自的私有位置。版本控制只需要源码、配置模板和合成数据。
