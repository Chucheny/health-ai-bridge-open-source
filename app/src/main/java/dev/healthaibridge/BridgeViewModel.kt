package dev.healthaibridge

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.*
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*

class BridgeViewModel(app: Application) : AndroidViewModel(app) {
    private val repository = HealthRepository(app)
    private val preferences = app.getSharedPreferences("read-selection", 0)
    var selected by mutableStateOf(Metric.entries.filter { metric ->
        preferences.getBoolean(metric.name, metric.core)
    }.toSet()); private set
    var availability by mutableIntStateOf(HealthConnectClient.SDK_UNAVAILABLE); private set
    var granted by mutableStateOf(emptySet<String>()); private set
    var snapshot by mutableStateOf<Snapshot?>(null); private set
    var routes by mutableStateOf(emptyMap<String, RouteRead>()); private set
    var busy by mutableStateOf(false); private set
    var message by mutableStateOf("尚未读取，请先检查连接并授权"); private set
    var pendingRouteId by mutableStateOf<String?>(null)
    private var readJob: Job? = null

    fun select(metric: Metric, enabled: Boolean) {
        if (busy) return
        selected = if (enabled) selected + metric else selected - metric
        preferences.edit().putBoolean(metric.name, enabled).apply()
        snapshot = null
        routes = emptyMap()
        message = "读取类型已变更，请重新读取"
    }

    fun refresh() {
        viewModelScope.launch {
            try {
                availability = repository.availability()
                val current = if (availability == HealthConnectClient.SDK_AVAILABLE) repository.permissions() else emptySet()
                if ((granted - current).isNotEmpty() || availability != HealthConnectClient.SDK_AVAILABLE) {
                    readJob?.cancel()
                    snapshot = null
                    routes = emptyMap()
                    message = "连接或权限已改变，请重新读取"
                }
                granted = current
            } catch (error: Exception) {
                snapshot = null
                routes = emptyMap()
                granted = emptySet()
                message = "检查失败：${error.javaClass.simpleName} ${error.message.orEmpty()}"
            }
        }
    }

    fun permissionsNeeded(): Set<String> = selected.map { it.permission }.toSet() - granted

    fun read() {
        if (busy || availability != HealthConnectClient.SDK_AVAILABLE) return
        readJob = viewModelScope.launch {
            busy = true
            snapshot = null
            routes = emptyMap()
            try {
                granted = repository.permissions()
                val result = withContext(Dispatchers.IO) {
                    repository.readWeek(selected) { progress -> viewModelScope.launch { message = progress } }
                }
                snapshot = result
                routes = result.records<ExerciseSessionRecord>().associate { it.metadata.id to routeRead(it.exerciseRouteResult) }
                logVerification(result, routes)
                message = "已读取最近 7 天；空记录、未授权和读取失败分别标注"
            } catch (cancelled: CancellationException) {
                message = "读取已中断，请保持 App 在前台后重新读取"
                throw cancelled
            } catch (error: Exception) {
                message = "读取失败：${error.javaClass.simpleName} ${error.message.orEmpty()}"
            } finally { busy = false }
        }
    }

    fun stopForegroundRead() { readJob?.cancel() }

    fun acceptRoute(route: ExerciseRoute?) {
        val id = pendingRouteId ?: return
        if (snapshot?.records<ExerciseSessionRecord>()?.any { it.metadata.id == id } == true) {
            routes = routes + (id to if (route == null) RouteRead(RouteStatus.DENIED) else routeRead(route))
        }
        pendingRouteId = null
        snapshot?.let { logVerification(it, routes) }
    }

    fun routeFailure(id: String, error: Exception) {
        routes = routes + (id to RouteRead(RouteStatus.ERROR, error = "${error.javaClass.simpleName}：${error.message}"))
        pendingRouteId = null
    }

    fun export(uri: Uri) {
        val data = snapshot ?: return
        val routeCopy = routes
        viewModelScope.launch {
            try {
                // Revoked permission must invalidate even an in-memory snapshot before export.
                val current = repository.permissions()
                val used = data.results.filter { it.records.isNotEmpty() }.map { it.metric.permission }.toSet()
                check(current.containsAll(used)) { "读取权限已改变，请重新读取" }
                withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openOutputStream(uri, "wt")?.bufferedWriter()?.use {
                        writeSnapshot(it, data, routeCopy)
                    } ?: error("无法打开保存位置")
                }
                message = "已保存至你选择的位置"
            } catch (error: Exception) {
                message = "保存失败：${error.javaClass.simpleName} ${error.message.orEmpty()}"
            }
        }
    }
}
