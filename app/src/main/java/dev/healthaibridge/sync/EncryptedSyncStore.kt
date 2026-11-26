package dev.healthaibridge.sync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.google.gson.Gson
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
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypted outbox + cursors shared by foreground and future worker callers. */
class EncryptedSyncStore(private val directory: File, private val key: SecretKey) : SyncStore {
    override val mutex get() = processLock
    private val gson = Gson()
    override suspend fun load(metric: Metric): SyncState = withContext(Dispatchers.IO) {
        val file = File(directory, metric.name + ".bin")
        if (!file.exists()) return@withContext SyncState()
        require(file.length() in 30..40_000_000) { "Invalid encrypted sync state" }
        val data = file.readBytes()
        check(data[0] == 1.toByte()) { "Unsupported sync state format" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, data.copyOfRange(1, 13)))
        cipher.updateAAD(metric.name.toByteArray(Charsets.UTF_8))
        val plain = cipher.doFinal(data, 13, data.size - 13)
        gson.fromJson(plain.toString(Charsets.UTF_8), SyncState::class.java).also { state ->
            check(state.sequence >= 0)
            state.pending?.let { check(it.batches.isNotEmpty() && it.acknowledged in it.batches.indices) }
        }
    }
    override suspend fun save(metric: Metric, state: SyncState): Unit = withContext(Dispatchers.IO) {
        check(directory.isDirectory || directory.mkdirs())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(metric.name.toByteArray(Charsets.UTF_8))
        check(cipher.iv.size == 12)
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(gson.toJson(state).toByteArray(Charsets.UTF_8))
        require(encrypted.size <= 40_000_000) { "Sync page exceeds local storage limit" }
        val temporary = Files.createTempFile(directory.toPath(), metric.name, ".tmp")
        try {
            FileOutputStream(temporary.toFile()).use { it.write(encrypted); it.fd.sync() }
            Files.move(temporary, File(directory, metric.name + ".bin").toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { Files.deleteIfExists(temporary) }
    }
    suspend fun erase() = mutex.withLock { withContext(Dispatchers.IO) {
        // Only files in this credential's app-private directory. No recursive deletion.
        directory.listFiles()?.forEach { file ->
            require(file.isFile && (file.extension == "bin" || file.extension == "tmp"))
            check(file.delete())
        }
    } }
    companion object {
        private val processLock = Mutex()
        @Synchronized fun forApp(context: Context, namespace: String? = null,
                                 createKeyIfMissing: Boolean = true): EncryptedSyncStore {
            require(namespace == null || Regex("[a-f0-9]{64}").matches(namespace))
            val alias = "health-ai-bridge-sync-v1"
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = keyStore.getKey(alias, null) as? SecretKey
            check(existing != null || createKeyIfMissing) { "Existing sync key unavailable" }
            val key = existing ?: KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build())
            }.generateKey()
            val directory = File(context.noBackupFilesDir,"sync-state")
            return EncryptedSyncStore(if (namespace == null) directory else File(directory,namespace), key)
        }
    }
}
