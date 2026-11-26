package dev.healthaibridge

import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import java.time.Duration
import java.time.Instant
import kotlin.reflect.KClass

enum class Metric(val label: String, val recordClass: KClass<out Record>, val core: Boolean = false) {
    HEART("心率", HeartRateRecord::class, true),
    SLEEP("睡眠", SleepSessionRecord::class, true),
    EXERCISE("运动", ExerciseSessionRecord::class, true),
    DISTANCE("距离", DistanceRecord::class, true),
    SPEED("速度", SpeedRecord::class, true),
    CALORIES("活动热量", ActiveCaloriesBurnedRecord::class, true),
    RESTING("静息心率", RestingHeartRateRecord::class),
    HRV("HRV（RMSSD）", HeartRateVariabilityRmssdRecord::class),
    STEPS("步数", StepsRecord::class),
    OXYGEN("血氧", OxygenSaturationRecord::class),
    RESPIRATORY("呼吸频率", RespiratoryRateRecord::class),
    WEIGHT("体重", WeightRecord::class),
    PRESSURE("血压", BloodPressureRecord::class),
    GLUCOSE("血糖", BloodGlucoseRecord::class),
    TEMPERATURE("体温", BodyTemperatureRecord::class);

    val permission: String get() = HealthPermission.getReadPermission(recordClass)
}

enum class ReadStatus(val label: String) {
    NOT_SELECTED("未选择"), NO_PERMISSION("未授权"), COMPLETE("读取完成"),
    PARTIAL("结果不完整"), ERROR("读取失败")
}

data class TypeResult(
    val metric: Metric,
    val status: ReadStatus,
    val records: List<Record> = emptyList(),
    val error: String? = null,
    val pages: Int = 0,
) {
    val origins: Map<String, Int> get() = records.groupingBy { it.metadata.dataOrigin.packageName }.eachCount()
    val countKnown: Boolean get() = status == ReadStatus.COMPLETE || status == ReadStatus.PARTIAL
}

data class Snapshot(val start: Instant, val end: Instant, val results: List<TypeResult>) {
    inline fun <reified T : Record> records(): List<T> = results.flatMap { it.records }.filterIsInstance<T>()
    fun heartPoints(): List<HeartPoint> = records<HeartRateRecord>().flatMap { record ->
        record.samples.mapIndexedNotNull { index, sample ->
            if (inWindow(sample.time, start, end)) HeartPoint(
                sample.time, sample.beatsPerMinute, record.metadata.dataOrigin.packageName,
                record.metadata.id, index
            ) else null
        }
    }.sortedWith(compareBy({ it.time }, { it.origin }, { it.recordId }, { it.sampleIndex }))
}

data class HeartPoint(val time: Instant, val bpm: Long, val origin: String, val recordId: String, val sampleIndex: Int)
data class StageSpan(val start: Instant, val end: Instant, val type: Int)
data class RoutePoint(val time: Instant, val latitude: Double, val longitude: Double,
                      val altitudeMeters: Double?, val horizontalAccuracyMeters: Double?)
enum class RouteStatus(val label: String) {
    NO_DATA("暂无路线记录"), CONSENT("路线需要单独授权"), READY("已读取路线"),
    DENIED("未返回路线（未授权、取消或无数据）"), ERROR("路线读取失败")
}
data class RouteRead(val status: RouteStatus, val points: List<RoutePoint> = emptyList(), val error: String? = null)

fun inWindow(time: Instant, start: Instant, end: Instant): Boolean = time >= start && time < end

fun heartWithin(points: List<HeartPoint>, start: Instant, end: Instant): List<HeartPoint> =
    points.filter { inWindow(it.time, start, end) }

// A source's interval totals cannot safely be prorated across workout boundaries.
fun containedIn(start: Instant, end: Instant, windowStart: Instant, windowEnd: Instant): Boolean =
    start >= windowStart && end <= windowEnd && end > start

fun durationUnion(spans: List<Pair<Instant, Instant>>): Duration {
    val sorted = spans.filter { it.second > it.first }.sortedBy { it.first }
    if (sorted.isEmpty()) return Duration.ZERO
    var start = sorted.first().first
    var end = sorted.first().second
    var total = Duration.ZERO
    for ((nextStart, nextEnd) in sorted.drop(1)) {
        if (nextStart <= end) { if (nextEnd > end) end = nextEnd }
        else { total = total.plus(Duration.between(start, end)); start = nextStart; end = nextEnd }
    }
    return total.plus(Duration.between(start, end))
}

fun stageName(type: Int): String = when (type) {
    SleepSessionRecord.STAGE_TYPE_DEEP -> "深睡"
    SleepSessionRecord.STAGE_TYPE_LIGHT -> "浅睡"
    SleepSessionRecord.STAGE_TYPE_REM -> "REM"
    SleepSessionRecord.STAGE_TYPE_AWAKE -> "清醒"
    SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "在床清醒"
    SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "离床"
    SleepSessionRecord.STAGE_TYPE_SLEEPING -> "睡着（未细分）"
    else -> "未知（$type）"
}

fun asleepDuration(stages: List<StageSpan>): Duration? {
    val asleep = stages.filter { it.type in setOf(SleepSessionRecord.STAGE_TYPE_SLEEPING,
        SleepSessionRecord.STAGE_TYPE_DEEP, SleepSessionRecord.STAGE_TYPE_LIGHT, SleepSessionRecord.STAGE_TYPE_REM) }
    return if (asleep.isEmpty()) null else durationUnion(asleep.map { it.start to it.end })
}

// Keep points separate across long gaps. No generated/interpolated measurements.
fun connectedHeartPairs(points: List<HeartPoint>, maxGap: Duration = Duration.ofMinutes(10)):
    List<Pair<HeartPoint, HeartPoint>> = points.sortedBy { it.time }.zipWithNext().filter { (a, b) ->
        a.origin == b.origin && Duration.between(a.time, b.time) <= maxGap
    }
