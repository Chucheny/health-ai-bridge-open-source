package dev.healthaibridge

import dev.healthaibridge.sync.*
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator
import java.io.IOException

class AutomaticSyncControlTest {
    private class Memory(var value: CloudSettings = CloudSettings(
        selected=setOf("HEART"),lastSuccess="2026-01-01T00:00:00Z")) : CloudSettingsStore {
        var writes=0
        override suspend fun load()=value
        override suspend fun update(transform: (CloudSettings)->CloudSettings): CloudSettings {
            writes++
            return transform(value).also { value=it }
        }
    }

    @Test fun preCancelledCallsDoNotWriteOrSchedule() = runBlocking {
        val memory=Memory(); var reconciliations=0
        val control=AutomaticSyncControl(memory) { reconciliations++ }
        val job=launch(start=CoroutineStart.UNDISPATCHED) {
            currentCoroutineContext().cancel()
            control.update { it.copy(automaticEnabled=true) }
        }
        job.join()
        assertTrue(job.isCancelled)
        assertEquals(0,memory.writes);assertEquals(0,reconciliations)
    }

    @Test fun cancelWhileReconcilingFinishesAndPropagatesCancellation() = runBlocking {
        val memory=Memory();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        var confirmed=false
        val job=launch(start=CoroutineStart.UNDISPATCHED) {
            AutomaticSyncControl(memory) { entered.complete(Unit);release.await();confirmed=true }
                .update { it.copy(automaticEnabled=true) }
        }
        try {
            withTimeout(5000){entered.await()};job.cancel()
            assertFalse(job.isCompleted)
            release.complete(Unit);withTimeout(5000){job.join()}
            assertTrue(confirmed);assertTrue(job.isCancelled);assertTrue(memory.value.automaticEnabled)
            assertEquals("2026-01-01T00:00:00Z",memory.value.lastSuccess)
        } finally { release.complete(Unit);job.cancelAndJoin() }
    }

    @Test fun cancelledWaitingChangeNeverCommits() = runBlocking {
        val memory=Memory();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        val first=launch(start=CoroutineStart.UNDISPATCHED) {
            AutomaticSyncControl(memory) { entered.complete(Unit);release.await() }
                .update { it.copy(automaticEnabled=true) }
        }
        var second: Job?=null
        try {
            entered.await()
            val waiting=launch(start=CoroutineStart.UNDISPATCHED) {
                AutomaticSyncControl(memory) { error("Cancelled waiter must not schedule") }
                    .update { it.copy(automaticEnabled=false) }
            }
            second=waiting
            assertEquals(1,memory.writes)
            waiting.cancelAndJoin();release.complete(Unit);withTimeout(5000){first.join()}
            assertTrue(memory.value.automaticEnabled);assertEquals(1,memory.writes)
        } finally { release.complete(Unit);first.cancelAndJoin();second?.cancelAndJoin() }
    }

    @Test fun schedulerFailureDisablesBeforeRethrowingAndPreservesOtherFields() = runBlocking {
        val memory=Memory();val original=memory.value;val failure=IOException("synthetic")
        val seen=mutableListOf<Boolean>()
        val control=AutomaticSyncControl(memory) {
            seen+=memory.value.automaticEnabled
            if(memory.value.automaticEnabled)throw failure
        }
        try {control.update {it.copy(automaticEnabled=true)};fail("Scheduling must fail")}
        catch(actual: IOException){assertEquals(failure.javaClass,actual.javaClass);assertEquals(failure.message,actual.message)}
        assertEquals(listOf(true,false),seen)
        assertFalse(memory.value.automaticEnabled);assertEquals("rejected",memory.value.automaticStatus)
        assertEquals(original.selected,memory.value.selected);assertEquals(original.lastSuccess,memory.value.lastSuccess)
    }

