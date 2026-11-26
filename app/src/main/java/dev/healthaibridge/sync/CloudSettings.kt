package dev.healthaibridge.sync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.google.gson.Gson
import com.google.gson.JsonParser
import dev.healthaibridge.Metric
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceConfiguration(val schemaVersion: Int, val baseUrl: String, val ownerId: String,
                          val sourceId: String, internal val token: String, val allowedTypes: List<String>) {
    fun connection() = CloudConnection(baseUrl, token)
    // Separate outbox per credential: replacing an account can never upload an old account's queue.
    fun namespace() = MessageDigest.getInstance("SHA-256").digest((baseUrl + "\n" + token).toByteArray())
        .joinToString("") { "%02x".format(it) }
    override fun toString() = "DeviceConfiguration(redacted)"
}
data class CloudSettings(val configuration: DeviceConfiguration? = null, val selected: Set<String> = emptySet(),
                         val paused: Boolean = true, val lastAttempt: String? = null,
                         val lastSuccess: String? = null, val pendingAction: String? = null,
                         val automaticEnabled: Boolean = false, val automaticStatus: String? = null,
                         val lastAutomaticAttempt: String? = null, val lastAutomaticSuccess: String? = null) {
    fun permits(metric: Metric) = !paused && pendingAction == null && metric.name in selected &&
        metric.recordClass.simpleName in (configuration?.allowedTypes ?: emptyList())
}
fun parseDeviceConfiguration(json: String): DeviceConfiguration {
    require(json.toByteArray(Charsets.UTF_8).size <= 16_384)
    val objectValue = JsonParser.parseString(json).asJsonObject
    require(objectValue.keySet() == setOf("schemaVersion","baseUrl","ownerId","sourceId","token","allowedTypes"))
    val value = Gson().fromJson(objectValue, DeviceConfiguration::class.java)
    validateDeviceConfiguration(value)
    return value
}
private fun validateDeviceConfiguration(value: DeviceConfiguration) {
    require(value.schemaVersion == 1)
    require(UUID.fromString(value.ownerId).toString() == value.ownerId)
    require(UUID.fromString(value.sourceId).toString() == value.sourceId)
    value.connection()
    val types = Metric.entries.map { it.recordClass.simpleName }.toSet()
    require(value.allowedTypes.isNotEmpty() && value.allowedTypes.size <= types.size &&
        value.allowedTypes.distinct().size == value.allowedTypes.size && value.allowedTypes.all { it in types })
}

interface CloudSettingsStore {
    suspend fun load(): CloudSettings
    suspend fun update(transform: (CloudSettings) -> CloudSettings): CloudSettings
}

class EncryptedCloudSettings(private val directory: File, private val key: SecretKey) : CloudSettingsStore {
    private val mutex get() = processLock
    private val gson = Gson()
    private val aad = "Health AI Bridge cloud settings v1".toByteArray()
    override suspend fun load(): CloudSettings = mutex.withLock { withContext(Dispatchers.IO) { read() } }
    suspend fun save(settings: CloudSettings): Unit = mutex.withLock { withContext(Dispatchers.IO) { write(settings) } }
    // Read the persisted state inside the same process-wide lock as the write. A
    // caller's cache may be stale even when its previous write reached disk: the
    // coroutine can be cancelled while returning from the IO dispatcher.
    override suspend fun update(transform: (CloudSettings) -> CloudSettings): CloudSettings = mutex.withLock {
        withContext(Dispatchers.IO) { transform(read()).also { write(it) } }
    }
    private fun read(): CloudSettings {
        val file = File(directory, "settings.bin")
        if (!file.exists()) return CloudSettings()
        require(file.length() in 30..65_536)
        val bytes = file.readBytes()
        check(bytes[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1,13)))
        cipher.updateAAD(aad)
        val plain = cipher.doFinal(bytes,13,bytes.size-13)
        return try {
            gson.fromJson(plain.toString(Charsets.UTF_8), CloudSettings::class.java).also(::validateSettings)
        } finally { plain.fill(0) }
    }
    private fun write(settings: CloudSettings) {
        validateSettings(settings)
        check(directory.isDirectory || directory.mkdirs())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,key)
        cipher.updateAAD(aad)
        check(cipher.iv.size == 12)
        val plain = gson.toJson(settings).toByteArray(Charsets.UTF_8)
        val encrypted = try { byteArrayOf(1) + cipher.iv + cipher.doFinal(plain) } finally { plain.fill(0) }
        val temp = Files.createTempFile(directory.toPath(), "settings", ".tmp")
        try {
            FileOutputStream(temp.toFile()).use { it.write(encrypted); it.fd.sync() }
            Files.move(temp, File(directory,"settings.bin").toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING)
        } finally { Files.deleteIfExists(temp) }
    }
    private fun validateSettings(value: CloudSettings) {
        value.configuration?.let(::validateDeviceConfiguration)
        require(value.pendingAction in listOf(null,"revoke","clear"))
        require(value.automaticStatus == null || value.automaticStatus in AutomaticSyncStatus.values)
        value.lastAutomaticAttempt?.let { java.time.Instant.parse(it) }
        value.lastAutomaticSuccess?.let { java.time.Instant.parse(it) }
        require(value.selected.all { name -> Metric.entries.any { it.name == name && it.recordClass.simpleName in (value.configuration?.allowedTypes ?: emptyList()) } })
    }
    companion object {
        private val processLock = Mutex()
        @Synchronized fun forApp(context: Context, createKeyIfMissing: Boolean = true): EncryptedCloudSettings {
            val alias = "health-ai-bridge-cloud-config-v1"
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = store.getKey(alias,null) as? SecretKey
            check(existing != null || createKeyIfMissing) { "Existing settings key unavailable" }
            val key = existing ?: KeyGenerator.getInstance("AES","AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
            }.generateKey()
            return EncryptedCloudSettings(File(context.noBackupFilesDir,"cloud-settings"),key)
        }
    }
}
