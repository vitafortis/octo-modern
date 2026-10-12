package io.github.vitafortis.octomodern.watch

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import io.github.vitafortis.octomodern.core.Notifications
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.data.Tokens
import io.github.vitafortis.octomodern.net.ApiException
import io.github.vitafortis.octomodern.widget.WidgetUpdater
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * The periodic check (every 15 minutes, Android's minimum; later when the phone dozes):
 * refreshes widgets and their snapshots, notices prints that started elsewhere, and starts
 * the live watcher. When Android doesn't allow starting it from the background, it posts
 * the progress as a plain notification instead, refreshed on the next check.
 */
class StatusWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        val settings = AppSettings(ctx)
        val api = AppSettings.api(ctx) ?: return Result.success()
        if (PrintWatchService.running) {
            // The service keeps everything fresh; only the snapshots for widgets.
            StatusSync.cached(ctx)?.let { StatusSync.updateWidgets(ctx, api, it, snapshots = true) }
            return Result.success()
        }
        val round = try {
            StatusSync.fetch(ctx, api)
        } catch (e: ApiException) {
            if (e.status == 401 && Tokens.store(ctx).get(api.origin) != null) {
                Tokens.store(ctx).clear()
                Notifier.signedOut(ctx)
            }
            return Result.success()
        } catch (e: Exception) {
            return Result.retry()
        }
        StatusSync.updateWidgets(ctx, api, round, snapshots = true)

        val active = round.active
        if (active.isEmpty() || !settings.notifications || !settings.keepWatching) {
            for (s in round.statuses) if (!s.isActive) Notifier.cancel(ctx, Notifier.progressId(s.id))
            return Result.success()
        }
        if (Watch.start(ctx, fromBackground = true)) return Result.success()
        // Not allowed to start the live watcher from here: show where things stand now.
        val at = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())
        for (s in active) {
            val printer = round.byId[s.id] ?: continue
            val model = Notifications.progress(printer, s)
            Notifier.notify(ctx, Notifier.progressId(s.id), Notifier.progress(ctx, model, printer.name, s.file, ongoing = false, updatedNote = "as of $at"))
        }
        return Result.success()
    }

    companion object {
        private const val PERIODIC = "status-check"
        private const val NOW = "status-now"

        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Schedules the 15-minute check (keeps an existing schedule). */
        fun schedule(context: Context) {
            val s = AppSettings(context)
            val wm = WorkManager.getInstance(context)
            if (s.server == null || (!s.keepWatching && !WidgetUpdater.hasWidgets(context))) {
                wm.cancelUniqueWork(PERIODIC)
                return
            }
            wm.enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<StatusWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build(),
            )
        }

        /** One check as soon as possible (a widget was added). */
        fun runOnce(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                NOW,
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<StatusWorker>().setConstraints(constraints).build(),
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }
    }
}
