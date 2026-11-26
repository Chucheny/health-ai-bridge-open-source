package dev.healthaibridge

import com.google.gson.JsonParser
import dev.healthaibridge.sync.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.security.MessageDigest
import javax.crypto.KeyGenerator

/** Synthetic debug-build proof; no phone, Health Connect or production API access. */
class DebugSyncToolsTest {
    private fun receipt(batch: PendingBatch) =
        Receipt(batch.batchId, batch.sequence, true, "2026-01-01T00:00:00Z")

    private suspend fun withDiskStore(test: suspend (() -> EncryptedSyncStore) -> Unit) {
        val directory = Files.createTempDirectory("bridge-debug-tools-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try { test { EncryptedSyncStore(directory, key) } }
        finally {
            directory.listFiles()?.forEach { check(it.isFile && it.delete()) }
            check(directory.delete())
        }
    }

    private suspend fun waiting(gate: DebugSendGate) = withTimeout(5_000) {
        gate.status.first { it.phase == DebugGatePhase.WAITING }
    }

    @Test fun sendWaitExposesDurablePendingBeforeAnyTransportCallAndReleaseCommits() = runBlocking {
        withDiskStore { openStore ->
            val gate = DebugSendGate().apply { arm() }
            var sends = 0
            val source = SyncPageSource { _, _ ->
                SyncPage(listOf(cloudDelete("synthetic-record")), "private-next-cursor", false)
            }
            val job = async {
                SyncEngine(openStore(), source, SyncTransport { batch ->
                    sends++; receipt(batch)
                }, SyncConsent { true }, gate::awaitBeforeSend).run(Metric.HEART)
            }
            try {
                assertEquals(Metric.HEART, waiting(gate).metric)
                // This read must finish while the engine still holds its run-wide mutex.
                val sampled = withTimeout(5_000) { openStore().load(Metric.HEART) }
                assertEquals(0, sends)
                assertNull(sampled.cursor)
                assertNull(sampled.lastSuccessfulAt)
                assertEquals(0L, sampled.sequence)
                assertEquals(0, sampled.pending!!.acknowledged)
                assertEquals(1, sampled.pending.batches.size)
                val projection = syncStateDiagnosticJson(Metric.HEART, sampled)
                assertEquals(sampled.pending.batches.single().batchId,
                    projection.getAsJsonObject("pending").getAsJsonArray("batches")[0]
                        .asJsonObject["batchId"].asString)

                gate.release()
                assertEquals(SyncOutcome.COMPLETE, withTimeout(5_000) { job.await() })
                assertEquals(1, sends)
                val committed = openStore().load(Metric.HEART)
                assertEquals("private-next-cursor", committed.cursor)
                assertEquals(1L, committed.sequence)
                assertNull(committed.pending)
                assertEquals(DebugGatePhase.IDLE, gate.status.value.phase)
            } finally { job.cancelAndJoin() }
        }
    }

    @Test fun cancellationDuringWaitPreservesCheckpointAndRestartReplaysExactBatch() = runBlocking {
        withDiskStore { openStore ->
            val original = SyncState(cursor = "private-old-cursor", sequence = 7,
                lastSuccessfulAt = "2025-12-31T00:00:00Z")
            openStore().save(Metric.SLEEP, original)
            val gate = DebugSendGate().apply { arm() }
            var reads = 0
            val source = SyncPageSource { _, cursor ->
                reads++
                assertEquals(original.cursor, cursor)
                SyncPage(listOf(cloudDelete("synthetic-sleep-record")), "private-new-cursor", false)
            }
            val sent = mutableListOf<PendingBatch>()
            val transport = SyncTransport { batch -> sent += batch; receipt(batch) }
            val job = async {
                SyncEngine(openStore(), source, transport, SyncConsent { true },
                    gate::awaitBeforeSend).run(Metric.SLEEP)
            }
            val pending = try {
                waiting(gate)
                openStore().load(Metric.SLEEP).also {
                    assertEquals(original, it.copy(pending = null))
                    assertEquals(0, it.pending!!.acknowledged)
                    assertTrue(sent.isEmpty())
                }
            } finally { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
            assertEquals(DebugGatePhase.IDLE, gate.status.value.phase)
            assertEquals(pending, openStore().load(Metric.SLEEP))

            assertEquals(SyncOutcome.COMPLETE, withTimeout(5_000) {
                SyncEngine(openStore(), source, transport, SyncConsent { true },
                    gate::awaitBeforeSend).run(Metric.SLEEP)
            })
            assertEquals(listOf(pending.pending!!.batches.single()), sent)
            assertEquals(1, reads)
            assertEquals("private-new-cursor", openStore().load(Metric.SLEEP).cursor)
        }
    }

    @Test fun consentWithdrawalWhileWaitingBlocksReleaseWithoutDiscardingPending() = runBlocking {
        withDiskStore { openStore ->
            val gate = DebugSendGate().apply { arm() }
            var allowed = true
            var sends = 0
            val job = async {
                SyncEngine(openStore(), SyncPageSource { _, _ ->
                    SyncPage(listOf(cloudDelete("synthetic-record")), "next", false)
                }, SyncTransport { batch -> sends++; receipt(batch) }, SyncConsent { allowed },
                    gate::awaitBeforeSend).run(Metric.HEART)
            }
            try {
                waiting(gate)
                val pending = openStore().load(Metric.HEART)
                allowed = false
                gate.release()
                assertEquals(SyncOutcome.CONSENT_REQUIRED, withTimeout(5_000) { job.await() })
                assertEquals(0, sends)
                assertEquals(pending, openStore().load(Metric.HEART))
                assertNull(pending.cursor)
                assertNull(pending.lastSuccessfulAt)
            } finally { job.cancelAndJoin() }
        }
    }

    @Test fun resetCancelsWaitingEngineInsteadOfSendingAndLeavesDiskQueueIntact() = runBlocking {
        withDiskStore { openStore ->
            val gate = DebugSendGate().apply { arm() }
            var sends = 0
            val job = async {
                SyncEngine(openStore(), SyncPageSource { _, _ -> SyncPage(emptyList(), "next", false) },
                    SyncTransport { batch -> sends++; receipt(batch) }, SyncConsent { true },
                    gate::awaitBeforeSend).run(Metric.HEART)
            }
            try {
                waiting(gate)
                val pending = openStore().load(Metric.HEART)
                gate.reset()
                try { withTimeout(5_000) { job.await() }; fail("Reset must cancel the attempt") }
                catch (_: CancellationException) { }
                assertTrue(job.isCancelled)
                assertEquals(0, sends)
                assertEquals(pending, openStore().load(Metric.HEART))
                assertEquals(DebugGatePhase.IDLE, gate.status.value.phase)
            } finally { job.cancelAndJoin() }
        }
    }

    @Test fun armingIsOneShotAndResettingAnUnusedArmDoesNotBlockNextAttempt() = runBlocking {
        val gate = DebugSendGate()
        gate.arm()
        gate.reset()
        withTimeout(5_000) { gate.awaitBeforeSend(Metric.HEART) }
        assertEquals(DebugGatePhase.IDLE, gate.status.value.phase)
        gate.arm()
        val firstAttempt = async { gate.awaitBeforeSend(Metric.HEART) }
        try {
            waiting(gate)
            gate.release()
            withTimeout(5_000) { firstAttempt.await() }
            withTimeout(5_000) { gate.awaitBeforeSend(Metric.SLEEP) }
            assertEquals(DebugGatePhase.IDLE, gate.status.value.phase)
        } finally { firstAttempt.cancelAndJoin() }
    }

    @Test fun cancelledOldWaiterCannotClearANewlyArmedAttempt() = runBlocking {
        val gate = DebugSendGate().apply { arm() }
        val oldAttempt = async(start = CoroutineStart.UNDISPATCHED) { gate.awaitBeforeSend(Metric.HEART) }
        assertEquals(DebugGatePhase.WAITING, gate.status.value.phase)
        gate.reset()
        gate.arm()
        try { withTimeout(5_000) { oldAttempt.await() }; fail("Old attempt must remain cancelled") }
        catch (_: CancellationException) { }
        assertEquals(DebugGatePhase.ARMED, gate.status.value.phase)

        val newAttempt = async { gate.awaitBeforeSend(Metric.SLEEP) }
        try {
            assertEquals(Metric.SLEEP, waiting(gate).metric)
            gate.release()
            withTimeout(5_000) { newAttempt.await() }
            assertEquals(DebugGatePhase.IDLE, gate.status.value.phase)
        } finally { newAttempt.cancelAndJoin(); oldAttempt.cancelAndJoin() }
    }

    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    @Test fun projectionHashesExactUtf8BodiesAndPreservesOrderWithoutRawPrivateFields() {
        val privateRecordId = "synthetic-private-record-id"
        val privateMeasurement = "合成心率值173.125"
        val operations = listOf(
            """{"op":"upsert","record":{"id":"$privateRecordId","value":"$privateMeasurement"}}""",
            cloudDelete("another-private-record")
        )
        val batches = pendingBatches(Metric.HEART, 4, operations, maxOperations = 1)
        val state = SyncState(cursor = "private-old-游标", sequence = 5,
            lastSuccessfulAt = "2026-01-01T00:00:00Z",
            pending = PendingPage(batches, 1, "private-next-游标", true))
        val projected = syncStateDiagnosticJson(Metric.HEART, state)
        assertEquals(setOf("metric", "sequence", "lastSuccessfulAt", "cursorSha256", "pending"), projected.keySet())
        assertEquals("HEART", projected["metric"].asString)
        assertEquals(5L, projected["sequence"].asLong)
        assertEquals(sha256(state.cursor!!), projected["cursorSha256"].asString)
        val page = projected.getAsJsonObject("pending")
        assertEquals(1, page["acknowledged"].asInt)
        assertEquals(2, page["totalBatches"].asInt)
        assertEquals(sha256(state.pending!!.nextCursor), page["nextCursorSha256"].asString)
        assertTrue(page["hasMore"].asBoolean)
        val summaries = page.getAsJsonArray("batches")
        assertEquals(2, summaries.size())
        batches.forEachIndexed { index, batch ->
            val summary = summaries[index].asJsonObject
            assertEquals(setOf("batchId", "sequence", "bodySha256", "operationCount"), summary.keySet())
            assertEquals(batch.batchId, summary["batchId"].asString)
            assertEquals(batch.sequence, summary["sequence"].asLong)
            assertEquals(sha256(batch.body), summary["bodySha256"].asString)
            assertEquals(1, summary["operationCount"].asInt)
        }
        val serialized = projected.toString()
        for (secret in listOf(privateRecordId, privateMeasurement, "another-private-record", state.cursor!!, state.pending.nextCursor)) {
            assertFalse("Diagnostic projection leaked private input", serialized.contains(secret))
        }
        val empty = syncStateDiagnosticJson(Metric.SLEEP, SyncState())
        assertTrue(empty["cursorSha256"].isJsonNull)
        assertTrue(empty["lastSuccessfulAt"].isJsonNull)
        assertTrue(empty["pending"].isJsonNull)
        val checkpoint = syncStateDiagnosticJson(Metric.SLEEP, SyncState(pending = PendingPage(
            pendingBatches(Metric.SLEEP, 0, emptyList()), 0, "next", false)))
        assertEquals(0, checkpoint.getAsJsonObject("pending").getAsJsonArray("batches")[0]
            .asJsonObject["operationCount"].asInt)
        assertEquals(empty, JsonParser.parseString(empty.toString()))
    }

    @Test fun invalidStoredValuesNeverEscapeThroughProjectionExceptionMessagesOrCauses() {
        val privateMarker = "DO-NOT-EXPOSE-private-payload"
        val validBatch = pendingBatches(Metric.HEART, 0, emptyList()).single()
        val base = SyncState(pending = PendingPage(listOf(validBatch), 0, "private-cursor", false))
        val invalid = listOf(
            base.copy(pending = base.pending!!.copy(batches = listOf(validBatch.copy(batchId = privateMarker)))),
            base.copy(pending = base.pending!!.copy(acknowledged = 1)),
            base.copy(pending = base.pending!!.copy(batches = listOf(validBatch.copy(body = "{\"operations\":$privateMarker}")))),
            base.copy(lastSuccessfulAt = privateMarker),
            base.copy(sequence = -1)
        )
        invalid.forEach { state ->
            val error = assertThrows(IllegalStateException::class.java) { syncStateDiagnosticJson(Metric.HEART, state) }
            assertEquals("Invalid diagnostic sync state", error.message)
            assertFalse(error.toString().contains(privateMarker))
            assertNull(error.cause)
        }
    }
}
