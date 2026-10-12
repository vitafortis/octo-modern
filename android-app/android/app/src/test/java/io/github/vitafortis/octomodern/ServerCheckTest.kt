package io.github.vitafortis.octomodern

import io.github.vitafortis.octomodern.net.ServerCheck
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The first-launch check against a local stand-in server (plain http on 127.0.0.1 is allowed: private). */
@RunWith(RobolectricTestRunner::class)
class ServerCheckTest {
    private lateinit var server: MockWebServer
    private val client = OkHttpClient.Builder().followRedirects(false).build()
    private var health = MockResponse().setBody("""{"ok":true,"app":"octo-modern"}""")
    private var manifest = MockResponse().setResponseCode(404)

    @Before fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = when (request.path) {
                "/api/health" -> health
                "/manifest.webmanifest" -> manifest
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private val address get() = "http://127.0.0.1:${server.port}"

    @Test fun recognisesOctoModern() {
        val r = ServerCheck.check("$address/some/page", client)
        assertEquals(ServerCheck.Result.Ok(address, insecure = true), r)
    }

    @Test fun olderServersByTheirManifest() {
        health = MockResponse().setBody("""{"ok":true}""")
        manifest = MockResponse().setBody("""{"name":"octo·modern","short_name":"octo·modern"}""")
        assertTrue(ServerCheck.check(address, client) is ServerCheck.Result.Ok)
    }

    @Test fun somethingElse() {
        health = MockResponse().setResponseCode(404)
        val r = ServerCheck.check(address, client) as ServerCheck.Result.Problem
        assertTrue(r.message, r.message.contains("isn’t octo·modern"))
        health = MockResponse().setBody("<html>OctoPrint</html>")
        assertTrue(ServerCheck.check(address, client) is ServerCheck.Result.Problem)
        health = MockResponse().setBody("""{"ok":true}""")
        manifest = MockResponse().setBody("""{"name":"Something else"}""")
        assertTrue(ServerCheck.check(address, client) is ServerCheck.Result.Problem)
    }

    @Test fun suggestsHttpsWhenTheServerRedirects() {
        health = MockResponse().setResponseCode(301).setHeader("Location", "https://127.0.0.1/api/health")
        val r = ServerCheck.check(address, client) as ServerCheck.Result.Problem
        assertEquals("https://127.0.0.1", r.suggestion)
    }

    @Test fun unreachable() {
        val port = server.port
        server.shutdown()
        val r = ServerCheck.check("http://127.0.0.1:$port", client) as ServerCheck.Result.Problem
        assertTrue(r.message, r.message.contains("127.0.0.1"))
    }

    @Test fun publicHttpIsRefusedBeforeAnyRequest() {
        val r = ServerCheck.check("http://print.example.com", client) as ServerCheck.Result.Problem
        assertTrue(r.message.contains("https"))
        assertEquals(0, server.requestCount)
    }
}
