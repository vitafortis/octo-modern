package io.github.vitafortis.octomodern

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.CookieManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.vitafortis.octomodern.core.ServerAddress
import io.github.vitafortis.octomodern.data.Tokens
import io.github.vitafortis.octomodern.net.Api
import io.github.vitafortis.octomodern.net.ServerCheck
import io.github.vitafortis.octomodern.watch.Notifier
import io.github.vitafortis.octomodern.watch.StatusWorker
import io.github.vitafortis.octomodern.watch.Watch

/**
 * What the app's own pages (www/: setup and settings) can ask of the native side. Only
 * those local pages can call it: the server's pages don't get Capacitor's bridge (they
 * aren't in `allowNavigation`), and every method checks the WebView is on a local page.
 */
@CapacitorPlugin(name = "OctoModern")
class OctoModernPlugin : Plugin() {
    private val shell get() = activity as MainActivity

    private fun local(call: PluginCall): Boolean {
        if (shell.isLocalPage()) return true
        call.reject("Not available on this page")
        return false
    }

    /** Links to the server stay in the app; `octomodern://` links are the app's own; the rest open in the browser. */
    override fun shouldOverrideLoad(url: Uri): Boolean? {
        if (url.scheme == "octomodern") {
            when (url.host) {
                "settings" -> shell.showLocal("settings")
                "server" -> shell.openServer(null)
            }
            return true
        }
        val server = shell.settings.server
        if (server != null && ServerAddress.sameOrigin(server, url.toString())) return false
        return null
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        if (!local(call)) return
        val s = shell.settings
        val server = s.server
        val token = server?.let { Tokens.store(context).token(it) }
        val pm = context.getSystemService(PowerManager::class.java)
        val out = JSObject()
            .put("server", server)
            .put("version", BuildConfig.VERSION_NAME)
            .put("android", Build.VERSION.SDK_INT)
            .put("linked", token != null)
            .put("notifications", s.notifications)
            .put("keepWatching", s.keepWatching)
            .put("notificationsAllowed", Notifier.allowed(context))
            .put("batteryExempt", pm.isIgnoringBatteryOptimizations(context.packageName))
            .put("biometricLock", s.biometricLock)
            .put("biometricAvailable", MainActivity.canLock(context))
            .put("lockAfterMinutes", s.lockAfterMinutes)
        if (server == null || token == null) return call.resolve(out)
        // Who the device token acts as (best effort; offline is fine).
        Thread {
            try {
                val me = Api(server, token).current().optJSONObject("user")
                if (me != null) out.put("account", JSObject().put("name", me.optString("name")).put("email", me.optString("email")).put("role", me.optString("role")))
            } catch (e: Exception) {
                out.put("accountError", e.message)
            }
            call.resolve(out)
        }.start()
    }

    @PluginMethod
    fun checkServer(call: PluginCall) {
        if (!local(call)) return
        val url = call.getString("url") ?: ""
        Thread {
            when (val r = ServerCheck.check(url)) {
                is ServerCheck.Result.Ok -> call.resolve(JSObject().put("ok", true).put("origin", r.origin).put("insecure", r.insecure))
                is ServerCheck.Result.Problem -> call.resolve(JSObject().put("ok", false).put("message", r.message).put("suggestion", r.suggestion))
            }
        }.start()
    }

    /** Saves a checked server and opens it. Switching servers signs this device out of the old one. */
    @PluginMethod
    fun connect(call: PluginCall) {
        if (!local(call)) return
        val parsed = ServerAddress.parse(call.getString("origin") ?: "")
        if (parsed !is ServerAddress.Parsed.Ok) return call.reject((parsed as ServerAddress.Parsed.Invalid).message)
        Thread {
            val old = shell.settings.server
            if (old != null && old != parsed.origin) {
                shell.forgetDevice(revoke = true)
                CookieManager.getInstance().removeAllCookies(null)
            }
            shell.settings.server = parsed.origin
            StatusWorker.schedule(context)
            shell.openServer(null)
            call.resolve()
        }.start()
    }

    @PluginMethod
    fun saveSettings(call: PluginCall) {
        if (!local(call)) return
        val s = shell.settings
        call.getBoolean("notifications")?.let {
            s.notifications = it
            if (!it) Watch.stop(context)
        }
        call.getBoolean("keepWatching")?.let { s.keepWatching = it }
        call.getInt("lockAfterMinutes")?.let { s.lockAfterMinutes = it.coerceIn(0, 24 * 60) }
        call.getBoolean("biometricLock")?.let {
            if (it && !MainActivity.canLock(context)) return call.reject("Set up a screen lock or fingerprint on this phone first")
            s.biometricLock = it
            if (Build.VERSION.SDK_INT >= 33) activity.runOnUiThread { activity.setRecentsScreenshotEnabled(!it) }
        }
        StatusWorker.schedule(context)
        call.resolve()
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (!local(call)) return
        activity.runOnUiThread { shell.requestNotificationPermission { granted -> call.resolve(JSObject().put("allowed", granted)) } }
    }

    /** Lets the 15-minute check start live progress from the background (Android 12+ needs this). */
    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        if (!local(call)) return
        val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        try {
            activity.startActivity(i)
        } catch (e: Exception) {
            activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        call.resolve()
    }

    /** Signs out: this device's token, the WebView session, cookies. Then the server's sign-in page. */
    @PluginMethod
    fun signOut(call: PluginCall) {
        if (!local(call)) return
        Thread {
            endSession()
            shell.openServer("/login")
            call.resolve()
        }.start()
    }

    /** Signs out and forgets the server: back to the setup page. */
    @PluginMethod
    fun forgetServer(call: PluginCall) {
        if (!local(call)) return
        Thread {
            endSession()
            shell.settings.server = null
            StatusWorker.cancel(context)
            shell.showLocal("setup")
            call.resolve()
        }.start()
    }

    private fun endSession() {
        val server = shell.settings.server ?: return
        shell.forgetDevice(revoke = true)
        CookieManager.getInstance().getCookie(server)?.let { Api(server, null).logout(it) }
        val done = java.util.concurrent.CountDownLatch(1)
        activity.runOnUiThread { CookieManager.getInstance().removeAllCookies { done.countDown() } }
        done.await(3, java.util.concurrent.TimeUnit.SECONDS)
        CookieManager.getInstance().flush()
    }

    @PluginMethod
    fun openServer(call: PluginCall) {
        if (!local(call)) return
        shell.openServer(call.getString("path"))
        call.resolve()
    }

    @PluginMethod
    fun openExternal(call: PluginCall) {
        if (!local(call)) return
        val url = call.getString("url") ?: return call.reject("No URL")
        if (!url.startsWith("https://")) return call.reject("Only https links")
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        call.resolve()
    }
}
