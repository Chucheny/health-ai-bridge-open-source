package dev.healthaibridge

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.contracts.ExerciseRouteRequestContract
import androidx.lifecycle.ViewModelProvider
import dev.healthaibridge.sync.BackgroundReadAccess
import dev.healthaibridge.sync.CloudSyncViewModel

class MainActivity : ComponentActivity() {
    private lateinit var model: BridgeViewModel
    private lateinit var cloudModel: CloudSyncViewModel
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[BridgeViewModel::class.java]
        cloudModel = ViewModelProvider(this)[CloudSyncViewModel::class.java]
        val permissions = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { model.refresh() }
        val backgroundPermission = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            if (BackgroundReadAccess.permission in granted) cloudModel.enableAutomaticSync()
            else cloudModel.refreshAutomaticState()
        }
        val route = registerForActivityResult(ExerciseRouteRequestContract()) { model.acceptRoute(it) }
        val save = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri -> uri?.let { model.export(it) } }
        setContent { BridgeTheme { BridgeScreen(model,
            onPermissions = {
                try { model.permissionsNeeded().takeIf { it.isNotEmpty() }?.let { permissions.launch(it) } }
                catch (error: Exception) { model.refresh() }
            },
            onSettings = {
                val intent = if (model.availability == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED)
                    Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata"))
                else Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
                try { startActivity(intent) } catch (_: Exception) { model.refresh() }
            },
            onRoute = { id ->
                model.pendingRouteId = id
                try { route.launch(id) } catch (error: Exception) { model.routeFailure(id, error) }
            },
            onSave = { save.launch("health-ai-bridge-${java.time.LocalDate.now()}.json") },
            onCloud = { startActivity(Intent(this, CloudSyncActivity::class.java)) },
            onQuickUpload = { startActivity(Intent(this, CloudSyncActivity::class.java).putExtra(CloudSyncActivity.EXTRA_START_SYNC, true)) },
            onPrivacy = { startActivity(Intent(this, PrivacyActivity::class.java)) },
            cloudState = cloudModel.state,
            onAutomaticSync = {
                if (cloudModel.state.automaticEnabled) cloudModel.disableAutomaticSync()
                else if (cloudModel.state.backgroundGranted) cloudModel.enableAutomaticSync()
                else backgroundPermission.launch(setOf(BackgroundReadAccess.permission))
            },
            onRefreshCloud = cloudModel::refreshAutomaticState,
            onHealthSync = {
                val launch = packageManager.getLaunchIntentForPackage("nl.appyhapps.healthsync")
                if (launch == null) Toast.makeText(this, "无法打开 Health Sync，请检查是否已安装并启用", Toast.LENGTH_LONG).show()
                else try { startActivity(launch) } catch (_: Exception) {
                    Toast.makeText(this, "无法打开 Health Sync，请检查是否已安装并启用", Toast.LENGTH_LONG).show()
                }
            }
        ) } }
    }
    override fun onResume() { super.onResume(); if (::model.isInitialized) model.refresh(); if (::cloudModel.isInitialized) cloudModel.refreshAutomaticState() }
    override fun onStop() { if (::model.isInitialized) model.stopForegroundRead(); super.onStop() }
}

class PrivacyActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            BridgeTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        TextButton(onClick = { finish() }, contentPadding = PaddingValues(0.dp)) { Text("‹ 返回") }
                        Text("健康数据与隐私", style = MaterialTheme.typography.headlineSmall)
                        BridgeCard {
                            Text("本机读取和导出", style = MaterialTheme.typography.titleMedium)
                            Text("Bridge 以只读方式访问你在 Health Connect 授权的数据，用于本机展示。运动路线由系统单独授权。你主动导出的 JSON 可能包含健康记录和已读取的 GPS 路线，文件保存在你选择的位置。")
                        }
                        BridgeCard {
                            Text("私人云端同步", style = MaterialTheme.typography.titleMedium)
                            Text("完成配对并选择上传类型后，Bridge 才能通过 HTTPS 同步所选记录。GPS 路线排除在云端同步之外。配对凭据和待传数据在手机上加密保存。")
                            Text("自动同步默认关闭。授予后台读取权限并开启后，手机可在联网时定期同步，具体时间由 Android 安排。你可以随时关闭自动同步。")
                        }
                        BridgeCard {
                            Text("ChatGPT 读取", style = MaterialTheme.typography.titleMedium)
                            Text("你在 ChatGPT 中另行授权 Health AI Bridge 后，ChatGPT 可以按请求读取授权范围内的云端记录。可以在 ChatGPT 的应用设置中断开此连接。")
                        }
                        BridgeCard {
                            Text("撤销权限与清除记录", style = MaterialTheme.typography.titleMedium)
                            Text("在 Health Connect 中可撤销本机读取权限。在 Bridge 的「连接与高级操作」中，撤销上传授权会停用设备凭据，先前上传的记录仍在云端。选择清除云端数据会删除此云端账户的健康记录并撤销设备凭据，手机上的 Health Connect 原始记录仍可保留。")
                        }
                        Text("开源参考：Android Health Samples（Apache-2.0）；Health Connect Data Exporter，Maksim Aitov（MIT）。完整许可证随项目提供。",
                            style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
