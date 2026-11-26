package dev.healthaibridge.sync

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import dev.healthaibridge.Metric
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.UUID

// Only the adapter knows whether this opaque cursor is bootstrap paging or Changes.
data class SyncPage(val operations: List<String>, val nextCursor: String, val hasMore: Boolean)
data class PendingBatch(val batchId: String, val sequence: Long, val body: String)
data class PendingPage(val batches: List<PendingBatch>, val acknowledged: Int,
                       val nextCursor: String, val hasMore: Boolean)
data class SyncState(val cursor: String? = null, val sequence: Long = 0,
                     val lastSuccessfulAt: String? = null, val pending: PendingPage? = null)
data class Receipt(val batchId: String, val sequence: Long, val committed: Boolean, val committedAt: String)

interface SyncStore {
    // One process-wide lock shared by manual/worker callers; save is atomic and durable.
    val mutex: Mutex
    suspend fun load(metric: Metric): SyncState
    suspend fun save(metric: Metric, state: SyncState)
}
fun interface SyncPageSource { suspend fun read(metric: Metric, cursor: String?): SyncPage }
fun interface SyncTransport { suspend fun send(batch: PendingBatch): Receipt }
// Rechecked before reading and before EACH upload, including persisted pending batches.
fun interface SyncConsent { suspend fun allowed(metric: Metric): Boolean }
class ChangesExpired : Exception()
class SyncAuthenticationRequired : Exception()
class SyncConflict : Exception()
class SyncRejected : Exception()
enum class SyncOutcome { COMPLETE, MORE_PENDING, RETRY_REQUIRED, CONSENT_REQUIRED,
    RECONCILIATION_REQUIRED, AUTHENTICATION_REQUIRED, CONFLICT, REJECTED }

fun retryableHttpStatus(status: Int): Boolean = status == 408 || status == 429 || status in 500..599

private fun requestBody(metric: Metric, id: String, sequence: Long, ops: List<String>): String = JsonObject().apply {
    addProperty("schemaVersion", 1); addProperty("batchId", id)
    addProperty("recordType", metric.recordClass.simpleName)
    addProperty("sequence", sequence)
    add("operations", JsonArray().apply { ops.forEach { add(JsonParser.parseString(it)) } })
}.toString()

// Payloads are persisted byte-for-byte; retries never regenerate IDs or re-read the page.
fun pendingBatches(metric: Metric, sequence: Long, operations: List<String>,
                   maxOperations: Int = 100, maxBytes: Int = 1_500_000): List<PendingBatch> {
    require(maxOperations in 1..100 && maxBytes in 512..2_097_152)
    val result = mutableListOf<PendingBatch>()
    var chunk = mutableListOf<String>()
    var id = UUID.randomUUID().toString()
    fun nextSequence() = Math.addExact(sequence, result.size.toLong() + 1).also { require(it <= 9_007_199_254_740_991L) }
    fun body(ops: List<String>) = requestBody(metric, id, nextSequence(), ops)
    fun finish() {
        result += PendingBatch(id, nextSequence(), body(chunk))
        chunk = mutableListOf(); id = UUID.randomUUID().toString()
    }
    for (operation in operations) {
        val obj = JsonParser.parseString(operation).asJsonObject
        require(obj["op"].asString in setOf("upsert", "delete"))
        require(operation.toByteArray(Charsets.UTF_8).size <= 1_048_576)
        if (chunk.isNotEmpty() && (chunk.size == maxOperations || body(chunk + operation).toByteArray(Charsets.UTF_8).size > maxBytes)) finish()
        require(body(chunk + operation).toByteArray(Charsets.UTF_8).size <= maxBytes) { "Record exceeds upload limit" }
        chunk += operation
    }
    if (chunk.isNotEmpty() || result.isEmpty()) finish() // Empty Changes page also needs an acknowledged checkpoint.
    return result
}

class SyncEngine(private val store: SyncStore, private val source: SyncPageSource,
                 private val transport: SyncTransport, private val consent: SyncConsent,
                 private val beforeSend: (suspend (Metric) -> Unit)? = null) {
    suspend fun run(metric: Metric, maxPages: Int = 20): SyncOutcome = store.mutex.withLock {
        require(maxPages > 0)
        val visited = mutableSetOf<String?>()
        try {
            repeat(maxPages) {
                currentCoroutineContext().ensureActive()
                if (!consent.allowed(metric)) return@withLock SyncOutcome.CONSENT_REQUIRED
                var state = store.load(metric)
                if (state.pending == null) {
                    check(visited.add(state.cursor)) { "Repeated sync cursor" }
                    val page = source.read(metric, state.cursor)
                    require(page.nextCursor.isNotBlank())
                    require(!page.hasMore || page.nextCursor != state.cursor) { "Repeated sync cursor" }
                    state = state.copy(pending = PendingPage(pendingBatches(metric, state.sequence, page.operations),
                        0, page.nextCursor, page.hasMore))
                    store.save(metric, state) // Never send data that cannot be resumed after process death.
                }
                while (state.pending != null) {
                    currentCoroutineContext().ensureActive()
                    if (!consent.allowed(metric)) return@withLock SyncOutcome.CONSENT_REQUIRED
                    val page = checkNotNull(state.pending)
                    val batch = page.batches[page.acknowledged]
                    beforeSend?.let { hook ->
                        hook(metric) // Debug builds may wait here, after the pending page is durable.
                        currentCoroutineContext().ensureActive()
                        if (!consent.allowed(metric)) return@withLock SyncOutcome.CONSENT_REQUIRED
                    }
                    val receipt = transport.send(batch)
                    if (!receipt.committed || receipt.batchId != batch.batchId || receipt.sequence != batch.sequence || receipt.committedAt.isBlank())
                        throw SyncConflict()
                    val done = page.acknowledged + 1 == page.batches.size
                    state = if (done) state.copy(cursor = page.nextCursor, sequence = batch.sequence,
                        lastSuccessfulAt = receipt.committedAt, pending = null)
                    else state.copy(sequence = batch.sequence, pending = page.copy(acknowledged = page.acknowledged + 1))
                    store.save(metric, state) // If local save fails, replay old batch; cloud idempotency supplies the same receipt.
                    if (done && !page.hasMore) return@withLock SyncOutcome.COMPLETE
                }
            }
            SyncOutcome.MORE_PENDING
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: ChangesExpired) { SyncOutcome.RECONCILIATION_REQUIRED }
        catch (_: SyncAuthenticationRequired) { SyncOutcome.AUTHENTICATION_REQUIRED }
        catch (_: SyncConflict) { SyncOutcome.CONFLICT }
        catch (_: SyncRejected) { SyncOutcome.REJECTED }
        catch (_: SecurityException) { SyncOutcome.CONSENT_REQUIRED }
        catch (_: IOException) { SyncOutcome.RETRY_REQUIRED }
    }
}
