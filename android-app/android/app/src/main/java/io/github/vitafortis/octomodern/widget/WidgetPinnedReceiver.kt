package io.github.vitafortis.octomodern.widget

import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.watch.StatusWorker

/**
 * "Add widget" from App settings: Android asks the launcher to pin a widget, then calls
 * back here with its id; the printer was chosen before asking.
 */
class WidgetPinnedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val printerId = intent.getStringExtra(EXTRA_PRINTER) ?: return
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
        AppSettings(context).setWidgetPrinter(widgetId, printerId)
        WidgetUpdater.update(context, AppWidgetManager.getInstance(context), widgetId)
        StatusWorker.schedule(context)
        StatusWorker.runOnce(context)
    }

    companion object {
        const val EXTRA_PRINTER = "printer"
    }
}
