package io.github.vitafortis.octomodern.watch

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.vitafortis.octomodern.MainActivity
import io.github.vitafortis.octomodern.R
import io.github.vitafortis.octomodern.core.JobAction
import io.github.vitafortis.octomodern.core.Outcome
import io.github.vitafortis.octomodern.core.OutcomeModel
import io.github.vitafortis.octomodern.core.ProgressModel
import kotlin.math.abs

/** Notification channels, ids and builders for print progress and finished prints. */
object Notifier {
    const val CH_PROGRESS = "progress"
    const val CH_EVENTS = "events"
    const val CH_ACCOUNT = "account"
    const val GROUP = "prints"
    const val SUMMARY_ID = 1
    private const val SIGNED_OUT_ID = 2

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_PROGRESS, "Print progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Ongoing progress of prints, with pause and cancel"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_EVENTS, "Finished prints", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When a print finishes, fails or is cancelled"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_ACCOUNT, "Account", NotificationManager.IMPORTANCE_LOW).apply {
                description = "When the app needs you to sign in again"
            },
        )
    }

    fun allowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun progressId(printerId: String) = 1000 + abs(printerId.hashCode() % 100_000)
    fun outcomeId(printerId: String) = 200_000 + abs(printerId.hashCode() % 100_000)

    /** Opens the app on a printer's page. */
    fun openPrinter(context: Context, printerId: String, requestCode: Int): PendingIntent {
        val i = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("octomodern://printer/${Uri.encode(printerId)}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun openApp(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun actionIntent(context: Context, model: ProgressModel, action: JobAction, printerName: String, file: String?): PendingIntent {
        val code = progressId(model.printerId) * 8 + action.ordinal
        return when (action) {
            JobAction.PAUSE, JobAction.RESUME -> PendingIntent.getBroadcast(
                context,
                code,
                Intent(context, JobActionReceiver::class.java)
                    .setAction(JobActionReceiver.ACTION)
                    .putExtra(JobActionReceiver.EXTRA_PRINTER, model.printerId)
                    .putExtra(JobActionReceiver.EXTRA_COMMAND, action.command),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            // Cancelling asks first, in a small dialog.
            JobAction.CANCEL, JobAction.STOP_PREPARING -> PendingIntent.getActivity(
                context,
                code,
                Intent(context, ConfirmCancelActivity::class.java)
                    .putExtra(ConfirmCancelActivity.EXTRA_PRINTER, model.printerId)
                    .putExtra(ConfirmCancelActivity.EXTRA_NAME, printerName)
                    .putExtra(ConfirmCancelActivity.EXTRA_FILE, file)
                    .putExtra(ConfirmCancelActivity.EXTRA_PREPARING, action == JobAction.STOP_PREPARING)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK or Intent.FLAG_ACTIVITY_NO_HISTORY),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }

    /** A printer's progress. `ongoing`: the foreground service keeps it current; otherwise it's a snapshot from the periodic check. */
    fun progress(context: Context, model: ProgressModel, printerName: String, file: String?, ongoing: Boolean, updatedNote: String? = null) =
        NotificationCompat.Builder(context, CH_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_octo)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle(model.title)
            .setContentText(if (updatedNote != null) "${model.text} · $updatedNote" else model.text)
            .setSubText(model.subText)
            .setProgress(100, model.progress.coerceAtLeast(0), model.progress < 0)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setGroup(GROUP)
            .setContentIntent(openPrinter(context, model.printerId, progressId(model.printerId)))
            .apply {
                for (a in model.actions) addAction(0, a.label, actionIntent(context, model, a, printerName, file))
            }
            .build()

    /** The foreground service's own notification: the group summary. */
    fun summary(context: Context, text: String) =
        NotificationCompat.Builder(context, CH_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_octo)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle("octo·modern")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp(context))
            .build()

    fun outcome(context: Context, model: OutcomeModel, snapshot: Bitmap?) {
        if (!allowed(context)) return
        val b = NotificationCompat.Builder(context, CH_EVENTS)
            .setSmallIcon(R.drawable.ic_stat_octo)
            .setColor(ContextCompat.getColor(context, if (model.outcome == Outcome.FINISHED) R.color.brand else R.color.danger))
            .setContentTitle(model.title)
            .setContentText(model.text)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(openPrinter(context, model.printerId, outcomeId(model.printerId)))
        if (snapshot != null) {
            b.setLargeIcon(snapshot).setStyle(NotificationCompat.BigPictureStyle().bigPicture(snapshot).bigLargeIcon(null as Bitmap?).setSummaryText(model.text))
        } else {
            b.setStyle(NotificationCompat.BigTextStyle().bigText(model.text))
        }
        notify(context, outcomeId(model.printerId), b.build())
    }

    fun signedOut(context: Context) {
        if (!allowed(context)) return
        notify(
            context,
            SIGNED_OUT_ID,
            NotificationCompat.Builder(context, CH_ACCOUNT)
                .setSmallIcon(R.drawable.ic_stat_octo)
                .setColor(ContextCompat.getColor(context, R.color.brand))
                .setContentTitle("Sign in to octo·modern again")
                .setContentText("This phone was signed out, so print notifications stopped. Open the app and sign in.")
                .setAutoCancel(true)
                .setContentIntent(openApp(context))
                .build(),
        )
    }

    fun notify(context: Context, id: Int, n: android.app.Notification) {
        if (!allowed(context)) return
        try {
            NotificationManagerCompat.from(context).notify(id, n)
        } catch (e: SecurityException) {
            // Permission withdrawn in the meantime.
        }
    }

    fun cancel(context: Context, id: Int) = NotificationManagerCompat.from(context).cancel(id)
}
