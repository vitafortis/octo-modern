package io.github.vitafortis.octomodern

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import io.github.vitafortis.octomodern.core.ServerAddress
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.data.Tokens
import io.github.vitafortis.octomodern.net.Api
import io.github.vitafortis.octomodern.net.ApiException
import io.github.vitafortis.octomodern.ui.Downloads
import io.github.vitafortis.octomodern.ui.PageScript
import io.github.vitafortis.octomodern.watch.Notifier
import io.github.vitafortis.octomodern.watch.StatusSync
import io.github.vitafortis.octomodern.watch.StatusWorker
import io.github.vitafortis.octomodern.watch.Watch
import io.github.vitafortis.octomodern.widget.WidgetUpdater
import org.json.JSONObject

/**
 * The app shell: Capacitor's WebView showing your octo·modern server, plus the app's own
 * pages (first-launch setup and app settings, bundled in www/ and served by Capacitor at
 * https://localhost). Links to the server stay in the app; anything else opens in the
 * browser ([OctoModernPlugin.shouldOverrideLoad]).
 *
 * After you sign in on the server, the app links this device (POST /api/account/devices
 * with the WebView's session cookie) and keeps the returned token for notifications and
 * widgets.
 */
class MainActivity : BridgeActivity() {
    lateinit var settings: AppSettings
        private set
    private val main = Handler(Looper.getMainLooper())
    @Volatile var currentUrl: String? = null
        private set
    private var linking = false
    private var lastLinkAttempt = 0L
    private var configuredOrigin: String? = null
    private var startScript: ScriptHandler? = null
    private var backgroundedAt = 0L
    private var lockView: View? = null
    private var verifiedToken = false
    private var permissionCallback: ((Boolean) -> Unit)? = null

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionCallback?.invoke(granted)
        permissionCallback = null
        if (granted) checkPrints()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        registerPlugin(OctoModernPlugin::class.java)
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)
        val web = bridge.webView
        web.settings.userAgentString = "${web.settings.userAgentString} OctoModernAndroid/${BuildConfig.VERSION_NAME}"
        web.settings.setSupportMultipleWindows(false)
        web.setDownloadListener(Downloads.listener(this) { settings.server })
        bridge.setWebViewClient(ShellClient())
        CookieManager.getInstance().setAcceptCookie(true)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val w = bridge.webView
                    if (w.canGoBack()) w.goBack() else finish()
                }
            },
        )
        route(intent, coldStart = true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // BridgeActivity calls this from onCreate too, before we're set up.
        if (!::settings.isInitialized) return
        setIntent(intent)
        route(intent, coldStart = false)
    }

    // --- where the WebView goes -----------------------------------------------------------

    private fun route(intent: Intent?, coldStart: Boolean) {
        val data = intent?.data
        val server = settings.server
        if (data?.scheme == "octomodern") {
            when (data.host) {
                "settings" -> return showLocal("settings")
                "printer" -> {
                    val id = data.pathSegments.firstOrNull()
                    if (server != null && id != null) return openServer("/p/${Uri.encode(id)}")
                }
            }
        }
        if (server == null) return showLocal("setup")
        if (coldStart || currentUrl == null) openServer(null)
    }

    /** One of the app's own pages: `setup`, `settings`, `offline`. */
    fun showLocal(page: String) {
        main.post { bridge.webView.loadUrl("${bridge.localUrl}/#$page") }
    }

    /** The server (or a path on it). */
    fun openServer(path: String?) {
        main.post {
            val origin = settings.server
            if (origin == null) {
                showLocal("setup")
            } else {
                configureForServer(origin)
                bridge.webView.loadUrl(origin + (ServerAddress.safePath(path) ?: "/"))
            }
        }
    }

    fun isLocalPage(): Boolean = currentUrl?.startsWith(bridge.localUrl) ?: true

    /** The page script and its message channel, for the server's origin only. */
    private fun configureForServer(origin: String) {
        if (configuredOrigin == origin) return
        val web = bridge.webView
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            if (configuredOrigin != null) WebViewCompat.removeWebMessageListener(web, PageScript.BRIDGE)
            WebViewCompat.addWebMessageListener(web, PageScript.BRIDGE, setOf(origin)) { _, message, sourceOrigin, isMainFrame, _ ->
                if (isMainFrame && ServerAddress.sameOrigin(origin, sourceOrigin.toString())) onPageMessage(message.data ?: "")
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            startScript?.remove()
            startScript = WebViewCompat.addDocumentStartJavaScript(web, PageScript.SOURCE, setOf(origin))
        }
        configuredOrigin = origin
    }

    private fun onPageMessage(raw: String) {
        val m = try { JSONObject(raw) } catch (e: Exception) { return }
        when (m.optString("type")) {
            "signedOut" -> Thread { forgetDevice(revoke = true) }.start()
            "download" -> main.post { Downloads.saveDataUrl(this, m.optString("name"), m.optString("data")) }
        }
    }

    private inner class ShellClient : BridgeWebViewClient(bridge) {
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            currentUrl = url
            super.onPageStarted(view, url, favicon)
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) settings.server?.let { if (ServerAddress.sameOrigin(it, url)) view.evaluateJavascript(PageScript.SOURCE, null) }
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            super.doUpdateVisitedHistory(view, url, isReload)
            currentUrl = url
            onServerPage(url)
        }

        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            currentUrl = url
            onServerPage(url)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            super.onReceivedError(view, request, error)
            val server = settings.server ?: return
            if (request.isForMainFrame && ServerAddress.sameOrigin(server, request.url.toString())) {
                showLocal("offline?url=${Uri.encode(request.url.toString())}&error=${Uri.encode(error.description?.toString() ?: "")}")
            }
        }
    }

    // --- linking this device after sign-in ---------------------------------------------------

    private fun onServerPage(url: String) {
        val server = settings.server ?: return
        if (!ServerAddress.sameOrigin(server, url)) return
        val path = Uri.parse(url).path ?: "/"
        if (path.startsWith("/login") || path.startsWith("/setup") || path.startsWith("/auth")) return
        maybeLinkDevice(server)
    }

    private fun maybeLinkDevice(server: String) {
        val store = Tokens.store(this)
        if (store.get(server) != null || linking) return
        val now = System.currentTimeMillis()
        if (now - lastLinkAttempt < 15_000) return
        val cookie = CookieManager.getInstance().getCookie(server) ?: return
        if (!cookie.contains("ocm_session=")) return
        linking = true
        lastLinkAttempt = now
        Thread {
            try {
                val (token, id) = Api(server, null).linkDevice(cookie, deviceName())
                if (settings.server == server) store.save(server, token, id)
                main.post { afterLinked() }
            } catch (e: Exception) {
                // Not signed in yet, or the server is busy: tried again on the next page.
            } finally {
                linking = false
            }
        }.start()
    }

    private fun afterLinked() {
        StatusWorker.schedule(this)
        if (Build.VERSION.SDK_INT >= 33 && !settings.askedNotificationPermission &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            settings.askedNotificationPermission = true
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            checkPrints()
        }
    }

    fun requestNotificationPermission(done: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < 33) {
            done(Notifier.allowed(this))
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            done(Notifier.allowed(this))
            return
        }
        if (settings.askedNotificationPermission && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            // Denied for good: only the system settings can turn them on now.
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            done(false)
            return
        }
        settings.askedNotificationPermission = true
        permissionCallback = done
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** `Pixel 8` (the name set on the phone where Android shares it, else the model). */
    private fun deviceName(): String {
        val named = try { Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) } catch (e: Exception) { null }
        val model = if (Build.MODEL.startsWith(Build.MANUFACTURER, ignoreCase = true)) Build.MODEL else "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
        return (named?.takeIf { it.isNotBlank() } ?: model).take(60) + " (Android app)"
    }

    /**
     * Signs this device out: revokes its token on the server (when `revoke`), forgets it,
     * stops watching and clears cached state. Blocking; call off the main thread.
     */
    fun forgetDevice(revoke: Boolean) {
        val server = settings.server ?: return
        val store = Tokens.store(this)
        val token = store.token(server)
        if (revoke && token != null) {
            try {
                Api(server, token).revokeCurrent()
            } catch (e: Exception) {
                // Already revoked or unreachable; My account can still remove it.
            }
        }
        store.clear()
        main.post {
            Watch.stop(this)
            settings.clearCache()
            WidgetUpdater.updateAll(this, null)
        }
    }

    // --- watching prints while the app is open ---------------------------------------------

    private val checker = object : Runnable {
        override fun run() {
            checkPrints()
            main.postDelayed(this, 30_000)
        }
    }

    /** Starts the progress notifications when a print is running (the app is in front, so Android allows it). */
    private fun checkPrints() {
        val server = settings.server ?: return
        if (!settings.notifications || !Notifier.allowed(this)) return
        val token = Tokens.store(this).token(server)
        val api = Api(server, token)
        Thread {
            try {
                if (token != null && !verifiedToken) {
                    api.current()
                    verifiedToken = true
                }
                val round = StatusSync.fetch(this, api)
                main.post { WidgetUpdater.updateAll(this, round) }
                if (round.active.isNotEmpty()) main.post { Watch.start(this, fromBackground = false) }
            } catch (e: ApiException) {
                if (e.status == 401 && token != null) {
                    // Revoked from My account: link again on the next signed-in page.
                    Tokens.store(this).clear()
                }
            } catch (e: Exception) {
                // Offline: the WebView shows that.
            }
        }.start()
    }

    override fun onResume() {
        super.onResume()
        main.removeCallbacks(checker)
        main.postDelayed(checker, 1_500)
    }

    override fun onPause() {
        main.removeCallbacks(checker)
        super.onPause()
    }

    // --- biometric lock ------------------------------------------------------------------

    override fun onStart() {
        super.onStart()
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!settings.biometricLock)
        if (settings.biometricLock && lockView == null && canLock(this)) {
            val away = System.currentTimeMillis() - backgroundedAt
            if (backgroundedAt == 0L || away >= settings.lockAfterMinutes * 60_000L) lock()
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) {
            backgroundedAt = System.currentTimeMillis()
            if (!settings.keepWatching) Watch.stop(this)
        }
    }

    private fun lock() {
        val v = LayoutInflater.from(this).inflate(R.layout.lock_overlay, null)
        addContentView(v, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        v.findViewById<View>(R.id.unlock).setOnClickListener { prompt() }
        lockView = v
        main.post { prompt() }
    }

    private fun unlock() {
        lockView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        lockView = null
    }

    private fun prompt() {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock octo·modern")
            .setSubtitle("Use your fingerprint, face or screen lock")
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    unlock()
                }
            },
        ).authenticate(info)
    }

    companion object {
        val AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL

        fun canLock(context: android.content.Context): Boolean =
            BiometricManager.from(context).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
    }
}
