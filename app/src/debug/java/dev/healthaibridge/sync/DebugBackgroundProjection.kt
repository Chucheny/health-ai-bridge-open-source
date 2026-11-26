package dev.healthaibridge.sync

import androidx.work.WorkInfo
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import java.time.Instant

/** Explicit metadata allowlist: never serialize settings, WorkInfo, Data or tags. */
fun automaticStateDiagnosticJson(settings: CloudSettings): JsonObject = try {
    require(settings.automaticStatus == null || settings.automaticStatus in AutomaticSyncStatus.values)
    settings.lastAutomaticAttempt?.let { Instant.parse(it) }
    settings.lastAutomaticSuccess?.let { Instant.parse(it) }
    JsonObject().apply {
        addProperty("enabled", settings.automaticEnabled)
        addProperty("paused", settings.paused)
        add("status", settings.automaticStatus?.let(::JsonPrimitive) ?: JsonNull.INSTANCE)
        add("lastAttempt", settings.lastAutomaticAttempt?.let(::JsonPrimitive) ?: JsonNull.INSTANCE)
        add("lastCompleteSuccess", settings.lastAutomaticSuccess?.let(::JsonPrimitive) ?: JsonNull.INSTANCE)
    }
} catch (_: RuntimeException) {
    throw IllegalStateException("Invalid diagnostic automatic state")
}

fun workStateDiagnosticJson(info: WorkInfo, previousStopReason: Int?): JsonObject = JsonObject().apply {
    addProperty("workId", info.id.toString())
    addProperty("state", info.state.name)
    addProperty("runAttemptCount", info.runAttemptCount)
    // This is an eligibility time, never a promise that Android will execute then.
    val earliest = info.nextScheduleTimeMillis.takeIf {
        info.state == WorkInfo.State.ENQUEUED && it >= 0 && it != Long.MAX_VALUE
    }
    add("earliestEligibleAt", earliest?.let { JsonPrimitive(Instant.ofEpochMilli(it).toString()) } ?: JsonNull.INSTANCE)
    add("previousStopReason", previousStopReason?.let(::JsonPrimitive) ?: JsonNull.INSTANCE)
}
