package dev.healthaibridge

import dev.healthaibridge.sync.*
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.nio.file.Files
import javax.crypto.KeyGenerator

/** Synthetic JVM fault injection; not evidence of Android process-death acceptance. */
class SyncRecoveryTest {
    private fun receipt(batch: PendingBatch) =
        Receipt(batch.batchId, batch.sequence, true, "2026-01-01T00:00:00Z")

    private suspend fun withDiskStore(test: suspend (() -> EncryptedSyncStore) -> Unit) {
        val directory = Files.createTempDirectory("health-bridge-recovery-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try { test { EncryptedSyncStore(directory, key) } }
        finally {
            directory.listFiles()?.forEach { check(it.isFile && it.delete()) }
            check(directory.delete())
        }
    }

    @Test fun lostReceiptAfterPartialPageResumesExactDiskBatchWithoutRereading() = runBlocking {
        withDiskStore { openStore ->
            var reads = 0
            val source = SyncPageSource { _, _ ->
                reads++
                SyncPage((1..201).map { cloudDelete("synthetic-$it") }, "next", false)
            }
            val sent = mutableListOf<PendingBatch>()
            val serverReceipts = mutableMapOf<String, Receipt>()
            val transport = SyncTransport { batch ->
                sent += batch
                val savedReceipt = serverReceipts.getOrPut(batch.batchId) { receipt(batch) }
                if (sent.size == 2) throw IOException("Synthetic lost receipt")
                savedReceipt
            }
            assertEquals(SyncOutcome.RETRY_REQUIRED,
                SyncEngine(openStore(), source, transport, SyncConsent { true }).run(Metric.HEART))
            val interrupted = openStore().load(Metric.HEART)
            assertNull(interrupted.cursor)
            assertNull(interrupted.lastSuccessfulAt)
            assertEquals(1L, interrupted.sequence)
            assertEquals(1, interrupted.pending!!.acknowledged)
            assertEquals(sent[1], interrupted.pending.batches[1])

            assertEquals(SyncOutcome.COMPLETE,
                SyncEngine(openStore(), source, transport, SyncConsent { true }).run(Metric.HEART))
            assertEquals(sent[1], sent[2]) // ID, sequence and complete body, including operation order.
            assertEquals(1, reads)
            assertEquals(3, serverReceipts.size)
            val restored = openStore().load(Metric.HEART)
            assertEquals("next", restored.cursor)
            assertEquals(3L, restored.sequence)
            assertNull(restored.pending)
        }
    }

    @Test fun cancellingInFlightSendKeepsDurablePendingAndReleasesLockForResume() = runBlocking {
        withDiskStore { openStore ->
            val original = SyncState(cursor = "previous", sequence = 7,
                lastSuccessfulAt = "2025-12-31T00:00:00Z")
            openStore().save(Metric.SLEEP, original)
            var reads = 0
            val source = SyncPageSource { _, cursor ->
                reads++
                assertEquals("previous", cursor)
                SyncPage(listOf(cloudDelete("synthetic-sleep")), "next", false)
            }
            val enteredSend = CompletableDeferred<PendingBatch>()
            val job = launch {
                SyncEngine(openStore(), source, SyncTransport { batch ->
                    // An independent store instance must see the pending batch before any send.
                    assertEquals(batch, openStore().load(Metric.SLEEP).pending!!.batches.single())
                    enteredSend.complete(batch)
                    awaitCancellation()
                }, SyncConsent { true }).run(Metric.SLEEP)
                fail("Cancellation must propagate")
            }
            val interruptedBatch = try { withTimeout(5_000) { enteredSend.await() } }
                finally { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
            val interrupted = openStore().load(Metric.SLEEP)
            assertEquals(original, interrupted.copy(pending = null))
            assertEquals(0, interrupted.pending!!.acknowledged)

            val retried = mutableListOf<PendingBatch>()
            assertEquals(SyncOutcome.COMPLETE, withTimeout(5_000) {
                SyncEngine(openStore(), source, SyncTransport { batch ->
                    retried += batch; receipt(batch)
                }, SyncConsent { true }).run(Metric.SLEEP)
            })
            assertEquals(listOf(interruptedBatch), retried)
            assertEquals(1, reads)
            val restored = openStore().load(Metric.SLEEP)
            assertEquals("next", restored.cursor)
            assertEquals(8L, restored.sequence)
            assertNull(restored.pending)
        }
    }

    @Test fun localCheckpointFailureAfterCloudCommitReplaysDiskBatchAndOriginalReceipt() = runBlocking {
        withDiskStore { openStore ->
            val disk = openStore()
            val failingCheckpoint = object : SyncStore {
                override val mutex get() = disk.mutex
                override suspend fun load(metric: Metric) = disk.load(metric)
                override suspend fun save(metric: Metric, state: SyncState) {
                    if (state.pending == null) throw IOException("Synthetic checkpoint failure")
                    disk.save(metric, state)
                }
            }
            var reads = 0
            val source = SyncPageSource { _, _ ->
                reads++; SyncPage(listOf(cloudDelete("synthetic-heart")), "next", false)
            }
            val sent = mutableListOf<PendingBatch>()
            val serverReceipts = mutableMapOf<String, Receipt>()
            val transport = SyncTransport { batch ->
                sent += batch
                serverReceipts.getOrPut(batch.batchId) { receipt(batch) }
            }
            assertEquals(SyncOutcome.RETRY_REQUIRED,
                SyncEngine(failingCheckpoint, source, transport, SyncConsent { true }).run(Metric.HEART))
            val interrupted = openStore().load(Metric.HEART)
            assertNull(interrupted.cursor)
            assertEquals(0L, interrupted.sequence)
            assertNull(interrupted.lastSuccessfulAt)
            assertEquals(sent.single(), interrupted.pending!!.batches.single())

            assertEquals(SyncOutcome.COMPLETE,
                SyncEngine(openStore(), source, transport, SyncConsent { true }).run(Metric.HEART))
            assertEquals(sent[0], sent[1])
            assertEquals(1, reads)
            assertEquals(1, serverReceipts.size)
            val restored = openStore().load(Metric.HEART)
            assertEquals("next", restored.cursor)
            assertEquals(serverReceipts.values.single().committedAt, restored.lastSuccessfulAt)
            assertNull(restored.pending)
        }
    }
}
