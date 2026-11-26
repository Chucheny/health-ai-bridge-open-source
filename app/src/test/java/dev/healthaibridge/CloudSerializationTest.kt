package dev.healthaibridge

import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import com.google.gson.JsonParser
import dev.healthaibridge.sync.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.time.Instant
import javax.crypto.KeyGenerator

class CloudSerializationTest {
    @Test fun actualSdkPreservesSignedLongClientVersions() {
        val start=Instant.parse("2026-01-01T00:00:00Z")
        for (version in listOf(Long.MIN_VALUE,-1L,0L,Long.MAX_VALUE)) {
            val record=StepsRecord(startTime=start,endTime=start.plusSeconds(60),startZoneOffset=null,endZoneOffset=null,
                count=42,metadata=Metadata.manualEntry(clientRecordId="synthetic-step",clientRecordVersion=version))
            val json=JsonParser.parseString(cloudUpsert(record)).asJsonObject["record"].asJsonObject
            val encoded=json["metadata"].asJsonObject["clientRecordVersion"].asJsonPrimitive
            assertTrue(encoded.isString)
            assertEquals(version.toString(),encoded.asString)
        }
    }
    @Test fun actualSdkStepRecordKeepsNullableOffsetsAndLongVersionThroughEncryptedOutbox() = runBlocking {
        val start=Instant.parse("2026-01-01T00:00:00.123456789Z")
        val record=StepsRecord(startTime=start,endTime=start.plusSeconds(60),startZoneOffset=null,endZoneOffset=null,
            count=42,metadata=Metadata.manualEntry(clientRecordId="synthetic-step",clientRecordVersion=Long.MAX_VALUE))
        val operation=cloudUpsert(record)
        val batches=pendingBatches(Metric.STEPS,0,listOf(operation))
        val directory=Files.createTempDirectory("bridge-serializer-test").toFile()
        try {
            val key=KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val store=EncryptedSyncStore(directory,key)
            store.save(Metric.STEPS,SyncState(pending=PendingPage(batches,0,"next",false)))
            val body=EncryptedSyncStore(directory,key).load(Metric.STEPS).pending!!.batches.single().body
            val json=JsonParser.parseString(body).asJsonObject["operations"].asJsonArray[0].asJsonObject["record"].asJsonObject
            assertTrue(json.has("startZoneOffset"));assertTrue(json["startZoneOffset"].isJsonNull)
            assertTrue(json.has("endZoneOffset"));assertTrue(json["endZoneOffset"].isJsonNull)
            assertEquals("9223372036854775807",json["metadata"].asJsonObject["clientRecordVersion"].asString)
            assertTrue(json["metadata"].asJsonObject["clientRecordVersion"].asJsonPrimitive.isString)
            assertEquals(start.toString(),json["startTime"].asString)
            assertEquals(42L,json["value"].asLong);assertEquals("steps",json["unit"].asString)
        } finally { directory.listFiles()?.forEach { it.delete() };directory.delete() }
    }
}
