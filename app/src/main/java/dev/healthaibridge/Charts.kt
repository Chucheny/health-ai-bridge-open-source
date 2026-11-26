package dev.healthaibridge

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.cos

val chartColors = listOf(Color(0xFF147D73), Color(0xFF7357AE), Color(0xFFC07827), Color(0xFF247CB1))

@Composable fun HeartChart(points: List<HeartPoint>) {
    if (points.isEmpty()) { Text("暂无实际心率采样点"); return }
    val sorted = remember(points) { points.sortedBy { it.time } }
    val groups = remember(sorted) { sorted.groupBy { it.origin } }
    val first = sorted.first().time
    val last = sorted.last().time
    val span = Duration.between(first, last).toMillis().coerceAtLeast(1).toDouble()
    val low = (sorted.minOf { it.bpm } - 5).coerceAtLeast(0)
    val high = sorted.maxOf { it.bpm } + 5
    val pairs = remember(groups) { groups.mapValues { connectedHeartPairs(it.value) } }
    Text("${sorted.size} 个实际采样点 · 纵轴 $low–$high BPM", style = MaterialTheme.typography.labelMedium)
    Canvas(Modifier.fillMaxWidth().height(170.dp).semantics {
        contentDescription = "心率曲线，共 ${sorted.size} 个真实点，最低 ${sorted.minOf { it.bpm }}，最高 ${sorted.maxOf { it.bpm }} BPM"
    }) {
        fun position(point: HeartPoint) = Offset(
            (Duration.between(first, point.time).toMillis() / span * (size.width - 12) + 6).toFloat(),
            (size.height - 6 - (point.bpm - low).toDouble() / (high - low) * (size.height - 12)).toFloat()
        )
        drawLine(Color.LightGray, Offset(6f, 0f), Offset(6f, size.height), 1f)
        drawLine(Color.LightGray, Offset(0f, size.height - 6), Offset(size.width, size.height - 6), 1f)
        groups.entries.forEachIndexed { index, (origin, samples) ->
            val color = chartColors[index % chartColors.size]
            pairs[origin].orEmpty().forEach { (a, b) -> drawLine(color, position(a), position(b), 1.5f) }
            samples.forEach { drawCircle(color, 2.5f, position(it)) }
        }
    }
    Text("${displayTime(first)} → ${displayTime(last)}", style = MaterialTheme.typography.labelSmall)
    groups.keys.forEachIndexed { index, origin -> Text("● $origin", color = chartColors[index % chartColors.size], style = MaterialTheme.typography.labelSmall) }
    Text("全部点参与绘图；同来源相邻点间隔超过 10 分钟时断开。连线仅辅助阅读，不补造采样。", style = MaterialTheme.typography.labelSmall)
}

fun stageColor(type: Int): Color = when (type) {
    4 -> Color(0xFF4388C4)
    5 -> Color(0xFF5144A2)
    6 -> Color(0xFF9C66B9)
    1, 3, 7 -> Color(0xFFDC9A46)
    2 -> Color(0xFF528782)
    else -> Color(0xFF8B9298)
}

@Composable fun SleepTimeline(start: Instant, end: Instant, stages: List<StageSpan>) {
    if (stages.isEmpty()) { Text("暂无睡眠分期，不能据会话时长推断深睡或浅睡"); return }
    val span = Duration.between(start, end).toMillis().coerceAtLeast(1).toDouble()
    Canvas(Modifier.fillMaxWidth().height(46.dp).semantics { contentDescription = "睡眠时间轴，共 ${stages.size} 个原始阶段；灰色背景为未记录区间" }) {
        drawRect(Color(0xFFE6E8E9))
        stages.forEach { stage ->
            val left = (Duration.between(start, maxOf(start, stage.start)).toMillis() / span).coerceIn(0.0, 1.0)
            val right = (Duration.between(start, minOf(end, stage.end)).toMillis() / span).coerceIn(0.0, 1.0)
            if (right > left) drawRect(stageColor(stage.type), Offset((left * size.width).toFloat(), 0f), Size(((right-left)*size.width).toFloat(), size.height))
        }
    }
    Text("灰色底色：未记录区间；各分期见下方时长与原始阶段。", style = MaterialTheme.typography.labelSmall)
}

@Composable fun RouteChart(points: List<RoutePoint>) {
    if (points.isEmpty()) { Text("暂无坐标点"); return }
    // Local equirectangular projection, accounting for antimeridian crossings.
    val projected = remember(points) {
        val first = points.first()
        val scale = cos(Math.toRadians(first.latitude)).coerceAtLeast(0.01)
        points.map { ((it.longitude - first.longitude + 540) % 360 - 180) * scale to it.latitude }
    }
    val xMin = projected.minOf { it.first }; val xMax = projected.maxOf { it.first }
    val yMin = projected.minOf { it.second }; val yMax = projected.maxOf { it.second }
    Canvas(Modifier.fillMaxWidth().height(180.dp).semantics { contentDescription = "GPS 轨迹示意，${points.size} 个实际坐标点，无地图底图" }) {
        val extent = maxOf(xMax-xMin, yMax-yMin).coerceAtLeast(0.00001)
        val scale = minOf(size.width, size.height).toDouble() / extent * .85
        fun pos(point: Pair<Double,Double>) = Offset(
            (size.width/2 + (point.first-(xMin+xMax)/2)*scale).toFloat(),
            (size.height/2 - (point.second-(yMin+yMax)/2)*scale).toFloat()
        )
        projected.zipWithNext().forEach { (a,b) -> drawLine(chartColors[0], pos(a), pos(b), 2f) }
        projected.forEach { drawCircle(chartColors[0], 2f, pos(it)) }
        drawCircle(Color(0xFF29924C), 5f, pos(projected.first()))
        drawCircle(Color(0xFFC54943), 5f, pos(projected.last()))
    }
    Text("实际 GPS 点连线示意，无地图底图；绿色为起点，红色为终点。", style = MaterialTheme.typography.labelSmall)
}

fun displayTime(time: Instant): String = DateTimeFormatter.ofPattern("MM-dd HH:mm:ss.SSS XXX")
    .withZone(ZoneId.systemDefault()).format(time)
fun displayDuration(duration: Duration): String = "${duration.toHours()}小时 ${duration.toMinutes() % 60}分 ${duration.seconds % 60}秒"
