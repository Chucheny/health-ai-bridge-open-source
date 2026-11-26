package dev.healthaibridge.sync

import android.app.Application
import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.await
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import dev.healthaibridge.Metric
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import java.util.concurrent.TimeUnit

/** App-private diagnostics. No exported Android component, file export or logging. */
class SyncDebugTools(private val app: Application) {
    companion object { const val BACKGROUND_VERIFICATION = "health-ai-bridge-background-verification-v1" }
    val gate = DebugSendGate()
    val beforeSend: suspend (Metric) -> Unit = gate::awaitBeforeSend
    fun reset() = gate.reset()

    /** Explicitly restart only the debug verification chain, preserving the six-hour work. */
    suspend fun enqueueBackgroundVerification() {
        val settings = EncryptedCloudSettings.forApp(app, createKeyIfMissing = false).load()
        check(settings.configuration != null && settings.automaticEnabled && !settings.paused &&
            settings.pendingAction == null && settings.selected.isNotEmpty() && BackgroundReadAccess.granted(app))
        val request = OneTimeWorkRequestBuilder<AutomaticCloudSyncWorker>()
            .setInitialDelay(30, TimeUnit.SECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniqueWork(BACKGROUND_VERIFICATION, ExistingWorkPolicy.REPLACE, request).await()
    }

    /** Read only these two app-owned work chains; observing never reconciles or enqueues. */
    suspend fun backgroundSnapshot(): String = withTimeoutOrNull(5_000) {
        val settings = EncryptedCloudSettings.forApp(app, createKeyIfMissing = false).load()
        val manager = WorkManager.getInstance(app)
        val periodic = manager.getWorkInfosForUniqueWorkFlow(AutomaticSyncScheduler.WORK_NAME).first()
        val verification = manager.getWorkInfosForUniqueWorkFlow(BACKGROUND_VERIFICATION).first()
        fun project(infos: List<androidx.work.WorkInfo>) = JsonArray().apply {
            infos.sortedBy { it.id.toString() }.forEach { info ->
                val reason = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) info.stopReason else null
                add(workStateDiagnosticJson(info, reason))
            }
        }
        JsonObject().apply {
            addProperty("diagnosticSchemaVersion", 1)
            addProperty("kind", "background-work")
            addProperty("sampling", "settings-and-work-chains-not-global-atomic")
            addProperty("sampledAt", Instant.now().toString())
            add("automatic", automaticStateDiagnosticJson(settings))
            add("periodic", project(periodic))
            add("verification", project(verification))
        }.toString()
    } ?: error("Background diagnostic timed out")

    suspend fun snapshot(): String = withContext(Dispatchers.IO) {
        val settings = EncryptedCloudSettings.forApp(app, createKeyIfMissing = false).load()
        settings.lastAttempt?.let { Instant.parse(it) }
        settings.lastSuccess?.let { Instant.parse(it) }
        val config = checkNotNull(settings.configuration)
        val store = EncryptedSyncStore.forApp(app, config.namespace(), createKeyIfMissing = false)
        val streams = JsonArray()
        // Each file is atomically replaced. Do not take the engine's whole-run mutex: a
        // paused sender holds it. This is a series of per-type samples, not a DB snapshot.
        for (metric in Metric.entries) {
            val projected = syncStateDiagnosticJson(metric, store.load(metric))
            projected.addProperty("sampledAt", Instant.now().toString())
            streams.add(projected)
        }
        JsonObject().apply {
            addProperty("diagnosticSchemaVersion", 1)
            addProperty("sampling", "per-type-not-global-atomic")
            addProperty("paused", settings.paused)
            addProperty("lastAttempt", settings.lastAttempt)
            addProperty("lastCompleteSuccess", settings.lastSuccess)
            add("streams", streams)
        }.toString()
    }
}

fun LazyListScope.syncDebugPanel(model: CloudSyncViewModel) { item { SyncDebugPanel(model) } }

