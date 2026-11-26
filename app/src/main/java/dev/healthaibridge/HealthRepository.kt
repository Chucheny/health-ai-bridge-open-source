package dev.healthaibridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant

class HealthRepository(context: Context) {
    private val appContext = context.applicationContext
    private val client by lazy { HealthConnectClient.getOrCreate(appContext) }
    fun availability(): Int = HealthConnectClient.getSdkStatus(appContext)
    suspend fun permissions(): Set<String> = client.permissionController.getGrantedPermissions()

    suspend fun readWeek(selected: Set<Metric>, onProgress: (String) -> Unit): Snapshot {
        val end = Instant.now()
        val start = end.minus(Duration.ofDays(7))
        val granted = permissions()
        val results = Metric.entries.map { metric ->
            when {
                metric !in selected -> TypeResult(metric, ReadStatus.NOT_SELECTED)
                metric.permission !in granted -> TypeResult(metric, ReadStatus.NO_PERMISSION)
                else -> {
                    onProgress("正在读取${metric.label}…")
                    readType(metric, start, end)
                }
            }
        }
        return Snapshot(start, end, results)
    }

    private suspend fun readType(metric: Metric, start: Instant, end: Instant): TypeResult {
        val result = readAllPages<Record> { token ->
                val response = client.readRecords(ReadRecordsRequest(
                    recordType = metric.recordClass,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 1000,
                    pageToken = token,
                    ascendingOrder = true,
                ))
                RecordPage(response.records, response.pageToken)
        }
        return TypeResult(metric, when {
            result.error == null -> ReadStatus.COMPLETE
            result.pages > 0 -> ReadStatus.PARTIAL
            else -> ReadStatus.ERROR
        }, result.records, result.error?.let { "${it.javaClass.simpleName}：${it.message ?: "无详细信息"}" }, result.pages)
    }
}

fun routeRead(result: ExerciseRouteResult): RouteRead = when (result) {
    is ExerciseRouteResult.Data -> routeRead(result.exerciseRoute)
    is ExerciseRouteResult.ConsentRequired -> RouteRead(RouteStatus.CONSENT)
    is ExerciseRouteResult.NoData -> RouteRead(RouteStatus.NO_DATA)
    else -> RouteRead(RouteStatus.ERROR, error = "当前 SDK 未识别的路线状态")
}

fun routeRead(route: ExerciseRoute): RouteRead = RouteRead(RouteStatus.READY, route.route.map {
    RoutePoint(it.time, it.latitude, it.longitude, it.altitude?.inMeters, it.horizontalAccuracy?.inMeters)
}.sortedBy { it.time })
