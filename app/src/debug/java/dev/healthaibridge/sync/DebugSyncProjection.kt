package dev.healthaibridge.sync

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import dev.healthaibridge.Metric
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

private const val MAX_SAFE_SEQUENCE = 9_007_199_254_740_991L

private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** Strict metadata projection. Never expose SyncState/PendingBatch toString or parser errors. */
fun syncStateDiagnosticJson(metric: Metric, state: SyncState): JsonObject = try {
    require(state.sequence in 0..MAX_SAFE_SEQUENCE)
    state.lastSuccessfulAt?.let { Instant.parse(it) }
    JsonObject().apply {
        addProperty("metric", metric.name)
        addProperty("sequence", state.sequence)
        add("lastSuccessfulAt", state.lastSuccessfulAt?.let { com.google.gson.JsonPrimitive(it) } ?: JsonNull.INSTANCE)
        add("cursorSha256", state.cursor?.let { com.google.gson.JsonPrimitive(sha256(it)) } ?: JsonNull.INSTANCE)
        add("pending", state.pending?.let { page ->
            require(page.batches.isNotEmpty() && page.acknowledged in page.batches.indices)
            JsonObject().apply {
                addProperty("acknowledged", page.acknowledged)
                addProperty("totalBatches", page.batches.size)
                addProperty("nextCursorSha256", sha256(page.nextCursor))
                addProperty("hasMore", page.hasMore)
                add("batches", JsonArray().apply {
                    page.batches.forEach { batch ->
                        require(UUID.fromString(batch.batchId).toString() == batch.batchId)
                        require(batch.sequence in 1..MAX_SAFE_SEQUENCE)
                        val operationCount = JsonParser.parseString(batch.body).asJsonObject["operations"].asJsonArray.size()
                        add(JsonObject().apply {
                            addProperty("batchId", batch.batchId)
                            addProperty("sequence", batch.sequence)
                            addProperty("bodySha256", sha256(batch.body))
                            addProperty("operationCount", operationCount)
                        })
                    }
                })
            }
        } ?: JsonNull.INSTANCE)
    }
} catch (_: RuntimeException) {
    // Do not chain the exception: JSON/Instant parser messages can contain private input.
    throw IllegalStateException("Invalid diagnostic sync state")
}