@Composable private fun SyncDebugPanel(model: CloudSyncViewModel) {
    var expanded by remember { mutableStateOf(false) }
    val tools = model.debugTools
    val gate by tools.gate.status.collectAsState()
    val scope = rememberCoroutineScope()
    var reading by remember { mutableStateOf(false) }
    var arranging by remember { mutableStateOf(false) }
    var snapshot by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf("") }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起续传验收工具" else "续传验收工具（仅调试版）") }
            if (expanded) {
                Text("队列摘要只观察已保存状态，不启动上传；后台验收按钮会替换旧的一次性验收任务，按当前已启用授权安排真实同步，保留六小时任务。摘要不要公开分享。")
                Text(when (gate.phase) {
                    DebugGatePhase.IDLE -> "发送等待：关闭"
                    DebugGatePhase.ARMED -> "已设置：下一批保存后、发送前等待"
                    DebugGatePhase.WAITING -> "${gate.metric?.label}批次已保存，正在发送前等待；尚未发出此批"
                })
                OutlinedButton(onClick = {
                    snapshot = null; tools.gate.arm()
                }, enabled = model.state.configured && !model.state.busy && gate.phase == DebugGatePhase.IDLE) {
                    Text("下一批发送前等待一次")
                }
                if (gate.phase == DebugGatePhase.WAITING) {
                    Button(onClick = { snapshot = null; tools.gate.release() }) { Text("放行此批，继续原同步") }
                    OutlinedButton(onClick = { snapshot = null; model.pause() }) { Text("暂停本次同步") }
                } else if (gate.phase == DebugGatePhase.ARMED) {
                    TextButton(onClick = tools::reset) { Text("取消等待设置") }
                }
                OutlinedButton(onClick = {
                    reading = true; snapshot = null; message = "正在逐类型采样…"
                    scope.launch {
                        try { snapshot = tools.snapshot(); message = "以下为采样时的状态；同步继续后请刷新。" }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { message = "无法读取已有队列，未重置数据或生成新密钥；请保留本机配置。" }
                        finally { reading = false }
                    }
                }, enabled = model.state.configured && model.state.storageReady && !reading) { Text("刷新本机队列摘要") }
                OutlinedButton(onClick = {
                    reading = true; snapshot = null; message = "正在读取后台任务状态…"
                    scope.launch {
                        try { snapshot = tools.backgroundSnapshot(); message = "后台摘要只读；最早可运行时间不是实际执行时间。" }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { message = "无法读取后台任务摘要，未更改调度或本机数据。" }
                        finally { reading = false }
                    }
                }, enabled = model.state.configured && model.state.storageReady && !reading) {
                    Text("刷新后台任务摘要")
                }
                OutlinedButton(onClick = {
                    arranging = true
                    scope.launch {
                        try {
                            tools.enqueueBackgroundVerification()
                            message = "后台验收已重新登记，旧一次性验收已替换；请返回桌面，最早30秒后由系统联网安排，六小时周期保留。"
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { message = "未能登记后台验收；请核对自动同步开关和后台读取授权。" }
                        finally { arranging = false }
                    }
                }, enabled = model.state.configured && model.state.storageReady && model.state.automaticEnabled &&
                    model.state.backgroundGranted && !model.state.busy && !arranging && gate.phase == DebugGatePhase.IDLE) {
                    Text("重新安排后台验收（替换旧验收）")
                }
                Text(message)
                Text("后台摘要中的运行尝试数和上次系统停止原因用于核对重试；排队或任务成功均需结合后台完整确认时间与实际前台状态判断。")
                snapshot?.let { value -> SelectionContainer { Text(value, style = MaterialTheme.typography.bodySmall) } }
                Text("等待仅本次进程有效；离开同步页面会停止任务并取消等待设置。进程重开后，原待传队列仍须手动同步。")
            }
        }
    }
}
