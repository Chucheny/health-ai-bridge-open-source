package dev.healthaibridge.sync

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.health.connect.client.HealthConnectClient
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.healthaibridge.Metric
import kotlinx.coroutines.*
import java.io.File
import java.time.Instant

data class CloudViewState(val configured: Boolean = false, val service: String = "尚未配对",
    val selected: Set<String> = emptySet(), val allowed: Set<String> = emptySet(), val paused: Boolean = true,
    val busy: Boolean = false, val message: String = "准备本机安全存储…", val lastAttempt: String? = null,
    val lastSuccess: String? = null, val pendingAction: String? = null, val storageReady: Boolean = false,
    val automaticEnabled: Boolean = false, val backgroundAvailable: Boolean = false,
    val backgroundGranted: Boolean = false, val automaticStatus: String? = null,
    val lastAutomaticAttempt: String? = null, val lastAutomaticSuccess: String? = null,
    val confirmationSummary: String = "正在读取本机确认状态…")

class CloudSyncViewModel(app: Application) : AndroidViewModel(app) {
    val debugTools = SyncDebugTools(app)
    private val settingsStore by lazy { EncryptedCloudSettings.forApp(app) }
    private val automaticControl by lazy {
        AutomaticSyncControl(settingsStore) { AutomaticSyncScheduler.reconcile(getApplication()) }
    }
    private var settings = CloudSettings()
    private var uploadJob: Job? = null
    private var storageReady = false
    var state by mutableStateOf(CloudViewState()); private set
    init { viewModelScope.launch { try { settings = settingsStore.load(); storageReady = true
        publish(if (settings.pendingAction != null) "上次云端撤销或清空操作尚未确认；请重试同一操作" else "可手动同步；自动同步需要单独授权并启用")
        refreshAutomaticState() }
        catch (_: Exception) { publish("安全配置不可用，未启动同步。请保留本机数据并联系配置人员") } } }
    private fun publish(message: String) {
        state = CloudViewState(settings.configuration != null, settings.configuration?.connection()?.origin ?: "尚未配对",
            settings.selected, settings.configuration?.allowedTypes?.toSet() ?: emptySet(), settings.paused,
            uploadJob?.isActive == true, message, settings.lastAttempt,settings.lastSuccess,settings.pendingAction,storageReady,
            settings.automaticEnabled, state.backgroundAvailable, state.backgroundGranted, settings.automaticStatus,
            settings.lastAutomaticAttempt, settings.lastAutomaticSuccess,
            SyncConfirmation.describe(settings.lastSuccess, Instant.now()))
    }
    fun refreshAutomaticState() {
        if (!storageReady) return
        viewModelScope.launch {
            try {
                AutomaticSyncScheduler.reconcile(getApplication())
                settings = settingsStore.load()
                state = state.copy(backgroundAvailable = BackgroundReadAccess.available(getApplication()),
                    backgroundGranted = BackgroundReadAccess.granted(getApplication()))
                publish(state.message)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { publish("无法确认自动任务状态；请保留本机配置后重试") }
        }
    }
    fun enableAutomaticSync() {
        if (!storageReady || state.busy) return
        viewModelScope.launch {
            try {
                check(BackgroundReadAccess.granted(getApplication()))
                settings = automaticControl.update { current ->
                    check(current.configuration != null && current.selected.isNotEmpty() && current.pendingAction == null)
                    current.copy(automaticEnabled = true, paused = false, automaticStatus = "enabled")
                }
                publish(if (settings.automaticEnabled) "自动同步设置已保存；联网时约每六小时由系统安排，可手动立即同步"
                    else "后台授权或上传选择已变化，自动同步保持关闭")
                refreshAutomaticState()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                publish("未能启用自动同步；请检查后台读取授权及原上传选择")
            }
        }
    }
    fun disableAutomaticSync() {
        viewModelScope.launch {
            try {
                settings = automaticControl.update { it.copy(automaticEnabled = false, automaticStatus = "disabled") }
                publish("自动同步已关闭；原待传数据保留，仍可前台手动同步")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { publish("关闭设置未确认保存，请点击暂停并保留原配置") }
        }
    }
    private fun outbox(config: DeviceConfiguration) = EncryptedSyncStore.forApp(getApplication(), config.namespace())
    fun importPairing() {
        if (state.busy || !storageReady) return
        state = state.copy(busy = true)
        viewModelScope.launch {
            try {
                if (settings.configuration != null) { publish("已配对。更换设备凭据前请先撤销当前上传授权"); return@launch }
                val file = File(getApplication<Application>().filesDir,"cloud-pairing.json")
                val config = withContext(Dispatchers.IO) {
                    require(file.exists() && file.length() in 1..16_384)
                    parseDeviceConfiguration(file.readText())
                }
                // A read-only authenticated request validates pairing; no HC data is read here.
                HealthHttpTransport(config.connection()).status()
                val next = CloudSettings(configuration = config)
                settingsStore.save(next)
                if (!withContext(Dispatchers.IO) { file.delete() }) {
                    settingsStore.save(CloudSettings()); throw java.io.IOException()
                }
                settings = next
                publish("配对成功。尚未授权上传，请逐项选择后点击立即同步")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { publish("未完成配对。请连接电脑配置；不要在聊天中发送凭据") }
            finally { state = state.copy(busy = false) }
        }
    }
    fun select(metric: Metric, selected: Boolean) {
        if (state.busy || !storageReady || settings.pendingAction != null || settings.configuration == null) return
        state = state.copy(busy = true)
        viewModelScope.launch {
            try {
                settings = automaticControl.update { current ->
                    val names = if (selected) current.selected + metric.name else current.selected - metric.name
                    current.copy(selected = names,paused = true,automaticEnabled = false,automaticStatus = "paused")
                }
                publish("上传选择已保存；点击立即同步才会读取并上传")
            } catch (_: Exception) { publish("无法保存上传授权，未开始同步") }
            finally { state = state.copy(busy = false) }
        }
    }
    fun syncFromShortcut() {
        when {
            !storageReady -> publish("安全配置尚不可用，未启动同步")
            settings.pendingAction != null -> publish("上次云端撤销或清空操作尚未确认；请先处理后再同步")
            settings.configuration == null -> publish("尚未配对，请先完成安全配对并选择上传类型")
            settings.selected.isEmpty() -> publish("尚未选择上传类型，请在本页面选择后点击立即同步")
            state.busy -> publish("当前操作尚未完成，请稍后点击立即同步")
            else -> syncNow()
        }
    }
    fun syncNow() {
        if (state.busy || settings.selected.isEmpty() || settings.pendingAction != null) return
        if (settings.configuration == null) return
        uploadJob = viewModelScope.launch {
            try {
                publish("正在同步已选择的数据，请保持此页面在前台")
                val app = getApplication<Application>()
                if (HealthConnectClient.getSdkStatus(app) != HealthConnectClient.SDK_AVAILABLE) {
                    publish("Health Connect 不可用，未读取数据"); return@launch
                }
                val run = executeCloudSync(app, background = false, beforeSend = debugTools.beforeSend)
                settings = settingsStore.load()
                val result = run.outcome
                val metric = run.metric
                if (result != SyncOutcome.COMPLETE) {
                        publish(when (result) {
                            SyncOutcome.MORE_PENDING -> "${metric?.label ?: "数据"}仍有分页待传；再次点击立即同步可继续"
                            SyncOutcome.RETRY_REQUIRED -> "网络暂不可用，待传批次已加密保存；联网后点击立即同步重试"
                            SyncOutcome.CONSENT_REQUIRED -> "${metric?.label ?: "数据"}未获读取或上传授权；请在原连接页授权后重试"
                            SyncOutcome.AUTHENTICATION_REQUIRED -> "上传凭据无效或权限不足，未继续上传"
                            SyncOutcome.RECONCILIATION_REQUIRED -> "增量游标已过期，需核对恢复；未重置游标或重新上传全部历史"
                            SyncOutcome.CONFLICT -> "云端与本机状态冲突，已停止；请保留配置并核对"
                            null -> "没有可同步的已授权类型，未读取数据"
                            else -> "服务器拒绝此批数据，游标未推进；请检查格式或单记录大小"
                        }); return@launch
                }
                publish("所选类型均已收到云端保存确认")
            } catch (cancelled: CancellationException) {
                withContext(NonCancellable) {
                    try { settings = settingsStore.update { current ->
                        if (current.automaticEnabled) current else current.copy(paused = true)
                    } } catch (_: Exception) { }
                }
                publish("前台同步已停止；已确认的进度保留，可稍后继续")
                throw cancelled
            } catch (_: Exception) { publish("同步未完成，未标记成功；请保留本机待传数据后重试") }
            finally { debugTools.reset(); state = state.copy(busy = false) }
        }
        state = state.copy(busy = true)
    }
    fun pause() {
        val jobToPause = uploadJob
        debugTools.reset()
        viewModelScope.launch {
            try {
                settings = automaticControl.update { current -> current.copy(paused = true,automaticEnabled = false,automaticStatus = "paused") }
                jobToPause?.cancelAndJoin()
                publish("已暂停同步并关闭自动任务；手动恢复时将先续传待确认批次")
            } catch (_: Exception) { jobToPause?.cancel(); publish("已停止本次任务；暂停状态保存失败，请勿继续上传") }
        }
    }
    fun stopForegroundSync() { uploadJob?.cancel(); debugTools.reset() }
    override fun onCleared() { debugTools.reset(); super.onCleared() }
    fun destructiveAction(clear: Boolean) {
        if (state.busy) return
        val config = settings.configuration ?: return
        val action = if (clear) "clear" else "revoke"
        if (settings.pendingAction != null && settings.pendingAction != action) return
        uploadJob = viewModelScope.launch {
            try {
                settings = automaticControl.update { current ->
                    current.copy(paused = true,selected = emptySet(),pendingAction = action,automaticEnabled = false,automaticStatus = "paused")
                }
                outbox(config).erase()
                publish(if (clear) "正在请求清除云端数据…" else "正在请求撤销上传凭据…")
                val transport = HealthHttpTransport(config.connection())
                if (clear) transport.clearCloudData() else transport.revoke()
                settings = settingsStore.update { CloudSettings() }
                publish(if (clear) "云端已确认清除数据并撤销凭据；如需再次使用，请重新配对" else "云端已确认撤销凭据，本机已移除配置和待传数据")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { publish("本机上传已停止，云端操作尚未确认；请联网后重试同一操作，必要时核对云端状态") }
            finally { state = state.copy(busy = false) }
        }
        state = state.copy(busy = true)
    }
}
