package dev.healthaibridge

import com.google.gson.Gson
import dev.healthaibridge.sync.*
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class CloudSyncRunnerTest {
    private val config = DeviceConfiguration(1,"https://private.invalid",
        "11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222",
        "a".repeat(43),listOf("HeartRateRecord","SleepSessionRecord"))
    private val prior = "2026-01-01T00:00:00Z"
    private val next = "2026-01-02T00:00:00Z"
    private fun active() = CloudSettings(config,setOf("HEART","SLEEP"),false,lastSuccess=prior,
        automaticEnabled=true,lastAutomaticSuccess=prior)
    private class Memory(var value: CloudSettings): CloudSettingsStore {
        override suspend fun load() = value
        override suspend fun update(transform: (CloudSettings) -> CloudSettings): CloudSettings = transform(value).also { value=it }
    }
    private fun runner(store: Memory, allowed: suspend () -> Boolean = { true },
                       metricAllowed: suspend (Metric) -> Boolean = { true },
                       action: suspend (Metric,DeviceConfiguration,SyncConsent) -> SyncOutcome) =
        CloudSyncRunner(store,allowed,action,metricAllowed,now={next})

    @Test fun oldSettingsJsonCannotEnableAutomaticUploads() {
        val old = Gson().fromJson("""{"selected":[],"paused":false}""",CloudSettings::class.java)
        assertFalse(old.automaticEnabled)
        assertNull(old.lastAutomaticSuccess)
    }
    @Test fun disabledPausedUnpairedEmptyAndDestructiveSettingsNeverRunBackground() = runBlocking {
        for (s in listOf(active().copy(automaticEnabled=false),active().copy(paused=true),
            active().copy(configuration=null),active().copy(selected=emptySet()),active().copy(pendingAction="clear"))) {
            val memory=Memory(s)
            assertNull(runner(memory) {_,_,_->error("Must not read or send")}.run(true).outcome)
            assertEquals(prior,memory.value.lastSuccess)
        }
    }
    @Test fun unavailableBackgroundPermissionStopsWithoutReadingOrMarkingSuccess() = runBlocking {
        val memory=Memory(active())
        val result=runner(memory,allowed={false}) {_,_,_->error("Must not read")}.run(true)
        assertEquals(SyncOutcome.CONSENT_REQUIRED,result.outcome)
        assertFalse(memory.value.automaticEnabled)
        assertEquals("permission",memory.value.automaticStatus)
        assertEquals(prior,memory.value.lastAutomaticSuccess)
    }
    @Test fun completeRequiresEverySelectedTypeAndUpdatesBackgroundTimes() = runBlocking {
        val memory=Memory(active()); val seen=mutableListOf<Metric>()
        assertEquals(SyncOutcome.COMPLETE,runner(memory) {m,_,consent->
            assertTrue(consent.allowed(m)); seen+=m; SyncOutcome.COMPLETE
        }.run(true).outcome)
        assertEquals(listOf(Metric.HEART,Metric.SLEEP),seen)
        assertEquals(next,memory.value.lastAutomaticAttempt)
        assertEquals(next,memory.value.lastAutomaticSuccess)
        assertEquals(next,memory.value.lastSuccess)
    }
    @Test fun networkAndPagingRetryPreserveSuccessAndAutomaticConsent() = runBlocking {
        for (outcome in listOf(SyncOutcome.RETRY_REQUIRED,SyncOutcome.MORE_PENDING)) {
            val memory=Memory(active()); var calls=0
            assertEquals(outcome,runner(memory) {_,_,_->calls++;outcome}.run(true).outcome)
            assertEquals(1,calls); assertTrue(memory.value.automaticEnabled)
            assertEquals("retry",memory.value.automaticStatus)
            assertEquals(prior,memory.value.lastSuccess)
            assertEquals(prior,memory.value.lastAutomaticSuccess)
        }
    }
    @Test fun permanentFailuresDisableAutomaticWithoutRemovingSelectionOrCredentials() = runBlocking {
        for (outcome in listOf(SyncOutcome.CONSENT_REQUIRED,SyncOutcome.AUTHENTICATION_REQUIRED,
            SyncOutcome.CONFLICT,SyncOutcome.RECONCILIATION_REQUIRED,SyncOutcome.REJECTED)) {
            val memory=Memory(active())
            assertEquals(outcome,runner(memory) {_,_,_->outcome}.run(true).outcome)
            assertFalse(memory.value.automaticEnabled)
            assertEquals(setOf("HEART","SLEEP"),memory.value.selected)
            assertSame(config,memory.value.configuration)
            assertEquals(prior,memory.value.lastSuccess)
        }
    }
    @Test fun manualSyncWorksWithoutBackgroundPermissionAndCannotEnableAutomatic() = runBlocking {
        val memory=Memory(active().copy(paused=true,automaticEnabled=false))
        assertEquals(SyncOutcome.COMPLETE,runner(memory,allowed={false}) {m,_,c->
            assertTrue(c.allowed(m));SyncOutcome.COMPLETE
        }.run(false).outcome)
        assertFalse(memory.value.automaticEnabled)
        assertEquals(prior,memory.value.lastAutomaticSuccess)
        assertEquals(next,memory.value.lastSuccess)
    }
    @Test fun consentIsRecheckedDuringPendingSendAndDoesNotReviveDisabledWork() = runBlocking {
        val memory=Memory(active())
        val result=runner(memory) {m,_,consent->
            assertTrue(consent.allowed(m))
            memory.value=memory.value.copy(automaticEnabled=false,automaticStatus="disabled")
            assertFalse(consent.allowed(m)); SyncOutcome.CONSENT_REQUIRED
        }.run(true)
        assertEquals(SyncOutcome.CONSENT_REQUIRED,result.outcome)
        assertEquals("disabled",memory.value.automaticStatus)
        assertEquals(prior,memory.value.lastSuccess)
    }
    @Test fun permissionLostAfterLastReceiptCannotBecomeFullSuccess() = runBlocking {
        val memory=Memory(active()); var permitted=true
        val result=runner(memory,metricAllowed={permitted}) {m,_,_->
            if(m==Metric.SLEEP)permitted=false;SyncOutcome.COMPLETE
        }.run(true)
        assertEquals(SyncOutcome.CONSENT_REQUIRED,result.outcome)
        assertEquals(prior,memory.value.lastSuccess)
        assertFalse(memory.value.automaticEnabled)
    }
    @Test fun changedSelectionAfterReceiptCannotBeReportedAsComplete() = runBlocking {
        val memory=Memory(active())
        val result=runner(memory) {m,_,_->
            if(m==Metric.SLEEP)memory.value=memory.value.copy(selected=setOf("HEART"))
            SyncOutcome.COMPLETE
        }.run(true)
        assertEquals(SyncOutcome.CONSENT_REQUIRED,result.outcome)
        assertEquals(prior,memory.value.lastSuccess)
    }
    @Test fun cancellationReleasesSessionAndNeverMarksSuccess() = runBlocking {
        val memory=Memory(active()); val entered=CompletableDeferred<Unit>()
        val job=launch { runner(memory) {_,_,_->entered.complete(Unit);awaitCancellation()}.run(true) }
        withTimeout(5000){entered.await()}; job.cancelAndJoin()
        assertEquals(prior,memory.value.lastSuccess)
        assertEquals(SyncOutcome.COMPLETE,withTimeout(5000){runner(memory) {_,_,_->SyncOutcome.COMPLETE}.run(true)}.outcome)
    }
    @Test fun foregroundAndBackgroundSessionsNeverInterleaveAndWaitingRunReloadsPause() = runBlocking {
        val memory=Memory(active()); val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        var backgroundCalls=0
        val foreground=async(start=CoroutineStart.UNDISPATCHED) { runner(memory) {m,_,_->
            if(m==Metric.HEART){entered.complete(Unit);release.await()};SyncOutcome.COMPLETE
        }.run(false) }
        entered.await()
        val background=async(start=CoroutineStart.UNDISPATCHED) { runner(memory) {_,_,_->backgroundCalls++;SyncOutcome.COMPLETE}.run(true) }
        assertEquals(0,backgroundCalls)
        memory.value=memory.value.copy(paused=true,automaticEnabled=false);release.complete(Unit)
        withTimeout(5000){foreground.await();assertNull(background.await().outcome)}
        assertEquals(0,backgroundCalls); assertEquals(prior,memory.value.lastSuccess)
    }
}
