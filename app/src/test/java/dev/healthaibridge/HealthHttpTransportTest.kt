package dev.healthaibridge

import com.google.gson.JsonObject
import dev.healthaibridge.sync.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class HealthHttpTransportTest {
    private val token = "a".repeat(43) // Synthetic only.
    private val config get() = CloudConnection("https://private.invalid/", token)
    private val pending = PendingBatch("11111111-1111-4111-8111-111111111111", 1, "{\"synthetic\":true}")
    private fun json(status: Int = 200, body: String = "{}", type: String = "application/json") = CloudResponse(status, type, body.toByteArray())
    private fun success(b: PendingBatch) = JsonObject().apply {
        addProperty("batchId", b.batchId); addProperty("sequence", b.sequence)
        addProperty("committed", true); addProperty("committedAt", "2026-01-01T00:00:00.123456789Z")
    }.toString()
    @Test fun rejectsInsecureOrAmbiguousDestinationsAndCredentials() {
        for (url in listOf("http://private.invalid", "https://user:pass@private.invalid", "https://private.invalid/path",
            "https://private.invalid?token=secret", "https://private.invalid#secret", "https://private.invalid:8443")) {
            assertThrows(IllegalArgumentException::class.java) { CloudConnection(url, token) }
        }
        assertThrows(IllegalArgumentException::class.java) { CloudConnection("https://private.invalid", "short") }
        assertFalse(config.toString().contains(token))
    }
    @Test fun sendsExactPersistedBodyAndCredentialInHeaderOnly() = runBlocking {
        val requests = mutableListOf<CloudRequest>()
        val transport = HealthHttpTransport(config, CloudExchange { r -> requests += r; json(body = success(pending)) })
        assertEquals(pending.batchId, transport.send(pending).batchId)
        transport.send(pending)
        assertEquals(2, requests.size)
        assertArrayEquals(pending.body.toByteArray(), requests[0].body)
        assertArrayEquals(requests[0].body, requests[1].body)
        assertEquals("Bearer $token", requests[0].headers["Authorization"])
        assertFalse(requests[0].url.contains(token))
        assertEquals("POST", requests[0].method)
    }
    @Test fun mapsRetryableErrorsAndRejectsAllRedirects() = runBlocking {
        for (status in listOf(408,429,500,502,503,504)) {
            try { HealthHttpTransport(config, CloudExchange { json(status) }).send(pending); fail() }
            catch (_: IOException) { }
        }
        for (status in listOf(301,302,303,307,308,400,413,415)) {
            var calls = 0
            try { HealthHttpTransport(config, CloudExchange { calls++; json(status) }).send(pending); fail() }
            catch (_: SyncRejected) { assertEquals(1, calls) }
        }
        for (status in listOf(401,403)) {
            try { HealthHttpTransport(config, CloudExchange { json(status) }).send(pending); fail() }
            catch (_: SyncAuthenticationRequired) { }
        }
    }
    @Test fun malformedReceiptNeverAdvancesEngineCursor() = runBlocking {
        for (body in listOf("{}", "[]", "broken", success(pending).replace("\"sequence\":1", "\"sequence\":1.5"),
            success(pending).replace("\"committed\":true", "\"committed\":\"true\""))) {
            try { HealthHttpTransport(config, CloudExchange { json(body = body) }).send(pending); fail() }
            catch (_: SyncConflict) { }
        }
        try { HealthHttpTransport(config, CloudExchange { json(type = "text/html") }).send(pending); fail() }
        catch (_: SyncRejected) { }
    }
    @Test fun lossOfAcknowledgementReplaysIdenticalRequestViaEngine() = runBlocking {
        val store = object : SyncStore {
            override val mutex = kotlinx.coroutines.sync.Mutex()
            var value = SyncState()
            override suspend fun load(metric: Metric) = value
            override suspend fun save(metric: Metric, state: SyncState) { value = state }
        }
        val requests = mutableListOf<CloudRequest>()
        val transport = HealthHttpTransport(config, CloudExchange { r ->
            requests += r
            if (requests.size == 1) throw IOException()
            val p = com.google.gson.JsonParser.parseString(r.body!!.toString(Charsets.UTF_8)).asJsonObject
            json(body = success(PendingBatch(p["batchId"].asString, p["sequence"].asLong, "")))
        })
        val engine = SyncEngine(store, SyncPageSource { _, _ -> SyncPage(emptyList(), "next", false) }, transport, SyncConsent { true })
        assertEquals(SyncOutcome.RETRY_REQUIRED, engine.run(Metric.HEART))
        assertNull(store.value.cursor)
        assertEquals(SyncOutcome.COMPLETE, engine.run(Metric.HEART))
        assertArrayEquals(requests[0].body, requests[1].body)
        assertEquals("next", store.value.cursor)
    }
    @Test fun cancellationIsNotConvertedIntoSuccessOrAutomaticRetry() = runBlocking {
        try { HealthHttpTransport(config, CloudExchange { throw CancellationException() }).send(pending); fail() }
        catch (_: CancellationException) { }
    }
    @Test fun statusRevokeAndClearUseAuthenticatedFixedRoutes() = runBlocking {
        val requests = mutableListOf<CloudRequest>()
        val transport = HealthHttpTransport(config, CloudExchange { r -> requests += r
            json(body = when { r.url.endsWith("status") -> "{\"streams\":[]}"
                r.url.endsWith("revoke") -> "{\"revoked\":true}"
                else -> "{\"cleared\":true,\"allCredentialsRevoked\":true}" })
        })
        transport.status(); transport.revoke(); transport.clearCloudData()
        assertEquals(listOf("GET","POST","DELETE"), requests.map { it.method })
        assertEquals("delete-all-my-cloud-health-data", requests.last().headers["X-Confirm-Clear"])
        assertTrue(requests.all { it.headers["Authorization"] == "Bearer $token" })
    }
    @Test fun revokeRequiresAnExplicitJsonBooleanConfirmation() = runBlocking {
        val invalidBodies = listOf("{}") + listOf("\"true\"", "\"TRUE\"", "1", "null", "[true]", "{}", "false")
            .map { "{\"revoked\":$it}" }
        for (body in invalidBodies) {
            try {
                HealthHttpTransport(config, CloudExchange { json(body = body) }).revoke()
                fail("A malformed revocation receipt must not confirm success")
            } catch (_: SyncConflict) { }
        }
    }
    @Test fun clearRequiresBothConfirmationsToBeExplicitJsonBooleans() = runBlocking {
        val invalidBodies = mutableListOf("{}", "{\"cleared\":true}", "{\"allCredentialsRevoked\":true}")
        for (value in listOf("\"true\"", "\"TRUE\"", "1", "null", "[true]", "{}", "false")) {
            invalidBodies += "{\"cleared\":$value,\"allCredentialsRevoked\":true}"
            invalidBodies += "{\"cleared\":true,\"allCredentialsRevoked\":$value}"
        }
        for (body in invalidBodies) {
            try {
                HealthHttpTransport(config, CloudExchange { json(body = body) }).clearCloudData()
                fail("A malformed clear receipt must not confirm success")
            } catch (_: SyncConflict) { }
        }
    }
    @Test fun cancellingControlRequestsPropagatesInsteadOfConfirmingOrBecomingConflict() = runBlocking {
        val transport = HealthHttpTransport(config, CloudExchange { throw CancellationException() })
        try { transport.revoke(); fail("Cancellation must propagate") }
        catch (_: CancellationException) { }
        try { transport.clearCloudData(); fail("Cancellation must propagate") }
        catch (_: CancellationException) { }
    }
}
