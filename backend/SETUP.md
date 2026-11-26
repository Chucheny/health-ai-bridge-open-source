# 自托管后端

首次运行建议先在本地执行 `npm ci` 和 `npm run check`。部署到自己管理的 Netlify 站点和 PostgreSQL，开发测试优先使用独立实例和合成数据。

## 数据库和 REST

1. 以管理员身份将 [001 迁移](migrations/001_health_bridge.sql) 应用到新实例。运行时使用专用最小权限数据库角色。仓库的 Windows DPAPI 配置、Supabase 运行角色初始化工具适合该供应商的事务连接池。管理员和运行角色配置需分开，连接保持证书校验。其他 PostgreSQL 环境按 [权限实现](runtime-role.mts) 配置等效权限并验证。
2. 部署目录配置见 [netlify.toml](../netlify.toml)。静态目录是 `web/`，函数目录是 `netlify/functions/`。根据 [环境变量模板](../.env.example) 在正式环境设置运行角色的 `HEALTH_DATABASE_URL`，必要时配置 CA。所有开关默认关闭。
3. 验证 TLS、鉴权、RLS 和运行角色后，显式启用 `HEALTH_API_ENABLED`。首次使用 Android 调试包配对时，Windows 操作员可用 `tools/Pair-AndroidCloud.ps1 -BaseUrl https://bridge.example.com`，其中域名换成自己的 HTTPS 站点。该脚本需要一个已授权的 ADB 设备、已配置的数据库管理凭据和 CA。
4. 若使用训练营导入，依次应用 [002 运动迁移](migrations/002_trainingcamp_activities.sql) 和 [003 睡眠迁移](migrations/003_trainingcamp_sleep.sql)，更新运行角色权限并验证。Supabase 运行角色工具接受明确的 `-ProjectRef` 和 `-ApplyTrainingCampMigrations`。确认后再启用 `HEALTH_TRAININGCAMP_ENABLED`。导入客户端使用独立、按类型授权的 Bridge 设备配置。详见 [导入工作流](../docs/BRIDGE_WORKFLOW.md)。

操作员脚本应在明确选定的环境运行。数据库凭据、设备配置和签名材料保存在本机私有目录或部署服务的秘密配置中。

## 只读 MCP

在自己管理的 OAuth 提供方配置授权码流程和 S256 PKCE。正式环境设置 `HEALTH_MCP_CONFIG`，内容由部署者为自己的实例填写。

| 字段 | 要求 |
| --- | --- |
| `resource` | 自托管站点的 HTTPS `/mcp` 资源地址 |
| `issuer`、`jwksUrl` | 受信任的 HTTPS 签发方及其同源密钥地址 |
| `subject`、`clientId` | 允许的 OAuth 账号和客户端 |
| `ownerId`、`types` | 对应的 Bridge 账号和记录类型 |
| `readWindow` | 可选的读取日期授权窗口 |

访问令牌须匹配签发方、资源受众、账号和客户端，并带 `health:read`。使用配置的独立开关 `HEALTH_MCP_ENABLED` 启用。部署后先验证匿名查询被拒绝，再用授权之后的合成记录检查两项工具和分页。可在 ChatGPT 中连接该 HTTPS MCP 端点，客户端入口和功能须以账号当前可用能力为准。
