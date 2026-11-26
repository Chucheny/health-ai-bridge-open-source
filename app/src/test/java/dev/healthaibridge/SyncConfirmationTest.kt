package dev.healthaibridge

import dev.healthaibridge.sync.SyncConfirmation
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class SyncConfirmationTest {
    private val now = Instant.parse("2026-11-07T12:00:00Z")

    @Test fun missingReceiptDoesNotClaimCompletion() {
        assertTrue(SyncConfirmation.describe(null, now).contains("尚无完整云端确认"))
    }

    @Test fun malformedAndFutureReceiptsCannotLookRecent() {
        assertTrue(SyncConfirmation.describe("invalid", now).contains("时间不可用"))
        assertTrue(SyncConfirmation.describe("", now).contains("时间不可用"))
        assertTrue(SyncConfirmation.describe("2026-11-07T12:00:00.000000001Z", now).contains("晚于"))
    }

    @Test fun remindersStartAtTwelveHoursWithoutRoundingEarly() {
        val justBefore = SyncConfirmation.describe("2026-11-07T00:00:00.000000001Z", now)
        assertTrue(justBefore.contains("11小时59分钟"))
        assertFalse(justBefore.contains("提醒线"))
        assertTrue(SyncConfirmation.describe("2026-11-07T00:00:00Z", now).contains("提醒线"))
    }

    @Test fun elapsedTimeUsesInstantsAcrossTimezoneOffsets() {
        assertEquals(SyncConfirmation.describe("2026-11-07T06:30:00Z", now),
            SyncConfirmation.describe("2026-11-07T14:30:00+08:00", now))
        assertTrue(SyncConfirmation.describe("2026-11-07T06:30:00Z", now).contains("5小时30分钟"))
    }

    @Test fun recentReceiptUsesMinutesIncludingExactNow() {
        assertTrue(SyncConfirmation.describe(now.toString(), now).contains("不足1分钟"))
        assertTrue(SyncConfirmation.describe("2026-11-07T11:01:00Z", now).contains("59分钟"))
        assertTrue(SyncConfirmation.describe("2026-11-07T11:00:00Z", now).contains("1小时0分钟"))
    }

    @Test fun oldReceiptKeepsElapsedTimeAndOffersManualContinuation() {
        val text = SyncConfirmation.describe("2026-11-01T12:00:00Z", now)
        assertTrue(text.contains("144小时0分钟"))
        assertTrue(text.contains("立即同步"))
    }
}
