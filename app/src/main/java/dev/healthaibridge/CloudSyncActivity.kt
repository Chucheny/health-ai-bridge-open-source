package dev.healthaibridge

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.health.connect.client.PermissionController
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.ui.Alignment
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import dev.healthaibridge.sync.CloudSyncViewModel
import dev.healthaibridge.sync.syncDebugPanel
import dev.healthaibridge.sync.BackgroundReadAccess
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class CloudSyncActivity : ComponentActivity() {
    companion object { const val EXTRA_START_SYNC = "dev.healthaibridge.START_SYNC" }
    private lateinit var model: CloudSyncViewModel
    private var foreground by mutableStateOf(false)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[CloudSyncViewModel::class.java]
        val startSync = intent.getBooleanExtra(EXTRA_START_SYNC, false)
        setContent { BridgeTheme { CloudSyncScreen(model, startSync, foreground) { finish() } } }
    }
    override fun onStart() { super.onStart(); foreground = true; if (::model.isInitialized) model.refreshAutomaticState() }
    override fun onStop() { foreground = false; if (::model.isInitialized) model.stopForegroundSync(); super.onStop() }
}
internal fun syncTime(value: String?, compact: Boolean = false): String = value?.let {
    try {
        val zone = ZoneId.systemDefault()
        val time = Instant.parse(it).atZone(zone)
        if (!compact) DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z").format(time)
        else if (time.toLocalDate() == java.time.LocalDate.now(zone)) "今天 ${DateTimeFormatter.ofPattern("HH:mm").format(time)}"
        else DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").format(time)
    }
    catch (_: Exception) { "时间不可用" }
} ?: "尚无"

@Composable private fun CloudSyncScreen(model: CloudSyncViewModel, startSync: Boolean, foreground: Boolean, onBack: () -> Unit) {
    val state = model.state
    var shortcutPending by rememberSaveable { mutableStateOf(startSync) }
    LaunchedEffect(shortcutPending, state.storageReady, foreground) {
        if (shortcutPending && state.storageReady && foreground) {
            shortcutPending = false
            model.syncFromShortcut()
        }
    }
    var confirmation by remember { mutableStateOf<String?>(null) }
    val backgroundPermission = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
        if (BackgroundReadAccess.permission in granted) model.enableAutomaticSync()
        else model.refreshAutomaticState()
    }
    var showTypes by rememberSaveable { mutableStateOf(false) }
    var showAdvanced by rememberSaveable { mutableStateOf(false) }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        LazyColumn(Modifier.safeDrawingPadding(), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回首页") }
                Text("私人云端同步", style = MaterialTheme.typography.headlineSmall)
            } }
            item { BridgeCard {
                Text(if (state.busy) "正在同步" else "手动上传", style = MaterialTheme.typography.titleLarge)
                Text(state.message, style = MaterialTheme.typography.bodyMedium)
                if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("沿用已选择的上传类型；离开此页面会停止本次前台同步。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = model::syncNow, modifier = Modifier.weight(1f).heightIn(min = 50.dp), enabled = state.configured && state.storageReady && !state.busy && state.selected.isNotEmpty() && state.pendingAction == null) { Text("立即同步") }
                    OutlinedButton(onClick = model::pause, modifier = Modifier.heightIn(min = 50.dp), enabled = state.configured && state.storageReady) { Text("暂停") }
                }
            } }
            item { BridgeCard {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("云端确认", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    IconButton(onClick = model::refreshAutomaticState) { Icon(Icons.Outlined.Refresh, "刷新确认状态") }
                }
                Text(state.confirmationSummary, style = MaterialTheme.typography.bodyMedium)
                Text("最近完整确认　${syncTime(state.lastSuccess)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("来源 App 尚未写入的数据不会包含在内；AI 可读取的日期仍受单独授权限制。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } }
            item { AutomaticSyncCard(state, onToggle = {
                if (state.automaticEnabled) model.disableAutomaticSync()
                else if (state.backgroundGranted) model.enableAutomaticSync()
                else backgroundPermission.launch(setOf(BackgroundReadAccess.permission))
            }, onRefresh = model::refreshAutomaticState) }
            if (!state.configured) item { BridgeCard {
                Text("连接私人云端", style = MaterialTheme.typography.titleMedium)
                Text("连接电脑完成安全配对。凭据加密保存在本机。", style = MaterialTheme.typography.bodySmall)
                Button(onClick = model::importPairing, enabled = state.storageReady && !state.busy) { Text("接收电脑配对配置") }
            } }
            item { BridgeCard {
                Text("上传类型", style = MaterialTheme.typography.titleMedium)
                Text("已选择 ${state.selected.size} 项 · 读取与上传分别授权", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { showTypes = !showTypes }) { Text(if (showTypes) "收起上传类型" else "管理上传类型") }
                if (showTypes) {
                    Text("首次读取最近 7 天，之后增量同步；更改选择会暂停并关闭自动同步。", style = MaterialTheme.typography.bodySmall)
                    Metric.entries.forEach { metric ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = metric.name in state.selected, onCheckedChange = { model.select(metric, it) },
                                enabled = state.configured && !state.busy && state.pendingAction == null && metric.recordClass.simpleName in state.allowed)
                            Text(metric.label, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    Text("步数按来源保存，心率保留逐点时间，睡眠保留分期，HRV 为 RMSSD；不上传 GPS。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } }
            item { BridgeCard {
                TextButton(onClick = { showAdvanced = !showAdvanced }) { Text(if (showAdvanced) "收起连接与高级操作" else "连接与高级操作") }
                if (showAdvanced) {
                    Text(state.service, style = MaterialTheme.typography.bodySmall)
                    Text("最近尝试　${syncTime(state.lastAttempt)}", style = MaterialTheme.typography.bodySmall)
                    Text("最近后台尝试　${syncTime(state.lastAutomaticAttempt)}", style = MaterialTheme.typography.bodySmall)
                    Text(if (!state.backgroundAvailable) "设备不支持后台健康读取" else if (state.backgroundGranted) "后台读取权限已授予" else "后台读取权限未授予", style = MaterialTheme.typography.bodySmall)
                    Text("系统可能因省电或网络延后后台任务；强制停止后需重开 App。", style = MaterialTheme.typography.bodySmall)
                    if (state.configured) {
                        OutlinedButton(onClick = { confirmation = "revoke" }, enabled = !state.busy && state.pendingAction in listOf(null, "revoke")) { Text("撤销上传授权") }
                        OutlinedButton(onClick = { confirmation = "clear" }, enabled = !state.busy && state.pendingAction in listOf(null, "clear"),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("清除云端数据") }
                        Text("撤销后需重新配对。清除会删除账户云端记录并撤销凭据，Health Connect 原始数据保留。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            } }
            syncDebugPanel(model)
        }
    }
    confirmation?.let { action -> AlertDialog(onDismissRequest = { confirmation = null },
        title = { Text(if (action == "clear") "确认清除云端数据？" else "确认撤销上传授权？") },
        text = { Text(if (action == "clear") "这会永久删除此账户的全部云端健康记录，并撤销全部设备凭据。Health Connect 中的数据保留。"
            else "立即停止本机上传，并请求云端撤销此凭据。本机待传数据和配置将移除，云端历史数据保留。") },
        confirmButton = { TextButton(onClick = { confirmation = null; model.destructiveAction(action == "clear") }) { Text("确认") } },
        dismissButton = { TextButton(onClick = { confirmation = null }) { Text("取消") } }) }
}
