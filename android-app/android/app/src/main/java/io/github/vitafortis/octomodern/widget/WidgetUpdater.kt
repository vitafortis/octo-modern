package io.github.vitafortis.octomodern.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import io.github.vitafortis.octomodern.R
import io.github.vitafortis.octomodern.core.Format
import io.github.vitafortis.octomodern.core.Notifications
import io.github.vitafortis.octomodern.core.PrinterInfo
import io.github.vitafortis.octomodern.core.PrinterStatus
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.watch.Notifier
import io.github.vitafortis.octomodern.watch.StatusSync
import java.text.DateFormat
import java.util.Date

/** Draws the printer widgets from the last cached status and snapshot. */
object WidgetUpdater {
    fun ids(context: Context): IntArray =
        AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, PrinterWidgetProvider::class.java))

    fun hasWidgets(context: Context) = ids(context).isNotEmpty()

    fun configuredPrinters(context: Context): Set<String> {
        val s = AppSettings(context)
        return ids(context).toList().mapNotNull { s.widgetPrinter(it) }.toSet()
    }

    fun updateAll(context: Context, round: StatusSync.Round? = StatusSync.cached(context)) {
        val mgr = AppWidgetManager.getInstance(context)
        for (id in ids(context)) update(context, mgr, id, round)
    }

    fun update(context: Context, mgr: AppWidgetManager, widgetId: Int, round: StatusSync.Round? = StatusSync.cached(context)) {
        val printerId = AppSettings(context).widgetPrinter(widgetId)
        if (printerId == null) {
            // Not set up (or the app's data was cleared): ask for a printer.
            mgr.updateAppWidget(widgetId, unconfigured(context, widgetId))
            return
        }
        val printer = round?.byId?.get(printerId)
        val status = round?.statuses?.firstOrNull { it.id == printerId }
        val cachedAt = AppSettings(context).cachedAt
        val small = render(context, widgetId, printerId, printer, status, cachedAt, large = false)
        val large = render(context, widgetId, printerId, printer, status, cachedAt, large = true)
        val views = if (Build.VERSION.SDK_INT >= 31) {
            RemoteViews(mapOf(SizeF(100f, 100f) to small, SizeF(200f, 180f) to large))
        } else {
            val o: Bundle = mgr.getAppWidgetOptions(widgetId)
            val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110)
            val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110)
            if (w >= 200 && h >= 180) large else small
        }
        mgr.updateAppWidget(widgetId, views)
    }

    private fun unconfigured(context: Context, widgetId: Int): RemoteViews {
        val v = RemoteViews(context.packageName, R.layout.widget_small)
        v.setTextViewText(R.id.name, "octo·modern")
        v.setTextViewText(R.id.state, "Tap to choose a printer")
        v.setViewVisibility(R.id.progress, View.GONE)
        v.setViewVisibility(R.id.detail, View.GONE)
        v.setViewVisibility(R.id.snapshot, View.GONE)
        v.setViewVisibility(R.id.snapshot_empty, View.VISIBLE)
        val i = Intent(context, WidgetConfigActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setData(Uri.parse("octomodern://widget/$widgetId"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 600_000 + widgetId, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        return v
    }

    private fun render(
        context: Context,
        widgetId: Int,
        printerId: String,
        printer: PrinterInfo?,
        s: PrinterStatus?,
        cachedAt: Long,
        large: Boolean,
    ): RemoteViews {
        val v = RemoteViews(context.packageName, if (large) R.layout.widget_large else R.layout.widget_small)
        v.setOnClickPendingIntent(R.id.widget_root, Notifier.openPrinter(context, printerId, 500_000 + widgetId))
        v.setTextViewText(R.id.name, printer?.name ?: "Printer")
        if (s == null) {
            v.setTextViewText(R.id.state, if (printer == null) "Open the app to sign in" else "No data yet")
            v.setViewVisibility(R.id.progress, View.GONE)
            v.setViewVisibility(R.id.detail, View.GONE)
        } else {
            val label = Notifications.stateLabel(s)
            val pct = s.completion?.takeIf { s.isPrinting }?.toInt()
            v.setTextViewText(R.id.state, if (pct != null) "$label · $pct%" else label)
            v.setTextColor(R.id.state, context.getColor(toneColor(s)))
            if (s.isActive) {
                v.setViewVisibility(R.id.progress, View.VISIBLE)
                v.setProgressBar(R.id.progress, 100, pct ?: 0, s.isPreparing || pct == null)
            } else {
                v.setViewVisibility(R.id.progress, View.GONE)
            }
            val detail = when {
                s.isPreparing -> s.preparing
                s.isPrinting && s.printTimeLeft != null && s.printTimeLeft > 0 && s.state != "paused" -> "${Format.duration(s.printTimeLeft)} left"
                s.isPrinting -> s.file
                s.error != null && (s.state == "error" || s.state == "offline") -> s.error
                else -> null
            }
            v.setTextViewText(R.id.detail, detail ?: "")
            v.setViewVisibility(R.id.detail, if (detail.isNullOrEmpty()) View.GONE else View.VISIBLE)
            if (large) {
                v.setTextViewText(R.id.file, s.file ?: "")
                v.setViewVisibility(R.id.file, if (s.file != null && s.isActive) View.VISIBLE else View.GONE)
            }
        }
        if (large) {
            v.setTextViewText(R.id.updated, if (cachedAt > 0) "Updated ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(cachedAt))}" else "")
        }
        val snap = StatusSync.cachedSnapshot(context, printerId, if (large) 640 else 360)
        if (snap != null) {
            v.setImageViewBitmap(R.id.snapshot, snap)
            v.setViewVisibility(R.id.snapshot, View.VISIBLE)
            v.setViewVisibility(R.id.snapshot_empty, View.GONE)
        } else {
            v.setViewVisibility(R.id.snapshot, View.GONE)
            v.setViewVisibility(R.id.snapshot_empty, View.VISIBLE)
        }
        return v
    }

    private fun toneColor(s: PrinterStatus): Int = when {
        s.isPreparing -> R.color.widget_primary
        s.state == "operational" -> R.color.widget_success
        s.state in setOf("printing", "finishing", "resuming") -> R.color.widget_primary
        s.state in setOf("paused", "pausing", "cancelling", "connecting") -> R.color.widget_warning
        s.state in setOf("error", "offline") -> R.color.widget_danger
        else -> R.color.widget_muted
    }
}