    @Test fun storageFailureBeforeCommitStillLeavesAutomaticDisabled() = runBlocking {
        val memory=Memory(CloudSettings(automaticEnabled=true));val failure=IOException("synthetic storage")
        var failNext=true;var cancelled=false
        val store=object: CloudSettingsStore {
            override suspend fun load()=memory.load()
            override suspend fun update(transform: (CloudSettings)->CloudSettings): CloudSettings {
                if(failNext){failNext=false;throw failure}
                return memory.update(transform)
            }
        }
        try {
            AutomaticSyncControl(store) { assertFalse(memory.value.automaticEnabled);cancelled=true }
                .update { it.copy(automaticEnabled=false) }
            fail("Storage must fail")
        } catch(actual: IOException){assertEquals(failure.javaClass,actual.javaClass);assertEquals(failure.message,actual.message)}
        assertFalse(memory.value.automaticEnabled);assertTrue(cancelled)
    }

    @Test fun rollbackFailureKeepsOriginalErrorAndDoesNotDeclareSuccess() = runBlocking {
        val memory=Memory();val original=IOException("original synthetic");var calls=0
        try {
            AutomaticSyncControl(memory) {
                calls++
                if(calls==1)throw original else throw IllegalStateException("synthetic cleanup")
            }.update { it.copy(automaticEnabled=true) }
            fail("Must propagate original failure")
        } catch(actual: IOException){assertEquals(original.javaClass,actual.javaClass);assertEquals(original.message,actual.message)}
        assertEquals(2,calls);assertFalse(memory.value.automaticEnabled)
        assertEquals("2026-01-01T00:00:00Z",memory.value.lastSuccess)
    }

    @Test fun laterEnableWaitsForOldRollbackAndIsNotOverwritten() = runBlocking {
        val memory=Memory();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        var calls=0
        val control=AutomaticSyncControl(memory) {
            calls++
            if(calls==1){entered.complete(Unit);release.await();throw IOException("synthetic enqueue")}
        }
        val first=launch(start=CoroutineStart.UNDISPATCHED) {
            try {control.update {it.copy(automaticEnabled=true)};fail("First enable must fail")}
            catch (_: IOException) { }
        }
        var second: Deferred<CloudSettings>?=null
        try {
            entered.await()
            val waiting=async(start=CoroutineStart.UNDISPATCHED) {
                control.update {it.copy(automaticEnabled=true,automaticStatus="enabled")}
            }
            second=waiting
            assertFalse(waiting.isCompleted);assertEquals(1,memory.writes)
            release.complete(Unit)
            withTimeout(5000){first.join();waiting.await()}
            assertEquals(3,calls);assertTrue(memory.value.automaticEnabled)
            assertEquals("enabled",memory.value.automaticStatus)
        } finally { release.complete(Unit);first.cancelAndJoin();second?.cancelAndJoin() }
    }
    @Test fun committedEnableMustBeReconciledEvenWhenCallerIsCancelledDuringDiskWrite() = runBlocking {
        val directory=Files.createTempDirectory("bridge-control-cancellation").toFile()
        val key=KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val disk=EncryptedCloudSettings(directory,key)
        val entered=CompletableDeferred<Unit>(); val release=CountDownLatch(1)
        var reconciliations=0
        val original=CloudSettings(lastSuccess="2026-01-01T00:00:00Z")
        disk.save(original)
        val controlled=object: CloudSettingsStore {
            override suspend fun load()=disk.load()
            override suspend fun update(transform: (CloudSettings)->CloudSettings)=disk.update { current ->
                entered.complete(Unit)
                check(release.await(5,TimeUnit.SECONDS))
                transform(current)
            }
        }
        val job=launch {
            AutomaticSyncControl(controlled) {
                assertTrue(disk.load().automaticEnabled); reconciliations++
            }.update { it.copy(automaticEnabled=true,automaticStatus="enabled") }
        }
        try {
            withTimeout(5000){entered.await()}
            job.cancel(); release.countDown()
            withTimeout(5000){job.join()}
            assertTrue(job.isCancelled)
            assertTrue(disk.load().automaticEnabled)
            assertEquals("A committed enable must reach the scheduler",1,reconciliations)
            assertEquals(original.lastSuccess,disk.load().lastSuccess)
        } finally {
            release.countDown();job.cancelAndJoin()
            directory.listFiles()?.forEach { check(it.isFile && it.delete()) }
            check(directory.delete())
        }
    }
}
