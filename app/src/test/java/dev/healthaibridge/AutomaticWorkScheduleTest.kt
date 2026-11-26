package dev.healthaibridge

import androidx.work.WorkInfo
import dev.healthaibridge.sync.automaticWorkSchedule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

class AutomaticWorkScheduleTest {
    private val eligibleAt = Instant.parse("2026-01-03T06:00:00Z")
    private val sixHours = TimeUnit.HOURS.toMillis(6)

    private fun work(
        state: WorkInfo.State,
        attempts: Int = 9,
        next: Long = eligibleAt.toEpochMilli(),
        periodic: Boolean = true,
    ) = WorkInfo(
        id = UUID.randomUUID(),
        state = state,
        tags = emptySet(),
        runAttemptCount = attempts,
        periodicityInfo = if (periodic) WorkInfo.PeriodicityInfo(sixHours, sixHours) else null,
        nextScheduleTimeMillis = next,
    )

    @Test fun queuedRetryKeepsTheSchedulerTimeAndAttemptCount() {
        val current = work(WorkInfo.State.ENQUEUED)
        val schedule = checkNotNull(automaticWorkSchedule(listOf(work(WorkInfo.State.CANCELLED), current)))
        assertEquals(WorkInfo.State.ENQUEUED, schedule.state)
        assertEquals(9, schedule.runAttemptCount)
        assertEquals(eligibleAt, schedule.earliestEligibleAt)
    }

    @Test fun unknownRunningAndBlockedSchedulesDoNotInventAnEligibilityTime() {
        for (invalid in listOf(Long.MAX_VALUE, 0L, -1L)) {
            val schedule = checkNotNull(automaticWorkSchedule(listOf(work(WorkInfo.State.ENQUEUED, next = invalid))))
            assertNull(schedule.earliestEligibleAt)
        }
        for (state in listOf(WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED)) {
            val schedule = checkNotNull(automaticWorkSchedule(listOf(work(state))))
            assertEquals(state, schedule.state)
            assertNull(schedule.earliestEligibleAt)
        }
    }

    @Test fun onlyAnUnambiguousActivePeriodicTaskIsDisplayed() {
        val ended = work(WorkInfo.State.SUCCEEDED)
        val oneTime = work(WorkInfo.State.ENQUEUED, periodic = false)
        val active = work(WorkInfo.State.ENQUEUED, attempts = 0)
        assertNull(automaticWorkSchedule(listOf(ended, oneTime)))
        assertEquals(0, automaticWorkSchedule(listOf(ended, oneTime, active))?.runAttemptCount)
        assertNull(automaticWorkSchedule(listOf(active, work(WorkInfo.State.RUNNING))))
    }
}
