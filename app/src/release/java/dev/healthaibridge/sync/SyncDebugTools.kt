package dev.healthaibridge.sync

import android.app.Application
import androidx.compose.foundation.lazy.LazyListScope
import dev.healthaibridge.Metric

/** Release source set: no diagnostic reader, UI or send gate. */
class SyncDebugTools(@Suppress("UNUSED_PARAMETER") app: Application) {
    val beforeSend: (suspend (Metric) -> Unit)? = null
    fun reset() = Unit
}

fun LazyListScope.syncDebugPanel(@Suppress("UNUSED_PARAMETER") model: CloudSyncViewModel) = Unit
