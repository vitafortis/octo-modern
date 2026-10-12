package io.github.vitafortis.octomodern.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.watch.StatusWorker

/**
 * The printer widget: name, state, progress, time left and a webcam snapshot. Which
 * printer is picked in [WidgetConfigActivity]. Updated by the 15-minute check and, while
 * printing, by the live watcher (snapshots at most once a minute).
 */
class PrinterWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) WidgetUpdater.update(context, mgr, id)
        StatusWorker.schedule(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, mgr: AppWidgetManager, id: Int, options: Bundle) {
        WidgetUpdater.update(context, mgr, id)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        val s = AppSettings(context)
        for (id in ids) s.removeWidget(id)
    }

    override fun onDisabled(context: Context) {
        StatusWorker.schedule(context)
    }
}
