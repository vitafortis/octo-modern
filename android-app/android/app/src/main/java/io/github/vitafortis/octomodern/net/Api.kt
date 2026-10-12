package io.github.vitafortis.octomodern.net

import io.github.vitafortis.octomodern.BuildConfig
import io.github.vitafortis.octomodern.core.PrinterInfo
import io.github.vitafortis.octomodern.core.PrinterStatus
import io.github.vitafortis.octomodern.core.StatusParser
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : IOException(message)

/**
 * octo·modern's API, from native code. Calls carry the device token (`Authorization:
 * Bearer ocd_…`) when there is one; without it they go out anonymously, which works when
 * the server doesn't require sign-in. Blocking: call from a background thread.
 */
class Api(val origin: String, private val token: String?, private val client: OkHttpClient = shared) {
    private val json = "application/json".toMediaType()

    private fun request(path: String): Request.Builder {
        val b = Request.Builder().url(origin + path).header("Accept", "application/json").header("User-Agent", USER_AGENT)
        if (token != null) b.header("Authorization", "Bearer $token")
        return b
    }

    private fun <T> run(req: Request, read: (Response) -> T): T {
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                val msg = try {
                    JSONObject(res.body?.string() ?: "").optString("message")
                } catch (e: Exception) {
                    ""
                }
                throw ApiException(res.code, msg.ifEmpty { "HTTP ${res.code}" })
            }
            return read(res)
        }
    }

    private fun getString(path: String): String = run(request(path).get().build()) { it.body?.string() ?: "" }

    fun printers(): List<PrinterInfo> = StatusParser.printers(getString("/api/printers"))
    fun printersJson(): String = getString("/api/printers")
    fun statusesJson(): String = getString("/api/printers/status")
    fun statuses(): List<PrinterStatus> = StatusParser.statuses(statusesJson())

    /** pause | resume | cancel (cancel needs `confirm`). */
    fun job(printerId: String, command: String, confirm: Boolean = false) {
        val body = JSONObject().put("command", command).apply { if (confirm) put("confirm", true) }.toString().toRequestBody(json)
        run(request("/api/printers/${enc(printerId)}/job").post(body).build()) { }
    }

    /** Stops a pre-print preparation. */
    fun stopPreparing(printerId: String) {
        run(request("/api/printers/${enc(printerId)}/preprint").delete().build()) { }
    }

    /** A JPEG from the printer's webcam, or null when it has none (or it can't be reached). */
    fun snapshot(printerId: String): ByteArray? = try {
        run(request("/api/printers/${enc(printerId)}/webcam/snapshot").header("Accept", "image/*").get().build()) { res ->
            val type = res.header("content-type") ?: ""
            if (type.startsWith("image/")) res.body?.bytes() else null
        }
    } catch (e: IOException) {
        null
    }

    /** Who the device token acts as: `{ device, user: { name, email, role } }`. */
    fun current(): JSONObject = JSONObject(getString("/api/account/devices/current"))

    /** Signs this device out on the server. */
    fun revokeCurrent() {
        run(request("/api/account/devices/current").delete().build()) { }
    }

    /**
     * Links this device using the WebView's session cookie; returns `(token, deviceId)`.
     * Throws [ApiException] 401/400 when the session isn't signed in.
     */
    fun linkDevice(cookie: String, name: String): Pair<String, String?> {
        val body = JSONObject().put("name", name).put("platform", "android").toString().toRequestBody(json)
        val req = Request.Builder().url("$origin/api/account/devices").header("Cookie", cookie).header("User-Agent", USER_AGENT).post(body).build()
        return run(req) { res ->
            val o = JSONObject(res.body?.string() ?: "{}")
            o.getString("token") to o.optJSONObject("device")?.optString("id")
        }
    }

    /** Ends the WebView's session on the server (sign out). */
    fun logout(cookie: String) {
        val req = Request.Builder().url("$origin/api/auth/logout").header("Cookie", cookie).header("User-Agent", USER_AGENT)
            .post("{}".toRequestBody(json)).build()
        try {
            run(req) { }
        } catch (e: IOException) {
            // Best effort: the cookie is cleared locally either way.
        }
    }

    companion object {
        val USER_AGENT = "OctoModernAndroid/${BuildConfig.VERSION_NAME} (native)"
        val shared: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .followRedirects(false)
                .build()
        }

        private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    }
}
