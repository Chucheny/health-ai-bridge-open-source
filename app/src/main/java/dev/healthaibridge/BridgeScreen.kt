package dev.healthaibridge

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.*
import com.google.gson.GsonBuilder
import java.time.Duration
import java.time.Instant
import java.util.Locale
import dev.healthaibridge.sync.CloudViewState

@Composable fun BridgeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(
        primary = Color(0xFF116755), onPrimary = Color.White,
        primaryContainer = Color(0xFFE3F1E9), onPrimaryContainer = Color(0xFF154C3C),
        secondary = Color(0xFF4F6A5C), secondaryContainer = Color(0xFFE3F1E9),
        onSecondaryContainer = Color(0xFF154C3C),
        background = Color(0xFFF3F6F5), onBackground = Color(0xFF19382F),
        surface = Color.White, onSurface = Color(0xFF19382F),
        surfaceVariant = Color(0xFFEAF1ED), onSurfaceVariant = Color(0xFF52695F),
        outline = Color(0xFF788E82), outlineVariant = Color(0xFFDCE8E0),
    ), shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp),
        large = RoundedCornerShape(24.dp), extraLarge = RoundedCornerShape(28.dp)), content = content)
}

private data class Detail(val title: String, val count: Int, val row: (Int) -> String)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun BridgeScreen(model: BridgeViewModel, onPermissions: () -> Unit, onSettings: () -> Unit,
                            onRoute: (String) -> Unit, onSave: () -> Unit, onCloud: () -> Unit = {},
                            onHealthSync: () -> Unit = {}, onQuickUpload: () -> Unit = {},
                            cloudState: CloudViewState = CloudViewState(), onAutomaticSync: () -> Unit = {},
                            onRefreshCloud: () -> Unit = {}, onPrivacy: () -> Unit = {}) {
    var page by rememberSaveable { mutableIntStateOf(0) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var detail by remember { mutableStateOf<Detail?>(null) }
    val snapshot = model.snapshot
    // Remove detail closures that hold old health records after permissions or selections change.
    LaunchedEffect(snapshot) { detail = null }
    BackHandler(page != 0 && detail == null) { page = 0 }
    BackHandler(detail != null) { detail = null }
    val showRecords: (String, List<Record>) -> Unit = { title, records ->
        detail = Detail(title, records.size) { index -> GsonBuilder().setPrettyPrinting().serializeNulls().create().toJson(recordJson(records[index])) }
    }
    val showHeart: (List<HeartPoint>) -> Unit = { points ->
        detail = Detail("心率采样点 · ${points.size}", points.size) { index ->
            val p = points[index]
            "${displayTime(p.time)}\n${p.time}\n${p.bpm} BPM\n来源：${p.origin}\nrecord ID：${p.recordId}\nsample index：${p.sampleIndex}"
        }
    }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, bottomBar = {
        if (detail == null) NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
            listOf("首页" to Icons.Outlined.Home, "健康数据" to Icons.Outlined.FavoriteBorder,
                "连接" to Icons.Outlined.Settings).forEachIndexed { index, (label, icon) ->
                NavigationBarItem(selected = page == index, onClick = { page = index },
                    icon = { Icon(icon, null) }, label = { Text(label) })
            }
        }
    }) { padding ->
        val currentDetail = detail
        if (currentDetail != null) {
            Column(Modifier.fillMaxSize().padding(padding)) {
                TextButton(onClick = { detail = null }) { Text("‹ 返回 · ${currentDetail.title}") }
                LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(currentDetail.count) { index -> Panel { SelectionContainer { Text(currentDetail.row(index), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } } }
                }
            }
        } else {
            Column(Modifier.fillMaxSize().padding(padding)) {
                BridgePageHeader(when (page) { 0 -> "健康，从这里连接"; 1 -> "本地健康数据"; else -> "连接与权限" },
                    when (page) { 0 -> "同步、查看与管理，集中在这里"; 1 -> "最近 7 天 · 按数据来源保留"; else -> "管理 Health Connect 的只读访问" })
                if (page == 1) PrimaryTabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
                    listOf("心率", "睡眠", "运动").forEachIndexed { index, title ->
                        Tab(selected = tab == index, onClick = { tab = index }, text = { Text(title) })
                    }
                }
                key(page, tab) {
                LazyColumn(modifier = Modifier.weight(1f), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (page == 0) {
                        item { Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            HomeDashboard(cloudState, onQuickUpload, onAutomaticSync, onRefreshCloud,
                                onHealthSync, onCloud, { page = 1 }, { page = 2 })
                        } }
                    } else {
                    item { Panel {
                        Text(availabilityLabel(model.availability), style = MaterialTheme.typography.titleSmall)
                        Text(model.message, style = MaterialTheme.typography.bodySmall)
                        if (model.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = model::read, enabled = !model.busy && model.availability == HealthConnectClient.SDK_AVAILABLE && model.selected.isNotEmpty()) { Text("读取 7 天") }
                            OutlinedButton(onClick = { page = 2 }, enabled = !model.busy) { Text("权限设置") }
                        }
                        snapshot?.let { Text("${displayTime(it.start)}\n至 ${displayTime(it.end)}", style = MaterialTheme.typography.labelSmall) }
                    } }
                    if (page == 2) {
                        connectionItems(model, onPermissions, onSettings, onSave, onPrivacy, showRecords)
                    } else if (snapshot == null) {
                        item { Text(if (model.busy) "正在读取授权数据…" else "尚无本次读取结果。前往“连接”授权后，点击“读取 7 天”。") }
                    } else when (tab) {
                        0 -> heartItems(snapshot, showHeart, showRecords)
                        1 -> sleepItems(snapshot, showRecords) { stages ->
                            detail = Detail("原始睡眠阶段 · ${stages.size}", stages.size) { i ->
                                val s = stages[i]
                                "${stageName(s.type)}（${s.type}）\n${displayTime(s.start)}\n→ ${displayTime(s.end)}\nUTC：${s.start} → ${s.end}"
                            }
                        }
                        2 -> exerciseItems(snapshot, model.routes, onRoute, showHeart, showRecords) { points ->
                            detail = Detail("GPS 原始坐标 · ${points.size}", points.size) { i ->
                                val p = points[i]
                                "${p.time}\n纬度 ${p.latitude}°\n经度 ${p.longitude}°\n海拔 ${p.altitudeMeters?.let { "$it m" } ?: "暂无"}\n水平精度 ${p.horizontalAccuracyMeters?.let { "$it m" } ?: "暂无"}"
                            }
                        }
                    }
                    }
                }
                }
            }
        }
    }
}

