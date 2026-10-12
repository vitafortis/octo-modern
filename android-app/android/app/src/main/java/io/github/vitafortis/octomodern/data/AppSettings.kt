package io.github.vitafortis.octomodern.data

import android.content.Context
import android.content.SharedPreferences
import io.github.vitafortis.octomodern.net.Api

/** App preferences (not secret). The device token lives in [TokenStore]. */
class AppSettings(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE))

    /** The server's origin, e.g. `https://print.example.com`; null before first setup. */
    var server: String?
        get() = prefs.getString("server", null)
        set(v) = prefs.edit().putString("server", v).apply()

    /** Progress notifications for prints (and the completion notice). */
    var notifications: Boolean
        get() = prefs.getBoolean("notifications", true)
        set(v) = prefs.edit().putBoolean("notifications", v).apply()

    /** Keep following prints while the app is in the background (foreground service + 15-minute check). */
    var keepWatching: Boolean
        get() = prefs.getBoolean("keepWatching", true)
        set(v) = prefs.edit().putBoolean("keepWatching", v).apply()

    var biometricLock: Boolean
        get() = prefs.getBoolean("biometricLock", false)
        set(v) = prefs.edit().putBoolean("biometricLock", v).apply()

    /** Minutes in the background before the lock asks again (0: every time). */
    var lockAfterMinutes: Int
        get() = prefs.getInt("lockAfterMinutes", 5)
        set(v) = prefs.edit().putInt("lockAfterMinutes", v).apply()

    /** Asked for POST_NOTIFICATIONS once already (Android 13+). */
    var askedNotificationPermission: Boolean
        get() = prefs.getBoolean("askedNotifications", false)
        set(v) = prefs.edit().putBoolean("askedNotifications", v).apply()

    // --- widgets: which printer each widget shows -----------------------------------------

    fun widgetPrinter(widgetId: Int): String? = prefs.getString("widget.$widgetId", null)
    fun setWidgetPrinter(widgetId: Int, printerId: String) = prefs.edit().putString("widget.$widgetId", printerId).apply()
    fun removeWidget(widgetId: Int) = prefs.edit().remove("widget.$widgetId").apply()

    /** Last known printers and statuses (JSON), so widgets render without a network round trip. */
    var cachedPrinters: String?
        get() = prefs.getString("cache.printers", null)
        set(v) = prefs.edit().putString("cache.printers", v).apply()
    var cachedStatuses: String?
        get() = prefs.getString("cache.statuses", null)
        set(v) = prefs.edit().putString("cache.statuses", v).apply()
    var cachedAt: Long
        get() = prefs.getLong("cache.at", 0)
        set(v) = prefs.edit().putLong("cache.at", v).apply()

    fun clearCache() = prefs.edit().remove("cache.printers").remove("cache.statuses").remove("cache.at").apply()

    companion object {
        const val PREFS = "octomodern.settings"

        /** The API client for the configured server, with the device token if there is one. */
        fun api(context: Context): Api? {
            val s = AppSettings(context)
            val origin = s.server ?: return null
            return Api(origin, Tokens.store(context).token(origin))
        }
    }
}

object Tokens {
    fun store(context: Context): TokenStore =
        TokenStore(context.applicationContext.getSharedPreferences(TokenStore.PREFS, Context.MODE_PRIVATE), KeystoreCipher())
}
