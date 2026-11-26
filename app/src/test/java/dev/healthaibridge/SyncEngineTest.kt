package dev.healthaibridge

import com.google.gson.JsonParser
import dev.healthaibridge.sync.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.nio.file.Files
import javax.crypto.KeyGenerator

class SyncEngineTest {
    private class Store : SyncStore {
        override val mutex = Mutex()
        var state = SyncState()
        override suspend fun load(metric: Metric) = state
        override suspend fun save(metric: Metric, state: SyncState) { this.state = state }
    }
    private fun operation(id: Int) = cloudDelete("synthetic-$id")
    private fun receipt(b: PendingBatch) = Receipt(b.batchId, b.sequence, true, "2026-01-01T00:00:00Z")
    @Test fun cursorMovesOnlyAfterAllPageBatchesAreConfirmedAndSurvivesRestart() = runBlocking {
        val store = Store(); var reads = 0; var calls = 0; var failed: PendingBatch? = null
        val source = SyncPageSource { _, _ -> reads++; SyncPage((1..201).map(::operation), "next", false) }
        val first = SyncEngine(store, source, SyncTransport { b ->
            calls++; if (calls == 2) { failed = b; throw IOException() }; receipt(b)
        }, SyncConsent { true })
        assertEquals(SyncOutcome.RETRY_REQUIRED, first.run(Metric.HEART))
        assertNull(store.state.cursor); assertEquals(1L, store.state.sequence)
        assertEquals(1, store.state.pending!!.acknowledged)
        val sent = mutableListOf<PendingBatch>()
        val restarted = SyncEngine(store, source, SyncTransport { sent += it; receipt(it) }, SyncConsent { true })
        assertEquals(SyncOutcome.COMPLETE, restarted.run(Metric.HEART))
        assertEquals(failed, sent.first()); assertEquals(1, reads)
        assertEquals("next", store.state.cursor); assertEquals(3L, store.state.sequence); assertNull(store.state.pending)
    }
    @Test fun lostResponseRetriesExactlyTheSameBodyAndId() = runBlocking {
        val store = Store(); val sent = mutableListOf<PendingBatch>()
        val source = SyncPageSource { _, _ -> SyncPage(listOf(operation(1)), "new", false) }
        val engine = SyncEngine(store, source, SyncTransport { b -> sent += b; if (sent.size == 1) throw IOException(); receipt(b) }, SyncConsent { true })
        assertEquals(SyncOutcome.RETRY_REQUIRED, engine.run(Metric.SLEEP)); assertNull(store.state.cursor)
        assertEquals(SyncOutcome.COMPLETE, engine.run(Metric.SLEEP)); assertEquals(sent[0], sent[1])
    }
    @Test fun allPagesIncludingEmptyChangesPageAreAcknowledged() = runBlocking {
        val store = Store(); val cursors = mutableListOf<String?>(); var sent = 0
        val engine = SyncEngine(store, SyncPageSource { _, cursor -> cursors += cursor
            if (cursor == null) SyncPage(listOf(operation(1)), "p2", true) else SyncPage(emptyList(), "done", false)
        }, SyncTransport { sent++; receipt(it) }, SyncConsent { true })
        assertEquals(SyncOutcome.COMPLETE, engine.run(Metric.HEART)); assertEquals(listOf(null,"p2"), cursors)
        assertEquals(2, sent); assertEquals("done", store.state.cursor)
    }
    @Test fun revocationStopsEvenPreviouslyPersistedPendingData() = runBlocking {
        val store = Store(); var allowed = true; var sent = 0
        val engine = SyncEngine(store, SyncPageSource { _, _ -> SyncPage(listOf(operation(1)), "next", false) },
            SyncTransport { sent++; throw IOException() }, SyncConsent { allowed })
        engine.run(Metric.HEART); allowed = false
        assertEquals(SyncOutcome.CONSENT_REQUIRED, engine.run(Metric.HEART)); assertEquals(1, sent); assertNull(store.state.cursor)
    }
    @Test fun tokenExpiryIsVisibleAndDoesNotChangeCheckpoint() = runBlocking {
        val store = Store(); store.state = SyncState(cursor = "expired", sequence = 7)
        val engine = SyncEngine(store, SyncPageSource { _, _ -> throw ChangesExpired() }, SyncTransport { receipt(it) }, SyncConsent { true })
        assertEquals(SyncOutcome.RECONCILIATION_REQUIRED, engine.run(Metric.HEART))
        assertEquals("expired", store.state.cursor); assertEquals(7L, store.state.sequence)
    }
    @Test fun wrongCloudReceiptCannotAdvanceCursor() = runBlocking {
        val store = Store()
        val engine = SyncEngine(store, SyncPageSource { _, _ -> SyncPage(emptyList(), "next", false) },
            SyncTransport { receipt(it).copy(batchId = "wrong") }, SyncConsent { true })
        assertEquals(SyncOutcome.CONFLICT, engine.run(Metric.HEART)); assertNull(store.state.cursor)
    }
    @Test fun cancellationPropagatesWithoutSuccess() = runBlocking {
        val store = Store()
        val engine = SyncEngine(store, SyncPageSource { _, _ -> throw CancellationException() }, SyncTransport { receipt(it) }, SyncConsent { true })
        try { engine.run(Metric.HEART); fail("Must propagate") } catch (_: CancellationException) { }
        assertNull(store.state.lastSuccessfulAt)
    }
    @Test fun requestSplittingUsesUtf8BytesAndPreservesEveryOperation() {
        val operations = (1..15).map { cloudDelete("合成-$it-" + "字".repeat(60)) }
        val batches = pendingBatches(Metric.HEART, 0, operations, maxBytes = 700)
        assertTrue(batches.size > 1)
        assertTrue(batches.all { it.body.toByteArray(Charsets.UTF_8).size <= 700 })
        assertEquals(15, batches.sumOf { JsonParser.parseString(it.body).asJsonObject["operations"].asJsonArray.size() })
        assertEquals((1L..batches.size.toLong()).toList(), batches.map { it.sequence })
    }
    @Test fun encryptedQueuePersistsAcrossInstancesAndDetectsTampering() = runBlocking {
        val dir = Files.createTempDirectory("health-bridge-synthetic-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try {
            val state = SyncState(cursor = "private-cursor", pending = PendingPage(pendingBatches(Metric.HEART, 0, listOf(operation(1))), 0, "next", false))
            EncryptedSyncStore(dir, key).save(Metric.HEART, state)
            assertEquals(state, EncryptedSyncStore(dir, key).load(Metric.HEART))
            val file = dir.resolve("HEART.bin"); val bytes = file.readBytes()
            assertFalse(bytes.toString(Charsets.UTF_8).contains("private-cursor"))
            bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); file.writeBytes(bytes)
            try { EncryptedSyncStore(dir, key).load(Metric.HEART); fail("Must reject corrupt state") }
            catch (_: javax.crypto.AEADBadTagException) { }
        } finally { dir.listFiles()?.forEach { it.delete() }; dir.delete() }
    }
    @Test fun retryPolicySeparatesNetworkAndServerFailureFromAuthOrInvalidPayload() {
        listOf(408,429,500,503).forEach { assertTrue(retryableHttpStatus(it)) }
        listOf(200,400,401,403,409,413,415).forEach { assertFalse(retryableHttpStatus(it)) }
    }
    @Test fun longerCursorCycleFailsVisiblyWithoutClaimingCompletion() = runBlocking {
        val store = Store(); store.state = SyncState(cursor = "a")
        val engine = SyncEngine(store, SyncPageSource { _, cursor -> SyncPage(emptyList(), if (cursor == "a") "b" else "a", true) },
            SyncTransport { receipt(it) }, SyncConsent { true })
        try { engine.run(Metric.HEART); fail("Must reject cycle") } catch (_: IllegalStateException) { }
        assertEquals(2L, store.state.sequence)
    }
    @Test fun runtimeHealthPermissionRevocationReturnsConsentRequired() = runBlocking {
        val store = Store()
        val engine = SyncEngine(store, SyncPageSource { _, _ -> throw SecurityException() }, SyncTransport { receipt(it) }, SyncConsent { true })
        assertEquals(SyncOutcome.CONSENT_REQUIRED, engine.run(Metric.HEART)); assertNull(store.state.cursor)
    }
}
