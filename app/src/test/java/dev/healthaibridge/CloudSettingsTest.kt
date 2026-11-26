package dev.healthaibridge

import dev.healthaibridge.sync.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator

class CloudSettingsTest {
    @Test fun v1CiphertextWithoutAutomaticFieldsRemainsReadableAndCanBeUpdated() = runBlocking {
        withSettingsStore { openStore, directory ->
            val old = """{"configuration":${configuration()},"selected":["HEART","SLEEP"],"paused":false,"lastSuccess":"2026-01-01T00:00:00Z"}"""
            // Persist an old-format JSON fixture inside the existing v1 AES-GCM envelope.
            // Obtain the fixture key through a separate local store, never Android Keystore.
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,key)
            cipher.updateAAD("Health AI Bridge cloud settings v1".toByteArray())
            directory.resolve("settings.bin").writeBytes(byteArrayOf(1)+cipher.iv+cipher.doFinal(old.toByteArray()))
            val store=EncryptedCloudSettings(directory,key)
            val loaded=store.load()
            assertFalse(loaded.automaticEnabled)
            assertEquals(setOf("HEART","SLEEP"),loaded.selected)
            assertEquals("2026-01-01T00:00:00Z",loaded.lastSuccess)
            val namespace=loaded.configuration!!.namespace()
            store.update { it.copy(automaticEnabled=true,automaticStatus="enabled",lastAutomaticAttempt="2026-01-02T00:00:00Z") }
            val reopened=EncryptedCloudSettings(directory,key).load()
            assertTrue(reopened.automaticEnabled)
            assertEquals(namespace,reopened.configuration!!.namespace())
            assertEquals(loaded.selected,reopened.selected)
            assertEquals(loaded.lastSuccess,reopened.lastSuccess)
            assertFalse(directory.resolve("settings.bin").readBytes().toString(Charsets.UTF_8).contains("a".repeat(43)))
        }
    }
    @Test fun malformedAutomaticStatusOrTimeNeverRewritesEncryptedSettings() = runBlocking {
        withSettingsStore { openStore, directory ->
            openStore().save(CloudSettings())
            val before=directory.resolve("settings.bin").readBytes()
            for (bad in listOf(CloudSettings(automaticStatus="unknown"),CloudSettings(lastAutomaticSuccess="invalid"))) {
                try { openStore().save(bad); fail("Must reject invalid automatic metadata") }
                catch (_: RuntimeException) { }
                assertArrayEquals(before,directory.resolve("settings.bin").readBytes())
            }
        }
    }
    private fun configuration(token: String = "a".repeat(43)) = """{"schemaVersion":1,"baseUrl":"https://private.invalid/","ownerId":"11111111-1111-4111-8111-111111111111","sourceId":"22222222-2222-4222-8222-222222222222","token":"$token","allowedTypes":["HeartRateRecord","SleepSessionRecord"]}"""
    private suspend fun withSettingsStore(test: suspend (() -> EncryptedCloudSettings, java.io.File) -> Unit) {
        val directory = Files.createTempDirectory("bridge-settings-update-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try { test({ EncryptedCloudSettings(directory,key) }, directory) }
        finally {
            directory.listFiles()?.forEach { check(it.isFile && it.delete()) }
            check(directory.delete())
        }
    }
    @Test fun pairingNeverAutomaticallyAuthorizesUploadsAndPauseOverridesSelection() {
        val config = parseDeviceConfiguration(configuration())
        val first = CloudSettings(configuration = config)
        assertFalse(first.permits(Metric.HEART))
        assertFalse(first.copy(selected = setOf("HEART")).permits(Metric.HEART))
        val active = first.copy(selected = setOf("HEART"),paused = false)
        assertTrue(active.permits(Metric.HEART))
        assertFalse(active.permits(Metric.SLEEP))
        assertFalse(active.copy(pendingAction = "revoke").permits(Metric.HEART))
        assertFalse(active.copy(selected = setOf("STEPS")).permits(Metric.STEPS))
    }
    @Test fun malformedPairingAndUnrecognizedTypesAreRejectedWithoutFallbacks() {
        for (json in listOf("{}", configuration().replace("HeartRateRecord","UnknownRecord"),
            configuration().replace("https://", "http://"), configuration().replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            configuration().replace("\"ownerId\"", "\"unexpected\""), configuration().replace("11111111-1111-4111-8111-111111111111","bad"))) {
            try { parseDeviceConfiguration(json); fail() } catch (_: Exception) { }
        }
    }
    @Test fun credentialSettingsSurviveRestartWithoutPlaintextOrSharedQueues() = runBlocking {
        val directory = Files.createTempDirectory("bridge-config-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try {
            val store = EncryptedCloudSettings(directory,key)
            val config = parseDeviceConfiguration(configuration())
            val value = CloudSettings(config,setOf("HEART"),false,lastAttempt = "2026-01-01T00:00:00Z")
            store.save(value)
            val bytes = directory.resolve("settings.bin").readBytes().toString(Charsets.UTF_8)
            assertFalse(bytes.contains("a".repeat(43))); assertFalse(bytes.contains("private.invalid"))
            val reopened = EncryptedCloudSettings(directory,key).load()
            assertTrue(reopened.permits(Metric.HEART)); assertFalse(reopened.permits(Metric.SLEEP))
            assertEquals(value.lastAttempt,reopened.lastAttempt)
            assertFalse(value.toString().contains("a".repeat(43)))
            assertNotEquals(config.namespace(),parseDeviceConfiguration(configuration("b".repeat(43))).namespace())
            assertEquals(64,config.namespace().length)
            store.save(value.copy(paused = true,pendingAction = "clear",selected = emptySet()))
            assertEquals("clear",EncryptedCloudSettings(directory,key).load().pendingAction)
        } finally { directory.listFiles()?.forEach { it.delete() }; directory.delete() }
    }
    @Test fun tamperingNeverResetsConfigurationIntoAnAuthorizedState() = runBlocking {
        val directory = Files.createTempDirectory("bridge-tamper-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try {
            val store = EncryptedCloudSettings(directory,key)
            store.save(CloudSettings(parseDeviceConfiguration(configuration())))
            val file = directory.resolve("settings.bin")
            val bytes = file.readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); file.writeBytes(bytes)
            var failed = false
            try { store.load() } catch (_: Exception) { failed = true }
            assertTrue(failed)
            assertArrayEquals(bytes,file.readBytes())
        } finally { directory.listFiles()?.forEach { it.delete() }; directory.delete() }
    }
    @Test fun erasingAnOutboxDoesNotAffectAnotherCredential() = runBlocking {
        val root = Files.createTempDirectory("bridge-outbox-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        try {
            val first = EncryptedSyncStore(root.resolve("first"),key)
            val second = EncryptedSyncStore(root.resolve("second"),key)
            first.save(Metric.HEART,SyncState(cursor = "synthetic-first"))
            second.save(Metric.HEART,SyncState(cursor = "synthetic-second"))
            first.erase()
            assertNull(first.load(Metric.HEART).cursor)
            assertEquals("synthetic-second",second.load(Metric.HEART).cursor)
        } finally { root.walkBottomUp().forEach { it.delete() } }
    }

    @Test fun concurrentDeselectAndPauseAcrossInstancesNeverRestoresRemovedConsent() = runBlocking {
        withSettingsStore { openStore, _ ->
            // Also retain pending-action markers: pausing must never remove their guard.
            for (action in listOf(null,"revoke","clear")) {
                val original = CloudSettings(parseDeviceConfiguration(configuration()),
                    setOf("HEART","SLEEP"),false,lastSuccess = "2026-01-01T00:00:00Z",pendingAction = action)
                val selectionStore = openStore()
                val pauseStore = openStore()
                selectionStore.save(original)
                val enteredTransform = CompletableDeferred<Unit>()
                val releaseTransform = CountDownLatch(1)
                val deselected = async {
                    selectionStore.update { current ->
                        enteredTransform.complete(Unit)
                        check(releaseTransform.await(5,TimeUnit.SECONDS))
                        current.copy(selected = current.selected - "HEART",paused = true)
                    }
                }
                var paused: kotlinx.coroutines.Deferred<CloudSettings>? = null
                try {
                    withTimeout(5_000) { enteredTransform.await() }
                    // UNDISPATCHED reaches update's shared mutex before returning here.
                    val pausing = async(start = CoroutineStart.UNDISPATCHED) {
                        pauseStore.update { current -> current.copy(paused = true) }
                    }
                    paused = pausing
                    assertFalse(pausing.isCompleted)
                    releaseTransform.countDown()
                    assertEquals(setOf("SLEEP"), withTimeout(5_000) { deselected.await() }.selected)
                    val pausedValue = withTimeout(5_000) { pausing.await() }
                    assertEquals(setOf("SLEEP"),pausedValue.selected)
                    val reopened = openStore().load()
                    assertEquals(setOf("SLEEP"),reopened.selected)
                    assertTrue(reopened.paused)
                    assertEquals(action,reopened.pendingAction)
                    assertEquals(original.lastSuccess,reopened.lastSuccess)
                    assertEquals(original.configuration!!.namespace(),reopened.configuration!!.namespace())
                } finally {
                    releaseTransform.countDown()
                    deselected.cancelAndJoin()
                    paused?.cancelAndJoin()
                }
            }
        }
    }

    @Test fun updateReloadsDiskWhenPreviousWriteCommittedButCallerWasCancelled() = runBlocking {
        withSettingsStore { openStore, _ ->
            val original = CloudSettings(parseDeviceConfiguration(configuration()),setOf("HEART","SLEEP"),
                false,lastSuccess = "2026-01-01T00:00:00Z")
            openStore().save(original)
            var callerCache = original
            val enteredTransform = CompletableDeferred<Unit>()
            val releaseTransform = CountDownLatch(1)
            val cancelledCaller = launch {
                callerCache = openStore().update { current ->
                    enteredTransform.complete(Unit)
                    check(releaseTransform.await(5,TimeUnit.SECONDS))
                    current.copy(selected = current.selected - "HEART")
                }
            }
            try {
                withTimeout(5_000) { enteredTransform.await() }
                // Cancellation occurs inside the non-suspending disk transaction. The
                // atomic write completes, but withContext must not return to this cache.
                cancelledCaller.cancel()
                releaseTransform.countDown()
                withTimeout(5_000) { cancelledCaller.join() }
                assertTrue(cancelledCaller.isCancelled)
                assertEquals(setOf("HEART","SLEEP"),callerCache.selected)
                assertEquals(setOf("SLEEP"),openStore().load().selected)

                val next = openStore().update { current -> current.copy(paused = true) }
                assertEquals(setOf("SLEEP"),next.selected)
                val reopened = openStore().load()
                assertEquals(setOf("SLEEP"),reopened.selected)
                assertTrue(reopened.paused)
                assertEquals(original.lastSuccess,reopened.lastSuccess)
            } finally {
                releaseTransform.countDown()
                cancelledCaller.cancelAndJoin()
            }
        }
    }

    @Test fun failedUpdateNeverRewritesOrResetsExistingEncryptedSettings() = runBlocking {
        withSettingsStore { openStore, directory ->
            val original = CloudSettings(parseDeviceConfiguration(configuration()),setOf("SLEEP"),
                true,lastSuccess = "2026-01-01T00:00:00Z",pendingAction = "revoke")
            openStore().save(original)
            val file = directory.resolve("settings.bin")
            val before = file.readBytes()
            try {
                openStore().update { throw IllegalStateException("Synthetic transform failure") }
                fail("A failed transform must propagate")
            } catch (_: IllegalStateException) { }
            assertArrayEquals(before,file.readBytes())
            try {
                openStore().update { current -> current.copy(selected = setOf("UNKNOWN")) }
                fail("Invalid settings must not be saved")
            } catch (_: IllegalArgumentException) { }
            assertArrayEquals(before,file.readBytes())
            val reopened = openStore().load()
            assertEquals(setOf("SLEEP"),reopened.selected)
            assertTrue(reopened.paused)
            assertEquals("revoke",reopened.pendingAction)
            assertEquals(original.lastSuccess,reopened.lastSuccess)
            assertFalse(before.toString(Charsets.UTF_8).contains("a".repeat(43)))
        }
    }
}
