package dev.healthaibridge

import android.util.Log
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord

// Debug-only local acceptance evidence: counts and state, never measurements or coordinates.
internal fun logVerification(snapshot: Snapshot, routes: Map<String, RouteRead>) {
    if (!BuildConfig.DEBUG) return
    val points = snapshot.heartPoints()
    Log.i("HealthAIBridgeCheck", "WINDOW ${snapshot.start} ${snapshot.end}")
    snapshot.results.filter { it.status != ReadStatus.NOT_SELECTED }.forEach { result ->
        Log.i("HealthAIBridgeCheck", "TYPE ${result.metric.name} status=${result.status} records=${if (result.countKnown) result.records.size else "unknown"} pages=${result.pages} origins=${result.origins} error=${result.error?.substringBefore('：')}")
    }
    Log.i("HealthAIBridgeCheck", "DETAIL heartSamplesInWindow=${points.size} sleepStages=${snapshot.records<SleepSessionRecord>().sumOf { it.stages.size }}")
    Log.i("HealthAIBridgeCheck", "SLEEP_STAGE_COUNTS ${snapshot.records<SleepSessionRecord>().flatMap { it.stages }.groupingBy { stageName(it.stage) }.eachCount()}")
    snapshot.records<ExerciseSessionRecord>().forEachIndexed { index, exercise ->
        val route = routes[exercise.metadata.id]
        Log.i("HealthAIBridgeCheck", "EXERCISE index=$index heartSamples=${heartWithin(points, exercise.startTime, exercise.endTime).size} routeStatus=${route?.status} routePoints=${route?.points?.size ?: 0}")
    }
    Log.i("HealthAIBridgeCheck", "END")
}
