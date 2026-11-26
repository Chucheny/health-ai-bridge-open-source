package dev.healthaibridge.sync

import dev.healthaibridge.Metric
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class DebugGatePhase { IDLE, ARMED, WAITING }

data class DebugGateStatus(val phase: DebugGatePhase = DebugGatePhase.IDLE, val metric: Metric? = null)

/** One-shot, in-memory debug gate. The engine owns persistence and consent checks. */
class DebugSendGate {
    private val lock = Any()
    private var armed = false
    private var waiter: CompletableDeferred<Unit>? = null
    private val mutableStatus = MutableStateFlow(DebugGateStatus())
    val status: StateFlow<DebugGateStatus> = mutableStatus.asStateFlow()

    fun arm() = synchronized(lock) {
        if (waiter == null) {
            armed = true
            mutableStatus.value = DebugGateStatus(DebugGatePhase.ARMED)
        }
    }

    fun release() = synchronized(lock) {
        waiter?.complete(Unit)
        Unit
    }

    /** Reset aborts an outstanding send attempt; it never grants permission to send. */
    fun reset(): Unit = synchronized(lock) {
        armed = false
        val previous = waiter
        waiter = null
        mutableStatus.value = DebugGateStatus()
        previous?.cancel(CancellationException("Debug send wait cancelled"))
        Unit
    }

    suspend fun awaitBeforeSend(metric: Metric) {
        currentCoroutineContext().ensureActive()
        val signal = synchronized(lock) {
            if (!armed) null else {
                armed = false
                CompletableDeferred<Unit>().also {
                    waiter = it
                    mutableStatus.value = DebugGateStatus(DebugGatePhase.WAITING, metric)
                }
            }
        } ?: return
        try {
            signal.await()
        } finally {
            synchronized(lock) {
                // A cancelled older attempt must not clear a newly armed gate.
                if (waiter === signal) {
                    waiter = null
                    mutableStatus.value = DebugGateStatus()
                }
            }
        }
    }
}
