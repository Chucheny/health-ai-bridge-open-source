package dev.healthaibridge.sync

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.work.*
import dev.healthaibridge.Metric
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit

object BackgroundReadAccess {
    val permission: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    fun available(context: Context): Boolean = try {
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE &&
            HealthConnectClient.getOrCreate(context).features.getFeatureStatus(
                HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND
            ) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
    } catch (_: Exception) { false }

    suspend fun granted(context: Context): Boolean = available(context) &&
        permission in HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
}

suspend fun executeCloudSync(context: Context, background: Boolean,
                             beforeSend: (suspend (Metric) -> Unit)? = null): CloudRunResult {
    val app = context.applicationContext
    val client by lazy { HealthConnectClient.getOrCreate(app) }
    val settings = EncryptedCloudSettings.forApp(app, createKeyIfMissing = false)
    return CloudSyncRunner(settings, backgroundAllowed = { BackgroundReadAccess.granted(app) },
        metricAllowed = { it.permission in client.permissionController.getGrantedPermissions() },
        runMetric = { metric, config, consent ->
            SyncEngine(EncryptedSyncStore.forApp(app, config.namespace()),
                HealthSyncSource(client), HealthHttpTransport(config.connection()), consent,
                beforeSend = beforeSend).run(metric)
        }).run(background)
}

object AutomaticSyncScheduler {
    const val WORK_NAME = "health-ai-bridge-automatic-sync-v1"
    private val lock = Mutex()
    fun cancel(context: Context): Operation = WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)

    suspend fun reconcile(context: Context) = lock.withLock {
        val store = EncryptedCloudSettings.forApp(context, createKeyIfMissing = false)
        var settings = store.load()
        if (settings.automaticEnabled && !BackgroundReadAccess.granted(context)) {
            settings = store.update { it.copy(automaticEnabled = false, automaticStatus = "permission") }
        }
        if (!settings.automaticEnabled || settings.paused || settings.pendingAction != null ||
            settings.configuration == null || settings.selected.isEmpty()) {
            cancel(context).await()
        } else {
            val request = PeriodicWorkRequestBuilder<AutomaticCloudSyncWorker>(6, TimeUnit.HOURS)
                .setInitialDelay(6, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request).await()
        }
        Unit
    }
}

class AutomaticCloudSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            val result = executeCloudSync(applicationContext, background = true)
            val settings = EncryptedCloudSettings.forApp(applicationContext, createKeyIfMissing = false).load()
            if (!settings.automaticEnabled) AutomaticSyncScheduler.cancel(applicationContext)
            when (result.outcome) {
                null, SyncOutcome.COMPLETE -> Result.success()
                SyncOutcome.RETRY_REQUIRED, SyncOutcome.MORE_PENDING -> Result.retry()
                else -> Result.failure()
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            // No raw exceptions, health payloads, secrets or cursors in WorkManager Data/logs.
            try {
                EncryptedCloudSettings.forApp(applicationContext, createKeyIfMissing = false).update {
                    it.copy(automaticEnabled = false, automaticStatus = "rejected")
                }
                AutomaticSyncScheduler.cancel(applicationContext)
            } catch (_: Exception) { }
            Result.failure()
        }
    }
}
