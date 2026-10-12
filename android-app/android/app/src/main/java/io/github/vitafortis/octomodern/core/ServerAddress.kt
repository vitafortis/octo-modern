package io.github.vitafortis.octomodern.core

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * The server address you type on first launch, normalised to an origin
 * (`https://print.example.com`, `http://192.168.1.20:3000`).
 *
 * - https anywhere; plain http only for private addresses (RFC 1918, CGNAT/Tailscale,
 *   link-local, loopback, IPv6 ULA) and local names (`.local`, `.lan`, `.home.arpa`,
 *   `.internal`, single-label hosts), and then with a warning.
 * - No scheme means https. Paths, queries and fragments are dropped (octo·modern runs at
 *   the root of its address). Credentials in the URL are refused.
 */
object ServerAddress {
    sealed class Parsed {
        /** `insecure`: plain http on a private network; the setup screen warns before continuing. */
        data class Ok(val origin: String, val host: String, val insecure: Boolean) : Parsed()
        data class Invalid(val message: String) : Parsed()
    }

    fun parse(input: String): Parsed {
        val raw = input.trim()
        if (raw.isEmpty()) return Parsed.Invalid("Enter your octo·modern address")
        if (raw.any { it.isWhitespace() }) return Parsed.Invalid("The address can’t contain spaces")
        val withScheme = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(raw)) raw else "https://$raw"
        val uri = try {
            URI(withScheme)
        } catch (e: URISyntaxException) {
            return Parsed.Invalid("That doesn’t look like a web address")
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "https" && scheme != "http") return Parsed.Invalid("Use an https:// address")
        if (uri.rawUserInfo != null) return Parsed.Invalid("Leave the user name and password out of the address")
        val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.')
        if (host.isNullOrEmpty()) return Parsed.Invalid("That doesn’t look like a web address")
        val port = uri.port
        if (port == 0 || port > 65535) return Parsed.Invalid("The port must be between 1 and 65535")
        val insecure = scheme == "http"
        if (insecure && !isPrivateHost(host)) {
            return Parsed.Invalid("Plain http is only allowed on your local network. Use https:// for $host")
        }
        val defaultPort = if (scheme == "https") 443 else 80
        val portPart = if (port == -1 || port == defaultPort) "" else ":$port"
        val hostPart = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        return Parsed.Ok("$scheme://$hostPart$portPart", host.removePrefix("[").removeSuffix("]"), insecure)
    }

    /** Whether `host` is on a private network: where plain http is tolerated. */
    fun isPrivateHost(rawHost: String): Boolean {
        val host = rawHost.lowercase(Locale.ROOT).removePrefix("[").removeSuffix("]").trimEnd('.')
        if (host == "localhost" || host.endsWith(".localhost")) return true
        ipv4(host)?.let { o ->
            return o[0] == 10 ||
                o[0] == 127 ||
                (o[0] == 172 && o[1] in 16..31) ||
                (o[0] == 192 && o[1] == 168) ||
                (o[0] == 169 && o[1] == 254) ||
                (o[0] == 100 && o[1] in 64..127)
        }
        if (host.contains(':')) {
            if (host == "::1") return true
            val first = host.substringBefore(':').ifEmpty { "0" }
            val word = first.toIntOrNull(16) ?: return false
            return (word and 0xfe00) == 0xfc00 || (word and 0xffc0) == 0xfe80
        }
        if (!host.contains('.')) return true
        return LOCAL_SUFFIXES.any { host.endsWith(it) }
    }

    private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain", ".intranet")

    private fun ipv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for ((i, p) in parts.withIndex()) {
            if (p.isEmpty() || p.length > 3 || !p.all { it.isDigit() }) return null
            val n = p.toInt()
            if (n > 255) return null
            out[i] = n
        }
        return out
    }

    /** Whether `url` is on `origin` (same scheme, host and port): such links stay in the app. */
    fun sameOrigin(origin: String, url: String): Boolean {
        val a = try { URI(origin) } catch (e: URISyntaxException) { return false }
        val b = try { URI(url) } catch (e: URISyntaxException) { return false }
        if (a.scheme == null || b.scheme == null || a.host == null || b.host == null) return false
        return a.scheme.equals(b.scheme, ignoreCase = true) &&
            a.host.equals(b.host, ignoreCase = true) &&
            effectivePort(a) == effectivePort(b)
    }

    private fun effectivePort(u: URI): Int = if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80

    /** A path within the server for deep links (`/p/<id>`), or null when it isn't one. */
    fun safePath(path: String?): String? {
        if (path.isNullOrEmpty() || !path.startsWith("/") || path.startsWith("//")) return null
        if (path.any { it.isWhitespace() || it == '\\' }) return null
        return path
    }
}
