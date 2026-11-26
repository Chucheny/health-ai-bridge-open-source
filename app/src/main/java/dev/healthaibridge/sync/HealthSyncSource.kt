package dev.healthaibridge.sync

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.google.gson.Gson
import com.google.gson.JsonObject
import dev.healthaibridge.Metric
import dev.healthaibridge.recordJson
import java.time.Duration
import java.time.Instant

fun cloudUpsert(record: Record): String = JsonObject().apply {
    addProperty("op", "upsert")
    add("record", recordJson(record).apply {
        // HC Long versions must survive JavaScript's 53-bit integer limit.
        getAsJsonObject("metadata").addProperty("clientRecordVersion", record.metadata.clientRecordVersion.toString())
    })
}.toString()
fun cloudDelete(id: String): String = JsonObject().apply { addProperty("op", "delete"); addProperty("recordId", id) }.toString()

private data class ReadCursor(val phase: String, val token: String, val start: String? = null,
                              val end: String? = null, val page: String? = null)

/** Separate adapter: existing readWeek()/pagination and UI are untouched. Not yet wired to uploads. */
class HealthSyncSource(private val client: HealthConnectClient,
                       private val now: () -> Instant = { Instant.now() }) : SyncPageSource {
    private val gson = Gson()
    override suspend fun read(metric: Metric, cursor: String?): SyncPage {
        if (metric.permission !in client.permissionController.getGrantedPermissions()) throw SecurityException("Health permission required")
        val state = if (cursor == null) {
            val token = client.getChangesToken(ChangesTokenRequest(setOf(metric.recordClass)))
            val end = now()
            ReadCursor("bootstrap", token, end.minus(Duration.ofDays(7)).toString(), end.toString())
        } else gson.fromJson(cursor, ReadCursor::class.java)
        check(state.token.isNotBlank())
        return when (state.phase) {
            "bootstrap" -> {
                val result = client.readRecords(ReadRecordsRequest(recordType = metric.recordClass,
                    timeRangeFilter = TimeRangeFilter.between(Instant.parse(state.start), Instant.parse(state.end)),
                    pageToken = state.page, pageSize = 100, ascendingOrder = true))
                val next = result.pageToken?.takeIf { it.isNotEmpty() }
                check(next == null || next != state.page) { "Repeated bootstrap page" }
                val after = if (next == null) ReadCursor("changes", state.token) else state.copy(page = next)
                SyncPage(result.records.map(::cloudUpsert), gson.toJson(after), true)
            }
            "changes" -> {
                val result = client.getChanges(state.token)
                if (result.changesTokenExpired) throw ChangesExpired()
                check(result.nextChangesToken.isNotBlank())
                check(!result.hasMore || result.nextChangesToken != state.token) { "Repeated changes page" }
                val operations = result.changes.map { change -> when (change) {
                    is UpsertionChange -> { check(change.record::class == metric.recordClass); cloudUpsert(change.record) }
                    is DeletionChange -> cloudDelete(change.recordId)
                    else -> error("Unsupported change")
                } }
                SyncPage(operations, gson.toJson(ReadCursor("changes", result.nextChangesToken)), result.hasMore)
            }
            else -> error("Unsupported cursor format")
        }
    }
}
