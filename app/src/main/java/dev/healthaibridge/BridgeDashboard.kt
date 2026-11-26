package dev.healthaibridge

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import dev.healthaibridge.sync.AutomaticSyncScheduler
import dev.healthaibridge.sync.AutomaticSyncStatus
import dev.healthaibridge.sync.CloudViewState

@Composable internal fun BridgeCard(content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable internal fun BridgePageHeader(title: String, subtitle: String) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text("HEALTH AI BRIDGE", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable internal fun AutomaticSyncCard(state: CloudViewState, onToggle: () -> Unit, onRefresh: () -> Unit) {
    val showSchedule = state.storageReady && state.automaticEnabled
    val schedule = if (showSchedule) {
        val appContext = LocalContext.current.applicationContext
        remember(appContext) { AutomaticSyncScheduler.observeSchedule(appContext) }
            .collectAsStateWithLifecycle(initialValue = null).value
    } else null
    val canToggle = state.storageReady && !state.busy && (state.automaticEnabled ||
        (state.configured && state.selected.isNotEmpty() && state.pendingAction == null && state.backgroundAvailable))
    BridgeCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                Icon(Icons.Outlined.Refresh, null, Modifier.padding(10.dp).size(22.dp), tint = MaterialTheme.colorScheme.primary)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("自动同步", style = MaterialTheme.typography.titleMedium)
                Text(if (!state.storageReady) "状态未确认" else if (state.automaticEnabled) "已开启 · 约每六小时" else "已关闭", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = state.automaticEnabled, onCheckedChange = { onToggle() }, enabled = canToggle,
                modifier = Modifier.semantics { contentDescription = "自动同步开关" })
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(if (state.automaticStatus == "complete") Icons.Outlined.CheckCircle else Icons.Outlined.Info,
                null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val status = when {
                    !state.storageReady -> "正在读取本机状态…"
                    schedule?.state == WorkInfo.State.RUNNING -> "系统后台任务正在运行"
                    schedule?.state == WorkInfo.State.ENQUEUED && schedule.runAttemptCount == 0 -> "等待系统安排下一轮同步"
                    else -> AutomaticSyncStatus.label(state.automaticStatus)
                }
                Text(status, style = MaterialTheme.typography.bodySmall)
                if (showSchedule) {
                    val timing = when (schedule?.state) {
                        WorkInfo.State.RUNNING -> null
                        WorkInfo.State.ENQUEUED -> schedule.earliestEligibleAt?.let {
                            val label = if (schedule.runAttemptCount > 0) "最早可重试" else "最早可运行"
                            "$label · ${syncTime(it.toString(), compact = true)}"
                        } ?: "系统已排队，运行时间暂不可用"
                        WorkInfo.State.BLOCKED -> "任务暂不可运行，等待系统安排"
                        else -> "系统任务状态暂不可用"
                    }
                    timing?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (schedule != null && schedule.runAttemptCount > 0) {
                        Text("本轮尝试 · ${schedule.runAttemptCount} 次", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text("后台完整确认 · ${syncTime(state.lastAutomaticSuccess, compact = true)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onRefresh, enabled = state.storageReady) {
                Icon(Icons.Outlined.Refresh, "刷新自动同步状态")
            }
        }
        if (state.storageReady && !state.automaticEnabled && !canToggle) {
            Text("开启需要先配对、选择上传类型，并由设备支持后台读取。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable internal fun HomeDashboard(state: CloudViewState, onUpload: () -> Unit, onAutomatic: () -> Unit,
                                      onRefresh: () -> Unit, onHealthSync: () -> Unit, onCloud: () -> Unit,
                                      onData: () -> Unit, onConnection: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)) {
        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text("私人云端", style = MaterialTheme.typography.labelLarge)
                Surface(color = MaterialTheme.colorScheme.onPrimary.copy(alpha = .14f), shape = CircleShape) {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Lock, null, Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onPrimary)
                        Text(if (!state.storageReady) "状态未确认" else if (state.configured) "已配对" else "待配对", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text("把健康记录同步好", style = MaterialTheme.typography.headlineSmall)
            Text("沿用已选择的上传类型", style = MaterialTheme.typography.bodySmall)
            Button(onClick = onUpload, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surface, contentColor = MaterialTheme.colorScheme.primary)) {
                Icon(Icons.AutoMirrored.Outlined.Send, null, Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("一键上传云端", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(20.dp))
            }
            Text("手动上传时，请保持同步页在前台", style = MaterialTheme.typography.labelSmall)
        }
    }
    AutomaticSyncCard(state, onAutomatic, onRefresh)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text("数据与连接", style = MaterialTheme.typography.titleSmall)
        Text("本地只读", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        DashboardShortcut("本地数据", "心率 · 睡眠 · 运动", Icons.Outlined.FavoriteBorder, Modifier.weight(1f), onData)
        DashboardShortcut("Health Sync", "打开来源应用", Icons.Outlined.Share, Modifier.weight(1f), onHealthSync)
    }
    TextButton(onClick = onCloud, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Outlined.Settings, null, Modifier.size(19.dp))
        Spacer(Modifier.width(10.dp))
        Text("云端同步与上传设置", Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(18.dp))
    }
    TextButton(onClick = onConnection, modifier = Modifier.fillMaxWidth()) {
        Text("管理 Health Connect 连接与读取权限", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
    }
    Text("确认时间仅代表云端回执，不代表来源数据已全部更新。系统可能延后后台任务。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable private fun DashboardShortcut(title: String, subtitle: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Icon(icon, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
