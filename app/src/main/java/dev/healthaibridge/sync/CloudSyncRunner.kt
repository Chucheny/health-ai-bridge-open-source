package dev.healthaibridge.sync

import dev.healthaibridge.Metric
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

object AutomaticSyncStatus {
    val values = setOf("enabled", "disabled", "running", "complete", "retry", "pending_pages", "permission",
        "authentication", "reconciliation", "conflict", "rejected", "paused")
    fun label(value: String?): String = when (value) {
        "enabled" -> "已启用，等待系统安排联网任务"
        "running" -> "上次后台尝试尚未获得完整确认"
        "complete" -> "上次后台同步已收到完整云端确认"
        "retry" -> "上次同步未获完整确认，已保留进度，等待自动重试"
        "pending_pages" -> "还有数据分页待同步，已保留进度，等待下次继续"
        "permission" -> "后台功能或读取权限不可用，自动同步已关闭"
        "authentication" -> "凭据或权限不足，自动同步已关闭"
        "reconciliation" -> "增量游标需核对恢复，自动同步已关闭"
        "conflict" -> "云端状态冲突，自动同步已关闭"
        "rejected" -> "同步未完成，自动同步已关闭，请保留队列并检查"
        "paused" -> "已暂停，自动同步已关闭"
        else -> "自动同步未启用"
    }
}

data class CloudRunResult(val outcome: SyncOutcome? = null, val metric: Metric? = null)

/** Serializes whole foreground/worker runs; the existing per-stream outbox lock remains intact. */
class CloudSyncRunner(
    private val settings: CloudSettingsStore,
    private val backgroundAllowed: suspend () -> Boolean,
    private val runMetric: suspend (Metric, DeviceConfiguration, SyncConsent) -> SyncOutcome,
    private val metricAllowed: suspend (Metric) -> Boolean = { true },
    private val now: () -> String = { Instant.now().toString() },
) {
    companion object { private val sessionLock = Mutex() }

    suspend fun run(background: Boolean): CloudRunResult = sessionLock.withLock {
        val initial = settings.load()
        val config = initial.configuration ?: return@withLock CloudRunResult()
        if (initial.pendingAction != null || initial.selected.isEmpty() ||
            (background && (!initial.automaticEnabled || initial.paused))) return@withLock CloudRunResult()
        if (background && !backgroundAllowed()) {
            settings.update { it.copy(automaticEnabled = false, automaticStatus = "permission") }
            return@withLock CloudRunResult(SyncOutcome.CONSENT_REQUIRED)
        }
        val namespace = config.namespace()
        val started = settings.update { current ->
            check(current.configuration?.namespace() == namespace && current.pendingAction == null && current.selected.isNotEmpty())
            if (background) {
                check(current.automaticEnabled && !current.paused)
                current.copy(lastAttempt = now(), lastAutomaticAttempt = now(), automaticStatus = "running")
            } else current.copy(paused = false, lastAttempt = now())
        }
        val selected = started.selected
        val consent = SyncConsent { metric ->
            val current = settings.load()
            current.configuration?.namespace() == namespace && current.permits(metric) && metricAllowed(metric) &&
                (!background || (current.automaticEnabled && backgroundAllowed()))
        }
        for (metric in Metric.entries.filter { it.name in selected }) {
            currentCoroutineContext().ensureActive()
            val outcome = runMetric(metric, config, consent)
            if (outcome != SyncOutcome.COMPLETE) {
                if (background) {
                    val retry = outcome in setOf(SyncOutcome.RETRY_REQUIRED, SyncOutcome.MORE_PENDING)
                    val reason = when (outcome) {
                        SyncOutcome.CONSENT_REQUIRED -> "permission"
                        SyncOutcome.AUTHENTICATION_REQUIRED -> "authentication"
                        SyncOutcome.RECONCILIATION_REQUIRED -> "reconciliation"
                        SyncOutcome.CONFLICT -> "conflict"
                        SyncOutcome.RETRY_REQUIRED -> "retry"
                        SyncOutcome.MORE_PENDING -> "pending_pages"
                        else -> "rejected"
                    }
                    settings.update { current ->
                        if (current.configuration?.namespace() != namespace || !current.automaticEnabled) current
                        else current.copy(automaticEnabled = retry, automaticStatus = reason)
                    }
                }
                return@withLock CloudRunResult(outcome, metric)
            }
        }
        currentCoroutineContext().ensureActive()
        // Permission/selection changes after the final acknowledgement must not become full success.
        if (selected.any { name -> !consent.allowed(Metric.entries.first { it.name == name }) }) {
            if (background) settings.update { current ->
                if (current.configuration?.namespace() == namespace && current.automaticEnabled)
                    current.copy(automaticEnabled = false, automaticStatus = "permission") else current
            }
            return@withLock CloudRunResult(SyncOutcome.CONSENT_REQUIRED)
        }
        var confirmed = false
        settings.update { current ->
            if (current.configuration?.namespace() != namespace || current.paused ||
                current.pendingAction != null || current.selected != selected ||
                (background && !current.automaticEnabled)) current
            else current.copy(lastSuccess = now(),
                lastAutomaticSuccess = if (background) now() else current.lastAutomaticSuccess,
                automaticStatus = if (background) "complete" else current.automaticStatus).also { confirmed = true }
        }
        CloudRunResult(if (confirmed) SyncOutcome.COMPLETE else SyncOutcome.CONSENT_REQUIRED)
    }
}
