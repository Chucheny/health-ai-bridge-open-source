/* Explicit record fields and metadata serialization adapted from
 * Maksim Aitov's health-connect-data-exporter (MIT, copyright 2026).
 * See THIRD_PARTY_NOTICES.md and licenses/health-connect-data-exporter-MIT.txt.
 */
package dev.healthaibridge

import androidx.health.connect.client.records.*
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.io.Writer
import java.time.Instant
import java.time.ZoneOffset

private fun JsonObject.text(name: String, value: Any?) {
    if (value == null) add(name, null) else addProperty(name, value.toString())
}

fun recordJson(record: Record): JsonObject {
    val json = JsonObject().apply {
        addProperty("recordType", record.javaClass.simpleName)
        add("metadata", JsonObject().apply {
            val m = record.metadata
            text("id", m.id)
            text("dataOriginPackage", m.dataOrigin.packageName)
            text("lastModifiedTime", m.lastModifiedTime)
            text("clientRecordId", m.clientRecordId)
            addProperty("clientRecordVersion", m.clientRecordVersion)
            addProperty("recordingMethod", m.recordingMethod)
            m.device?.let { device -> add("device", JsonObject().apply {
                addProperty("type", device.type)
                text("manufacturer", device.manufacturer); text("model", device.model)
            }) }
        })
    }
    fun interval(start: Instant, end: Instant, startOffset: ZoneOffset?, endOffset: ZoneOffset?) {
        json.text("startTime", start); json.text("endTime", end)
        json.text("startZoneOffset", startOffset); json.text("endZoneOffset", endOffset)
    }
    fun instant(time: Instant, offset: ZoneOffset?) { json.text("time", time); json.text("zoneOffset", offset) }
    fun value(number: Number, unit: String) { json.addProperty("value", number); json.addProperty("unit", unit) }
    when (record) {
        is HeartRateRecord -> {
            interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset)
            json.add("samples", JsonArray().apply { record.samples.forEach { sample -> add(JsonObject().apply {
                text("time", sample.time); addProperty("beatsPerMinute", sample.beatsPerMinute); addProperty("unit", "BPM")
            }) } })
        }
        is SleepSessionRecord -> {
            interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset)
            json.text("title", record.title); json.text("notes", record.notes)
            json.add("stages", JsonArray().apply { record.stages.forEach { stage -> add(JsonObject().apply {
                text("startTime", stage.startTime); text("endTime", stage.endTime)
                addProperty("stage", stage.stage); addProperty("stageName", stageName(stage.stage))
            }) } })
        }
        is ExerciseSessionRecord -> {
            interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset)
            json.text("title", record.title); json.text("notes", record.notes)
            json.addProperty("exerciseType", record.exerciseType)
            json.add("segments", JsonArray().apply { record.segments.forEach { segment -> add(JsonObject().apply {
                text("startTime", segment.startTime); text("endTime", segment.endTime)
                addProperty("segmentType", segment.segmentType); addProperty("repetitions", segment.repetitions)
            }) } })
            json.add("laps", JsonArray().apply { record.laps.forEach { lap -> add(JsonObject().apply {
                text("startTime", lap.startTime); text("endTime", lap.endTime)
                lap.length?.let { addProperty("lengthMeters", it.inMeters) }
            }) } })
        }
        is SpeedRecord -> {
            interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset)
            json.add("samples", JsonArray().apply { record.samples.forEach { sample -> add(JsonObject().apply {
                text("time", sample.time); addProperty("metersPerSecond", sample.speed.inMetersPerSecond)
            }) } })
        }
        is DistanceRecord -> { interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset); value(record.distance.inMeters, "m") }
        is ActiveCaloriesBurnedRecord -> { interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset); value(record.energy.inKilocalories, "kcal") }
        is StepsRecord -> { interval(record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset); value(record.count, "steps") }
        is RestingHeartRateRecord -> { instant(record.time, record.zoneOffset); value(record.beatsPerMinute, "BPM") }
        is HeartRateVariabilityRmssdRecord -> { instant(record.time, record.zoneOffset); value(record.heartRateVariabilityMillis, "ms (RMSSD)") }
        is OxygenSaturationRecord -> { instant(record.time, record.zoneOffset); value(record.percentage.value, "%") }
        is RespiratoryRateRecord -> { instant(record.time, record.zoneOffset); value(record.rate, "breaths/min") }
        is WeightRecord -> { instant(record.time, record.zoneOffset); value(record.weight.inKilograms, "kg") }
        is BloodPressureRecord -> {
            instant(record.time, record.zoneOffset)
            json.addProperty("systolic", record.systolic.inMillimetersOfMercury)
            json.addProperty("diastolic", record.diastolic.inMillimetersOfMercury)
            json.addProperty("unit", "mmHg")
            json.addProperty("bodyPosition", record.bodyPosition); json.addProperty("measurementLocation", record.measurementLocation)
        }
        is BloodGlucoseRecord -> {
            instant(record.time, record.zoneOffset); value(record.level.inMillimolesPerLiter, "mmol/L")
            json.addProperty("specimenSource", record.specimenSource); json.addProperty("mealType", record.mealType)
            json.addProperty("relationToMeal", record.relationToMeal)
        }
        is BodyTemperatureRecord -> {
            instant(record.time, record.zoneOffset); value(record.temperature.inCelsius, "°C")
            json.addProperty("measurementLocation", record.measurementLocation)
        }
        else -> error("没有显式序列化该类型：${record.javaClass.simpleName}")
    }
    return json
}

