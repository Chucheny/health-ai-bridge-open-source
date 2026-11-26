package dev.healthaibridge

import androidx.work.Data
import androidx.work.WorkInfo
import dev.healthaibridge.sync.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class DebugBackgroundProjectionTest {
    private val privateMarker = "SYNTHETIC-PRIVATE-MUST-NOT-ESCAPE"
    private val eligible = 1_767_225_600_000L
    private fun info(state: WorkInfo.State, next: Long = eligible) = WorkInfo(
        id = UUID.fromString("11111111-1111-4111-8111-111111111111"),
        state = state,
        tags = setOf(privateMarker),
        outputData = Data.Builder().putString("secret", privateMarker).build(),
        progress = Data.Builder().putString("health", privateMarker).build(),
        runAttemptCount = 3,
        nextScheduleTimeMillis = next,
    )

    @Test fun settingsProjectionOmitsIdentityCredentialsSelectionsAndForegroundSuccess() {
        val settings = CloudSettings(
            configuration = DeviceConfiguration(1, "https://private.invalid", privateMarker,
                privateMarker, privateMarker, listOf(privateMarker)),
            selected = setOf(privateMarker), pendingAction = privateMarker,
            lastAttempt = privateMarker, lastSuccess = privateMarker,
            automaticEnabled = true, paused = false, automaticStatus = "retry",
            lastAutomaticAttempt = "2026-01-01T00:00:00Z",
            lastAutomaticSuccess = "2025-12-31T00:00:00Z",
        )
        val value = automaticStateDiagnosticJson(settings)
        assertEquals(setOf("enabled", "paused", "status", "lastAttempt", "lastCompleteSuccess"), value.keySet())
        assertTrue(value["enabled"].asBoolean)
        assertFalse(value["paused"].asBoolean)
        assertEquals("retry", value["status"].asString)
        assertEquals(settings.lastAutomaticSuccess, value["lastCompleteSuccess"].asString)
        assertFalse(value.toString().contains(privateMarker))
        val defaults = automaticStateDiagnosticJson(CloudSettings())
        assertFalse(defaults["enabled"].asBoolean)
        assertTrue(defaults["lastAttempt"].isJsonNull)
        assertTrue(defaults["lastCompleteSuccess"].isJsonNull)
        assertTrue(defaults["status"].isJsonNull)
    }

    @Test fun invalidAutomaticMetadataHasFixedExceptionWithoutPrivateParserInput() {
        for (settings in listOf(CloudSettings(automaticStatus = privateMarker),
            CloudSettings(lastAutomaticAttempt = privateMarker),
            CloudSettings(lastAutomaticSuccess = privateMarker))) {
            val error = assertThrows(IllegalStateException::class.java) { automaticStateDiagnosticJson(settings) }
            assertEquals("Invalid diagnostic automatic state", error.message)
            assertNull(error.cause)
            assertFalse(error.toString().contains(privateMarker))
        }
    }

    @Test fun workProjectionExcludesDataAndTagsAndPreservesAttemptAndEligibilityMetadata() {
        val value = workStateDiagnosticJson(info(WorkInfo.State.ENQUEUED), 7)
        assertEquals(setOf("workId", "state", "runAttemptCount", "earliestEligibleAt", "previousStopReason"), value.keySet())
        assertEquals("ENQUEUED", value["state"].asString)
        assertEquals(3, value["runAttemptCount"].asInt)
        assertEquals("2026-01-01T00:00:00Z", value["earliestEligibleAt"].asString)
        assertEquals(7, value["previousStopReason"].asInt)
        assertFalse(value.toString().contains(privateMarker))
        assertTrue(workStateDiagnosticJson(info(WorkInfo.State.ENQUEUED), null)["previousStopReason"].isJsonNull)
    }

    @Test fun runningFinishedBlockedOrUnsetSchedulesNeverPretendToHaveAFutureExecutionTime() {
        for (state in WorkInfo.State.entries.filter { it != WorkInfo.State.ENQUEUED }) {
            assertTrue(workStateDiagnosticJson(info(state), null)["earliestEligibleAt"].isJsonNull)
        }
        for (unset in listOf(Long.MAX_VALUE, -1L)) {
            assertTrue(workStateDiagnosticJson(info(WorkInfo.State.ENQUEUED, unset), null)["earliestEligibleAt"].isJsonNull)
        }
    }
}
