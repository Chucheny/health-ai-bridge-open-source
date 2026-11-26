package dev.healthaibridge

import androidx.health.connect.client.records.SleepSessionRecord
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Duration
import java.time.Instant

// Synthetic fixtures exist only in JVM tests, never in the installed app.
class DataIntegrityTest {
    private val start = Instant.parse("2026-11-01T00:00:00Z")
    private fun time(seconds: Long) = start.plusSeconds(seconds)
    private fun point(second: Long, origin: String = "source.a") = HeartPoint(time(second), 70 + second % 30, origin, "r", second.toInt())

    @Test fun paginationReadsEveryPageIncludingEmptyTerminalToken() = runBlocking {
        val calls = mutableListOf<String?>()
        val result = readAllPages { token ->
            calls += token
            when (token) {
                null -> RecordPage((1..1000).toList(), "page2")
                "page2" -> RecordPage((1001..2000).toList(), "page3")
                else -> RecordPage(listOf(2001), "")
            }
        }
        assertEquals(2001, result.records.size)
        assertEquals(listOf(null, "page2", "page3"), calls)
        assertNull(result.error)
    }

    @Test fun emptyQueryIsCompleteRatherThanFailure() = runBlocking {
        val result = readAllPages<Int> { RecordPage(emptyList(), null) }
        assertTrue(result.records.isEmpty()); assertNull(result.error); assertEquals(1, result.pages)
    }

    @Test fun laterPageFailureRetainsEarlierRecordsAndError() = runBlocking {
        val result = readAllPages { token -> if (token == null) RecordPage(listOf(7,8), "next") else throw IOException("quota") }
        assertEquals(listOf(7,8), result.records); assertEquals(1, result.pages); assertTrue(result.error is IOException)
    }

    @Test fun repeatedTokenStopsAndMarksIncomplete() = runBlocking {
        val result = readAllPages { RecordPage(listOf(1), "repeat") }
        assertEquals(2, result.pages); assertTrue(result.error is IllegalStateException)
    }

    @Test fun cancellationDoesNotBecomeEmptySuccessfulData() = runBlocking {
        try { readAllPages<Int> { throw CancellationException("background") }; fail("Must propagate cancellation") }
        catch (_: CancellationException) { }
    }

    @Test fun associationKeepsEveryActualPointAndEveryOriginWithinHalfOpenWindow() {
        val points = listOf(point(-1), point(0), point(0,"source.b"), point(1), point(2), point(3))
        val matched = heartWithin(points, time(0), time(3))
        assertEquals(4, matched.size)
        assertEquals(setOf("source.a","source.b"), matched.map { it.origin }.toSet())
        assertFalse(matched.any { it.time == time(3) })
    }

    @Test fun missingSleepStagesNeverBecomeDurationFromSessionSpan() {
        assertNull(asleepDuration(emptyList()))
        assertNull(asleepDuration(listOf(StageSpan(time(0), time(10), SleepSessionRecord.STAGE_TYPE_UNKNOWN))))
    }

    @Test fun sleepAsleepDurationExcludesAwakeAndMergesOverlaps() {
        val stages = listOf(
            StageSpan(time(0), time(100), SleepSessionRecord.STAGE_TYPE_LIGHT),
            StageSpan(time(90), time(150), SleepSessionRecord.STAGE_TYPE_DEEP),
            StageSpan(time(150), time(180), SleepSessionRecord.STAGE_TYPE_AWAKE),
            StageSpan(time(180), time(200), SleepSessionRecord.STAGE_TYPE_REM),
        )
        assertEquals(Duration.ofSeconds(170), asleepDuration(stages))
    }

    @Test fun crossingWorkoutIntervalsAreNotProratedIntoTotals() {
        assertFalse(containedIn(time(-1),time(5),time(0),time(10)))
        assertFalse(containedIn(time(5),time(11),time(0),time(10)))
        assertTrue(containedIn(time(0),time(10),time(0),time(10)))
    }

    @Test fun chartNeverJoinsAcrossSourcesOrLongGaps() {
        assertEquals(1, connectedHeartPairs(listOf(point(0),point(1),point(602),point(603,"other"))).size)
    }
}
