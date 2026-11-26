# 贡献说明

提交改动前，在仓库根目录运行 `npm ci` 和 `npm run check`。Android 改动另运行 `./gradlew :app:testDebugUnitTest :app:lintDebug`，Windows 使用 `./gradlew.bat`。

复现问题时请注明版本、平台、来源、操作步骤和固定错误码。新增示例统一使用合成记录和示例域名。请以自己的测试实例验证上传、清除、配对和部署。安全问题请看 [安全说明](SECURITY.md)。
