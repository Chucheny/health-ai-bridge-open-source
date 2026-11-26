package dev.healthaibridge.sync

import java.time.Duration
import java.time.Instant

/** A local receipt-age hint, never a claim about the newest Health Connect record. */
object SyncConfirmation {
    private val reminderAfter = Duration.ofHours(12)

    fun describe(lastSuccess: String?, now: Instant): String {
        if (lastSuccess == null) return "尚无完整云端确认，暂不能确认同步是否完成"
        val confirmed = try { Instant.parse(lastSuccess) }
        catch (_: Exception) { return "确认时间不可用，请核对设备时间后刷新状态" }
        if (confirmed > now) return "确认时间晚于当前设备时间，请核对设备时间后刷新状态"
        val age = Duration.between(confirmed, now)
        val minutes = age.toMinutes()
        val elapsed = when {
            minutes == 0L -> "不足1分钟"
            minutes < 60L -> "${minutes}分钟"
            else -> "${minutes / 60}小时${minutes % 60}分钟"
        }
        return if (age >= reminderAfter) {
            "距上次完整确认${elapsed}，已达12小时提醒线。需要最新分析时，请保持本页前台并点击立即同步；如有错误，按同步提示处理"
        } else "距上次完整确认${elapsed}"
    }
}
