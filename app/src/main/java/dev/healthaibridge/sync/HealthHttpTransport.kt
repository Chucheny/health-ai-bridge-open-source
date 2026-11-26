package dev.healthaibridge.sync

import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import javax.net.ssl.HttpsURLConnection

// Instance configuration is supplied by the user, never compiled into the APK.
// A plain class avoids a generated toString() that could expose its token.
class CloudConnection(baseUrl: String, private val token: String) {
    val origin: String
    init {
        val uri = URI(baseUrl)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in listOf("", "/") &&
            uri.port in listOf(-1, 443)) { "Invalid HTTPS service address" }
        require(Regex("[A-Za-z0-9_-]{43}").matches(token)) { "Invalid device credential" }
        origin = "https://" + uri.host.lowercase()
    }
    internal fun headers() = mapOf("Authorization" to "Bearer $token", "Accept" to "application/json")
    override fun toString() = "CloudConnection(redacted)"
}
// Headers and bodies deliberately have no generated toString either.
class CloudRequest(val url: String, val method: String, val headers: Map<String, String>, val body: ByteArray?)
class CloudResponse(val status: Int, val contentType: String?, val body: ByteArray)
fun interface CloudExchange { suspend fun execute(request: CloudRequest): CloudResponse }
internal class SyncExchangeInterrupted : IOException()

class HttpsCloudExchange : CloudExchange {
    override suspend fun execute(request: CloudRequest): CloudResponse = withContext(Dispatchers.IO) {
        currentCoroutineContext().ensureActive()
        val connection = URI(request.url).toURL().openConnection() as HttpsURLConnection
        try {
            // Keep platform certificate/hostname validation. Never follow redirects with credentials.
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.useCaches = false
            connection.requestMethod = request.method
            request.headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
            request.body?.let { bytes ->
                require(bytes.size <= 2_097_152)
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val body = if (status in 200..299) connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count == -1) break
                    if (output.size() + count > 4_194_304) throw SyncRejected()
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } else {
                connection.errorStream?.close()
                byteArrayOf() // Never parse/log an error page or provider error details.
            }
            currentCoroutineContext().ensureActive()
            CloudResponse(status, connection.contentType, body)
        } finally { connection.disconnect() }
    }
}

class HealthHttpTransport(private val connection: CloudConnection,
                          private val exchange: CloudExchange = HttpsCloudExchange()) : SyncTransport {
    private fun hasBooleanTrue(data: JsonObject, field: String): Boolean {
        val value = data[field] ?: return false
        return value.isJsonPrimitive && value.asJsonPrimitive.isBoolean && value.asBoolean
    }
    private suspend fun request(path: String, method: String, body: String? = null,
                                extra: Map<String, String> = emptyMap()): JsonObject {
        currentCoroutineContext().ensureActive()
        val cloudRequest = CloudRequest(connection.origin + "/api/health/" + path, method,
            connection.headers() + extra + if (body != null) mapOf("Content-Type" to "application/json; charset=utf-8") else emptyMap(),
            body?.toByteArray(Charsets.UTF_8))
        val response = try {
            exchange.execute(cloudRequest)
        } catch (interrupted: IOException) {
            if (path == "sync") throw SyncExchangeInterrupted()
            throw interrupted
        }
        currentCoroutineContext().ensureActive()
        when {
            path == "sync/receipt" && response.status in listOf(404, 405) ->
                return JsonObject().apply { add("receipt", JsonNull.INSTANCE) }
            response.status == 401 || response.status == 403 -> throw SyncAuthenticationRequired()
            response.status == 409 -> throw SyncConflict()
            retryableHttpStatus(response.status) -> throw IOException("Cloud temporarily unavailable")
            response.status !in 200..299 -> throw SyncRejected()
        }
        if (response.body.size > 4_194_304 || response.contentType?.substringBefore(';')?.trim()?.lowercase() != "application/json") throw SyncRejected()
        return try { JsonParser.parseString(response.body.toString(Charsets.UTF_8)).asJsonObject }
        catch (_: RuntimeException) { throw SyncConflict() }
    }
    override suspend fun send(batch: PendingBatch): Receipt {
        require(batch.body.toByteArray(Charsets.UTF_8).size <= 2_097_152)
        return parseReceipt(request("sync", "POST", batch.body))
    }
    override suspend fun recoverReceipt(batch: PendingBatch, recordType: String): Receipt? {
        val contentSha256 = MessageDigest.getInstance("SHA-256").digest(batch.body.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val selector = JsonObject().apply {
            addProperty("batchId", batch.batchId)
            addProperty("sequence", batch.sequence)
            addProperty("recordType", recordType)
            addProperty("contentSha256", contentSha256)
        }
        val result = request("sync/receipt", "POST", selector.toString())["receipt"] ?: throw SyncConflict()
        if (result.isJsonNull) return null
        if (!result.isJsonObject) throw SyncConflict()
        return parseReceipt(result.asJsonObject)
    }
    private fun parseReceipt(data: JsonObject): Receipt = try {
        val sequence = data["sequence"].asString
        require(Regex("[1-9][0-9]{0,15}").matches(sequence))
        val time = data["committedAt"].asString
        Instant.parse(time)
        require(data["committed"].isJsonPrimitive && data["committed"].asJsonPrimitive.isBoolean)
        Receipt(data["batchId"].asString, sequence.toLong(), data["committed"].asBoolean, time)
    } catch (_: RuntimeException) { throw SyncConflict() }
    suspend fun status(): JsonObject = request("status", "GET")
    suspend fun revoke() {
        val data = request("revoke", "POST")
        if (!hasBooleanTrue(data, "revoked")) throw SyncConflict()
    }
    suspend fun clearCloudData() {
        val data = request("data", "DELETE", extra = mapOf("X-Confirm-Clear" to "delete-all-my-cloud-health-data"))
        if (!hasBooleanTrue(data, "cleared") || !hasBooleanTrue(data, "allCredentialsRevoked")) throw SyncConflict()
    }
}