@Composable private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

private fun availabilityLabel(status: Int): String = when (status) {
    HealthConnectClient.SDK_AVAILABLE -> "Health Connect 可用"
    HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect 需要安装或更新"
    else -> "Health Connect 在此设备上不可用"
}

@Composable private fun TypeStatus(result: TypeResult) {
    Text("${result.metric.label} · ${result.metric.recordClass.simpleName}", style = MaterialTheme.typography.titleSmall)
    Text(when (result.status) {
        ReadStatus.COMPLETE -> if (result.records.isEmpty()) "已授权，最近 7 天暂无记录" else "${result.records.size} 条记录 · 已读完 ${result.pages} 页"
        ReadStatus.PARTIAL -> "已取得 ${result.records.size} 条记录，结果不完整"
        else -> result.status.label
    }, style = MaterialTheme.typography.bodySmall)
    result.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    result.origins.forEach { (origin, count) -> Text("$origin · $count 条", style = MaterialTheme.typography.labelSmall) }
    if (result.status == ReadStatus.COMPLETE && result.records.isEmpty()) {
        Text("空记录不能确定原因：可能未产生该数据、未同步、同步时间范围不足或数据源未提供。", style = MaterialTheme.typography.labelSmall)
    }
}

private fun LazyListScope.connectionItems(model: BridgeViewModel, onPermissions: () -> Unit, onSettings: () -> Unit,
                                        onSave: () -> Unit, onPrivacy: () -> Unit, showRecords: (String, List<Record>) -> Unit) {
    item { Panel {
        Text("Health Sync 来源", style = MaterialTheme.typography.titleMedium)
        val latest = model.snapshot?.results?.flatMap { it.records }
            ?.filter { it.metadata.dataOrigin.packageName == "nl.appyhapps.healthsync" }
            ?.maxOfOrNull { it.metadata.lastModifiedTime }
        Text(if (model.snapshot == null) "读取后可查看本次读到的来源记录时间。"
            else latest?.let { "本次读到的最近修改时间：${displayTime(it)}" } ?: "本次读取未发现 Health Sync 来源记录。",
            style = MaterialTheme.typography.bodySmall)
        Text("仅限已选、已授权类型与本次范围，可能不完整；修改时间不代表测量时间或 Health Sync 同步成功时间。", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } }
    item { Panel {
        Text("读取范围", style = MaterialTheme.typography.titleMedium)
        Text("仅申请勾选项的读取权限。系统授权可随时撤销；已有的 Health Sync 权限不等于本 App 已获授权。", style = MaterialTheme.typography.bodySmall)
        Metric.entries.filter { it.core }.forEach { metric -> MetricToggle(model, metric) }
        var more by remember { mutableStateOf(false) }
        TextButton(onClick = { more = !more }) { Text(if (more) "收起其他数据" else "展开其他数据（可选）") }
        if (more) Metric.entries.filter { !it.core }.forEach { MetricToggle(model, it) }
        Text("已授权 ${model.selected.count { it.permission in model.granted }} / ${model.selected.size} 项", style = MaterialTheme.typography.bodySmall)
        Button(onClick = onPermissions, enabled = !model.busy && model.availability == HealthConnectClient.SDK_AVAILABLE && model.permissionsNeeded().isNotEmpty()) { Text("授权所选读取项") }
        OutlinedButton(onClick = onSettings, enabled = !model.busy) { Text("打开 Health Connect") }
        TextButton(onClick = model::refresh, enabled = !model.busy) { Text("重新检查连接与权限") }
        TextButton(onClick = onPrivacy) { Text("健康数据与隐私") }
    } }
    model.snapshot?.let { snapshot ->
        item { Panel {
            Text("本次记录数量", style = MaterialTheme.typography.titleMedium)
            Text("record 数与采样点数分别统计。未授权或读取失败不会显示成 0 条。", style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = onSave) { Text("保存本次原始数据 JSON") }
            Text("仅保存至你选择的位置，不会自动上传。", style = MaterialTheme.typography.labelSmall)
        } }
        items(snapshot.results.filter { it.status != ReadStatus.NOT_SELECTED }) { result -> Panel {
            TypeStatus(result)
            if (result.countKnown) when (result.metric) {
                Metric.HEART -> Text("时间窗内心率采样点：${snapshot.heartPoints().size}")
                Metric.SLEEP -> Text("原始分期段：${result.records.filterIsInstance<SleepSessionRecord>().sumOf { it.stages.size }}")
                Metric.SPEED -> Text("时间窗内速度采样点：${result.records.filterIsInstance<SpeedRecord>().sumOf { r -> r.samples.count { inWindow(it.time, snapshot.start, snapshot.end) } }}")
                else -> Unit
            }
            if (result.records.isNotEmpty()) TextButton(onClick = { showRecords(result.metric.label + "原始记录", result.records) }) { Text("查看值、单位、时间与来源") }
        } }
    }
    item { Text("本地读取与云端上传分别授权；本应用不写入 Health Connect。数据来源以 DataOrigin 包名为准。", style = MaterialTheme.typography.bodySmall) }
}

@Composable private fun MetricToggle(model: BridgeViewModel, metric: Metric) {
    Row(Modifier.fillMaxWidth()) {
        Checkbox(checked = metric in model.selected, onCheckedChange = { model.select(metric, it) }, enabled = !model.busy)
        Column(Modifier.padding(top = 8.dp)) {
            Text(metric.label)
            Text(if (metric.permission in model.granted) "已授权读取" else "未授权读取", style = MaterialTheme.typography.labelSmall)
        }
    }
}

private fun LazyListScope.heartItems(snapshot: Snapshot, showHeart: (List<HeartPoint>) -> Unit, showRecords: (String, List<Record>) -> Unit) {
    val result = snapshot.results.first { it.metric == Metric.HEART }
    val points = snapshot.heartPoints()
    item { Panel {
        TypeStatus(result)
        if (result.countKnown) {
            Text("${result.records.size} 个 record · ${points.size} 个时间窗内实际采样点", style = MaterialTheme.typography.titleMedium)
            HeartChart(points)
        } else Text("采样点数量未确定，请选择并授权后读取。")
        if (points.isNotEmpty()) TextButton(onClick = { showHeart(points) }) { Text("查看全部 ${points.size} 个采样点") }
        if (result.records.isNotEmpty()) TextButton(onClick = { showRecords("心率原始记录", result.records) }) { Text("查看原始记录与元数据") }
    } }
    snapshot.results.filter { it.metric in setOf(Metric.RESTING, Metric.HRV) && it.status != ReadStatus.NOT_SELECTED }.forEach { result ->
        item { Panel { TypeStatus(result); if (result.records.isNotEmpty()) TextButton(onClick = { showRecords(result.metric.label, result.records) }) { Text("查看每条记录") } } }
    }
}

private fun LazyListScope.sleepItems(snapshot: Snapshot, showRecords: (String, List<Record>) -> Unit, showStages: (List<StageSpan>) -> Unit) {
    item { Panel { TypeStatus(snapshot.results.first { it.metric == Metric.SLEEP }) } }
    items(snapshot.records<SleepSessionRecord>().sortedByDescending { it.startTime }) { record ->
        val stages = record.stages.map { StageSpan(it.startTime, it.endTime, it.stage) }
        Panel {
            Text(record.title ?: "睡眠记录", style = MaterialTheme.typography.titleMedium)
            Text("${displayTime(record.startTime)}\n→ ${displayTime(record.endTime)}")
            Text("来源：${record.metadata.dataOrigin.packageName}", style = MaterialTheme.typography.labelSmall)
            Text("会话跨度：${displayDuration(Duration.between(record.startTime, record.endTime))}")
            Text("已记录的睡着时长：${asleepDuration(stages)?.let(::displayDuration) ?: "暂无，无法确定"}")
            SleepTimeline(record.startTime, record.endTime, stages)
            stages.groupBy { it.type }.forEach { (type, values) ->
                Text("● ${stageName(type)}：${displayDuration(durationUnion(values.map { it.start to it.end }))}", color = stageColor(type), style = MaterialTheme.typography.bodySmall)
            }
            Row {
                if (stages.isNotEmpty()) TextButton(onClick = { showStages(stages) }) { Text("查看 ${stages.size} 段分期") }
                TextButton(onClick = { showRecords("睡眠原始记录", listOf(record)) }) { Text("原始记录") }
            }
        }
    }
}

private fun LazyListScope.exerciseItems(snapshot: Snapshot, routes: Map<String, RouteRead>, onRoute: (String) -> Unit,
                                      showHeart: (List<HeartPoint>) -> Unit, showRecords: (String, List<Record>) -> Unit,
                                      showRoute: (List<RoutePoint>) -> Unit) {
    val heart = snapshot.heartPoints()
    item { Panel {
        TypeStatus(snapshot.results.first { it.metric == Metric.EXERCISE })
        Text("心率、速度、距离及热量按运动时间段关联，来源分别保留。时间重叠不代表数据源提供了运动归属。", style = MaterialTheme.typography.bodySmall)
    } }
    items(snapshot.records<ExerciseSessionRecord>().sortedByDescending { it.startTime }) { record -> Panel {
        val origin = record.metadata.dataOrigin.packageName
        val points = remember(snapshot, record) { heartWithin(heart, record.startTime, record.endTime) }
        val route = routes[record.metadata.id] ?: RouteRead(RouteStatus.NO_DATA)
        Text(record.title ?: exerciseName(record.exerciseType), style = MaterialTheme.typography.titleMedium)
        Text("${exerciseName(record.exerciseType)}（${record.exerciseType}）")
        Text("${displayTime(record.startTime)}\n→ ${displayTime(record.endTime)}")
        Text("运动跨度：${displayDuration(Duration.between(record.startTime, record.endTime))}（含暂停）")
        Text("来源：$origin", style = MaterialTheme.typography.labelSmall)
        if (record.startTime < snapshot.start || record.endTime > snapshot.end) Text("此运动跨出查询边界，关联采样只覆盖本次 7 天窗口。", color = MaterialTheme.colorScheme.error)
        Text("圈数 ${record.laps.size} · 分段 ${record.segments.size}", style = MaterialTheme.typography.labelSmall)
        AssociatedTotals(snapshot, record, showRecords)
        val heartResult = snapshot.results.first { it.metric == Metric.HEART }
        Text("心率读取状态：${heartResult.status.label}", style = MaterialTheme.typography.labelSmall)
        if (heartResult.countKnown) {
            Text("运动期间心率 · ${points.size} 个实际点", style = MaterialTheme.typography.titleSmall)
            HeartChart(points)
        } else Text("运动期间心率数量未确定。")
        if (points.isNotEmpty()) TextButton(onClick = { showHeart(points) }) { Text("查看运动期间全部心率点") }
        Text(route.status.label, style = MaterialTheme.typography.titleSmall)
        route.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (route.status in setOf(RouteStatus.CONSENT, RouteStatus.DENIED, RouteStatus.ERROR)) {
            OutlinedButton(onClick = { onRoute(record.metadata.id) }) { Text("通过系统授权读取此条路线") }
        }
        if (route.status == RouteStatus.READY) {
            Text("${route.points.size} 个 GPS 坐标点")
            RouteChart(route.points)
            if (route.points.isNotEmpty()) TextButton(onClick = { showRoute(route.points) }) { Text("查看全部坐标与时间") }
        }
        TextButton(onClick = { showRecords("运动原始记录", listOf(record)) }) { Text("查看 session、laps、segments 与元数据") }
    } }
}

@Composable private fun AssociatedTotals(snapshot: Snapshot, exercise: ExerciseSessionRecord, showRecords: (String, List<Record>) -> Unit) {
    val origin = exercise.metadata.dataOrigin.packageName
    val distances = snapshot.records<DistanceRecord>().filter { it.metadata.dataOrigin.packageName == origin && containedIn(it.startTime, it.endTime, exercise.startTime, exercise.endTime) }
    val calories = snapshot.records<ActiveCaloriesBurnedRecord>().filter { it.metadata.dataOrigin.packageName == origin && containedIn(it.startTime, it.endTime, exercise.startTime, exercise.endTime) }
    val speeds = snapshot.records<SpeedRecord>().flatMap { record -> record.samples.filter { inWindow(it.time, exercise.startTime, exercise.endTime) && inWindow(it.time, snapshot.start, snapshot.end) }.map { record.metadata.dataOrigin.packageName to it } }
    val distanceStatus = snapshot.results.first { it.metric == Metric.DISTANCE }.status
    val calorieStatus = snapshot.results.first { it.metric == Metric.CALORIES }.status
    Text("距离：${if (!snapshot.results.first { it.metric == Metric.DISTANCE }.countKnown) "数量未确定" else if (distances.isEmpty()) "无可确定归属的区间" else "${number(distances.sumOf { it.distance.inMeters })} m（${distances.size} 条区间小计）"} · ${distanceStatus.label}", style = MaterialTheme.typography.bodySmall)
    Text("活动热量：${if (!snapshot.results.first { it.metric == Metric.CALORIES }.countKnown) "数量未确定" else if (calories.isEmpty()) "无可确定归属的区间" else "${number(calories.sumOf { it.energy.inKilocalories })} kcal（${calories.size} 条区间小计）"} · ${calorieStatus.label}", style = MaterialTheme.typography.bodySmall)
    Text("距离/热量仅统计同来源且完整落在运动内的区间；不推算跨界区间，不代表完整运动总量。", style = MaterialTheme.typography.labelSmall)
    val speedResult = snapshot.results.first { it.metric == Metric.SPEED }
    Text("速度：${if (speedResult.countKnown) "${speeds.size} 个时间关联点" else "数量未确定"} · ${speedResult.status.label}", style = MaterialTheme.typography.bodySmall)
    if (speeds.isNotEmpty()) {
        val sourceRecords = snapshot.records<SpeedRecord>().filter { record -> record.samples.any { inWindow(it.time, exercise.startTime, exercise.endTime) } }
        TextButton(onClick = { showRecords("运动时间关联速度记录（m/s）", sourceRecords) }) { Text("查看原始速度记录") }
        val sameOriginSpeeds = speeds.filter { it.first == origin }.map { it.second.speed.inMetersPerSecond }.filter { it > 0 }
        if (sameOriginSpeeds.isNotEmpty()) Text("同来源采样速度范围 ${number(sameOriginSpeeds.min())}–${number(sameOriginSpeeds.max())} m/s；对应采样配速 ${number(1000 / sameOriginSpeeds.max() / 60)}–${number(1000 / sameOriginSpeeds.min() / 60)} min/km（速度换算，非全程平均）。", style = MaterialTheme.typography.labelSmall)
    }
}

private fun number(value: Double): String = String.format(Locale.ROOT, "%.2f", value)
private fun exerciseName(type: Int): String = when (type) {
    ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "跑步"
    ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "步行"
    ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "骑行"
    ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "徒步"
    ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "泳池游泳"
    ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "开放水域游泳"
    ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "跑步机"
    ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "力量训练"
    ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "瑜伽"
    ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "羽毛球"
    else -> "运动类型代码 $type"
}
