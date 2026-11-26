package dev.healthaibridge.sync

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Owns the durable preference change and the corresponding scheduler reconciliation. */
class AutomaticSyncControl(
    private val settings: CloudSettingsStore,
    private val reconcile: suspend () -> Unit,
) {
    companion object { private val lock = Mutex() }

    suspend fun update(transform: (CloudSettings) -> CloudSettings): CloudSettings {
        currentCoroutineContext().ensureActive()
        return lock.withLock {
            currentCoroutineContext().ensureActive()
            // Cancellation may otherwise reach the IO return after the settings file was
            // committed, skipping reconciliation. Protect the entire durable transition.
            val value = withContext(NonCancellable) {
                try {
                    settings.update(transform)
                    reconcile()
                    settings.load()
                } catch (failure: Exception) {
                    // This rollback belongs to the same control transaction. A later enable
                    // must not be overwritten by an older UI caller's failure cleanup.
                    try {
                        settings.update { it.copy(automaticEnabled = false, automaticStatus = "rejected") }
                        reconcile()
                    } catch (_: Exception) { /* Preserve the original failure; no raw logging. */ }
                    throw failure
                }
            }
            currentCoroutineContext().ensureActive()
            value
        }
    }
}
