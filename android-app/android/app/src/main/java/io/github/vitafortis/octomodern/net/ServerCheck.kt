package io.github.vitafortis.octomodern.net

import io.github.vitafortis.octomodern.core.ServerAddress
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Checks that an address is an octo·modern server before the app opens it: GET
 * /api/health must answer `{ ok: true, app: "octo-modern" }` (older servers answer
 * `{ ok: true }`; then the web manifest's name must be octo·modern's).
 */
object ServerCheck {
    sealed class Result {
        data class Ok(val origin: String, val insecure: Boolean) : Result()
        data class Problem(val message: String, val suggestion: String? = null) : Result()
    }

    fun check(input: String, client: OkHttpClient = Api.shared): Result {
        val parsed = ServerAddress.parse(input)
        if (parsed is ServerAddress.Parsed.Invalid) return Result.Problem(parsed.message)
        val ok = parsed as ServerAddress.Parsed.Ok
        val origin = ok.origin
        return try {
            val req = Request.Builder().url("$origin/api/health").header("Accept", "application/json").header("User-Agent", Api.USER_AGENT).build()
            client.newCall(req).execute().use { res ->
                if (res.isRedirect) {
                    val loc = res.header("location") ?: ""
                    val target = ServerAddress.parse(loc)
                    if (target is ServerAddress.Parsed.Ok && target.host == ok.host && target.origin.startsWith("https://") && origin.startsWith("http://")) {
                        return Result.Problem("This server uses https.", target.origin)
                    }
                    return Result.Problem("The address redirects elsewhere ($loc). Enter the address octo·modern runs at.")
                }
                if (res.code == 404) return Result.Problem("Something answers at $origin, but it isn’t octo·modern.")
                if (!res.isSuccessful) return Result.Problem("The server answered HTTP ${res.code}. Check the address.")
                val body = res.body?.string() ?: ""
                val o = try {
                    JSONObject(body)
                } catch (e: Exception) {
                    return Result.Problem("Something answers at $origin, but it isn’t octo·modern.")
                }
                if (!o.optBoolean("ok")) return Result.Problem("Something answers at $origin, but it isn’t octo·modern.")
                if (o.optString("app") == "octo-modern" || manifestLooksRight(origin, client)) Result.Ok(origin, ok.insecure)
                else Result.Problem("Something answers at $origin, but it isn’t octo·modern.")
            }
        } catch (e: UnknownHostException) {
            Result.Problem("Can’t find ${ok.host}. Check the address, and that this phone is on the right network or VPN.")
        } catch (e: SSLException) {
            Result.Problem("The server’s certificate isn’t trusted by this phone (${e.message ?: "TLS error"}).")
        } catch (e: SocketTimeoutException) {
            Result.Problem("$origin didn’t answer in time. Is the server running and reachable from this phone?")
        } catch (e: ConnectException) {
            Result.Problem("Can’t connect to $origin. Is the server running and reachable from this phone?")
        } catch (e: IOException) {
            Result.Problem("Can’t reach $origin: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun manifestLooksRight(origin: String, client: OkHttpClient): Boolean = try {
        client.newCall(Request.Builder().url("$origin/manifest.webmanifest").build()).execute().use { res ->
            res.isSuccessful && JSONObject(res.body?.string() ?: "{}").optString("name").contains("octo", ignoreCase = true)
        }
    } catch (e: Exception) {
        false
    }
}