fun writeSnapshot(writer: Writer, snapshot: Snapshot, routes: Map<String, RouteRead>) {
    val gson = GsonBuilder().disableHtmlEscaping().serializeNulls().create()
    val root = JsonObject().apply {
        addProperty("schemaVersion", 1)
        addProperty("appVersion", BuildConfig.VERSION_NAME)
        text("windowStartInclusive", snapshot.start); text("windowEndExclusive", snapshot.end)
        text("exportedAt", Instant.now())
        addProperty("querySemantics", "records overlapping window; samples retain original timestamps; in-window counts use [start,end)")
        if (snapshot.results.first { it.metric == Metric.HEART }.countKnown) addProperty("heartSampleCountInWindow", snapshot.heartPoints().size)
        else add("heartSampleCountInWindow", null)
        addProperty("associationRule", "time overlap only, grouped by DataOrigin; not a source-provided workout link")
        add("types", JsonArray().apply { snapshot.results.forEach { result -> add(JsonObject().apply {
            text("metric", result.metric.name); text("recordType", result.metric.recordClass.simpleName)
            text("permission", result.metric.permission); text("status", result.status)
            if (result.countKnown) addProperty("recordCount", result.records.size) else add("recordCount", null)
            addProperty("pages", result.pages)
            text("error", result.error); add("origins", gson.toJsonTree(result.origins))
            add("records", JsonArray().apply { result.records.forEach { add(recordJson(it)) } })
        }) } })
        add("exerciseAssociations", JsonArray().apply { snapshot.records<ExerciseSessionRecord>().forEach { exercise ->
            add(JsonObject().apply {
                text("sessionId", exercise.metadata.id)
                add("heartSamples", gson.toJsonTree(heartWithin(snapshot.heartPoints(), exercise.startTime, exercise.endTime).map {
                    mapOf("time" to it.time.toString(), "bpm" to it.bpm, "origin" to it.origin, "recordId" to it.recordId, "sampleIndex" to it.sampleIndex)
                }))
                val route = routes[exercise.metadata.id]
                text("routeStatus", route?.status); text("routeError", route?.error)
                add("routePoints", gson.toJsonTree(route?.points?.map { mapOf(
                    "time" to it.time.toString(), "latitude" to it.latitude, "longitude" to it.longitude,
                    "altitudeMeters" to it.altitudeMeters, "horizontalAccuracyMeters" to it.horizontalAccuracyMeters
                ) }))
            })
        } })
    }
    gson.toJson(root, writer)
}
