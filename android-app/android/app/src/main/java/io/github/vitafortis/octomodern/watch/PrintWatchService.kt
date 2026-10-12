package io.github.vitafortis.octomodern.watch

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.vitafortis.octomodern.core.Notifications
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.data.Tokens
import io.github.vitafortis.octomodern.net.ApiException
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Follows prints while one is running (or being prepared): polls octo·modern every few
 * seconds with the device token and keeps one ongoing notification per printer, with
 * Pause/Resume and Cancel for people who may control it. Stops itself shortly after
 * nothing is printing.
 *
 * Foreground service type `specialUse` (Android 14+): none of the predefined types fit.
 * It isn't `dataSync` (nothing is transferred or synced; and Android 15 caps dataSync at
 * 6 hours a day, shorter than many prints), nor `remoteMessaging`/`mediaPlayback`. The
 * manifest declares the subtype ("live progress of the user's own 3D printers").
 *
 * Started by the app when it sees a print (allowed: the app is in the foreground), and by
 * the 15-minute check when Android lets it (see [Watch.start]).
 */
class PrintWatchService : Service() {
    private lateinit var executor: ScheduledExecutorService
    private var next: ScheduledFuture<*>? = null
    private var idleRounds = 0
    private var failingSince = 0L
    private var lastSnapshots = 0L
    private val shown = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        executor = Executors.newSingleThreadScheduledExecutor()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try {
            ServiceCompat.startForeground(this, Notifier.SUMMARY_ID, Notifier.summary(this, "Watching your prints"), type)
        } catch (e: Exception) {
            // Not allowed to run in the foreground right now (started from the background).
            Log.w(TAG, "startForeground refused", e)
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        if (intent?.action == ACTION_STOP) {
            finish()
            return START_NOT_STICKY
        }
        pollSoon(0)
        return START_NOT_STICKY
    }

    /** Polls right away (after a notification action), instead of waiting for the next round. */
    fun pollSoon(delayMs: Long) {
        executor.execute {
            next?.cancel(false)
            next = executor.schedule({ poll() }, delayMs, TimeUnit.MILLISECONDS)
        }
    }

    private fun poll() {
        val settings = AppSettings(this)
        val origin = settings.server
        if (origin == null || !settings.notifications || !Notifier.allowed(this)) return finish()
        val api = AppSettings.api(this) ?: return finish()
        try {
            val round = StatusSync.fetch(this, api)
            failingSince = 0
            val active = round.active
            for (s in active) {
                val printer = round.byId[s.id] ?: continue
                val model = Notifications.progress(printer, s)
                Notifier.notify(this, Notifier.progressId(s.id), Notifier.progress(this, model, printer.name, s.file, ongoing = true))
                shown += s.id
            }
            // Printers that stopped: their progress notification goes (StatusSync posted how it ended).
            for (id in shown.toList()) {
                if (active.none { it.id == id }) {
                    val now = round.statuses.firstOrNull { it.id == id }
                    if (now == null || !now.isUnknown) {
                        Notifier.cancel(this, Notifier.progressId(id))
                        shown -= id
                    }
                }
            }
            val names = active.mapNotNull { round.byId[it.id]?.name }
            Notifier.notify(
                this,
                Notifier.SUMMARY_ID,
                Notifier.summary(this, if (names.size == 1) "Printing on ${names[0]}" else if (names.isEmpty()) "No print running" else "${names.size} printers busy"),
            )
            val now = System.currentTimeMillis()
            val snapshots = now - lastSnapshots > SNAPSHOT_EVERY_MS
            if (snapshots) lastSnapshots = now
            StatusSync.updateWidgets(this, api, round, snapshots)
            if (active.isEmpty()) {
                if (++idleRounds >= IDLE_ROUNDS) return finish()
            } else {
                idleRounds = 0
            }
        } catch (e: ApiException) {
            if (e.status == 401) {
                // The device was signed out (My account, or the account was disabled).
                Tokens.store(this).clear()
                Notifier.signedOut(this)
                return finish()
            }
            if (!stillTrying()) return finish()
        } catch (e: IOException) {
            if (!stillTrying()) return finish()
            Notifier.notify(this, Notifier.SUMMARY_ID, Notifier.summary(this, "Can’t reach octo·modern; retrying…"))
        } catch (e: Exception) {
            Log.e(TAG, "poll failed", e)
            if (!stillTrying()) return finish()
        }
        next = executor.schedule({ poll() }, POLL_MS, TimeUnit.MILLISECONDS)
    }

    private fun stillTrying(): Boolean {
        val now = System.currentTimeMillis()
        if (failingSince == 0L) failingSince = now
        return now - failingSince < GIVE_UP_MS
    }

    private fun finish() {
        for (id in shown) Notifier.cancel(this, Notifier.progressId(id))
        shown.clear()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        instance = null
        next?.cancel(false)
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PrintWatch"
        const val ACTION_STOP = "io.github.vitafortis.octomodern.STOP_WATCHING"
        const val POLL_MS = 5_000L
        /** Rounds without an active print before the service stops (with POLL_MS, ~15 s). */
        const val IDLE_ROUNDS = 3
        /** Widgets get a new webcam snapshot at most this often while printing. */
        const val SNAPSHOT_EVERY_MS = 60_000L
        /** Network trouble for this long ends the service; the 15-minute check picks up again. */
        const val GIVE_UP_MS = 10 * 60_000L

        @Volatile var running = false
            private set
        @Volatile var instance: PrintWatchService? = null
            private set
    }
}

/** Starting and stopping the watcher. */
object Watch {
    /**
     * Starts [PrintWatchService] if notifications are on and allowed. From the background,
     * Android 12+ only allows it in some cases (e.g. the app is exempt from battery
     * optimisation); returns false when it wasn't allowed.
     */
    fun start(context: Context, fromBackground: Boolean): Boolean {
        val s = AppSettings(context)
        if (s.server == null || !s.notifications || !Notifier.allowed(context)) return false
        if (fromBackground && !s.keepWatching) return false
        if (PrintWatchService.running) {
            PrintWatchService.instance?.pollSoon(0)
            return true
        }
        return try {
            ContextCompat.startForegroundService(context, Intent(context, PrintWatchService::class.java))
            true
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+) or IllegalStateException.
            Log.i("PrintWatch", "can't start from here: ${e.javaClass.simpleName}")
            false
        }
    }

    fun stop(context: Context) {
        if (!PrintWatchService.running) return
        context.startService(Intent(context, PrintWatchService::class.java).setAction(PrintWatchService.ACTION_STOP))
    }
}
