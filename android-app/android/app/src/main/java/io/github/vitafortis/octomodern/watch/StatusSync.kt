package io.github.vitafortis.octomodern.watch

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import io.github.vitafortis.octomodern.core.Notifications
import io.github.vitafortis.octomodern.core.PrinterInfo
import io.github.vitafortis.octomodern.core.PrinterStatus
import io.github.vitafortis.octomodern.core.StatusParser
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.net.Api
import io.github.vitafortis.octomodern.widget.WidgetUpdater
import java.io.File

/**
 * One round of "what are the printers doing": fetches printers and statuses with the device
 * token, caches them (widgets render from the cache), posts completion notifications by
 * comparing with the previous round, and refreshes widgets. Used by the foreground service
 * every few seconds and by the 15-minute worker.
 */
object StatusSync {
    data class Round(val printers: List<PrinterInfo>, val statuses: List<PrinterStatus>) {
        val byId get() = printers.associateBy { it.id }
        val active get() = statuses.filter { it.isActive && byId.containsKey(it.id) }
    }

    /** Blocking. Throws on network/API errors. */
    fun fetch(context: Context, api: Api): Round {
        val printersJson = api.printersJson()
        val statusesJson = api.statusesJson()
        val settings = AppSettings(context)
        val previous = settings.cachedStatuses?.let { runCatching { StatusParser.statuses(it) }.getOrNull() }.orEmpty()
        settings.cachedPrinters = printersJson
        settings.cachedStatuses = statusesJson
        settings.cachedAt = System.currentTimeMillis()
        val round = Round(StatusParser.printers(printersJson), StatusParser.statuses(statusesJson))
        postOutcomes(context, api, round, previous)
        return round
    }

    /** The last cached round, for rendering without the network. */
    fun cached(context: Context): Round? {
        val s = AppSettings(context)
        val p = s.cachedPrinters ?: return null
        val st = s.cachedStatuses ?: return null
        return runCatching { Round(StatusParser.printers(p), StatusParser.statuses(st)) }.getOrNull()
    }

    private fun postOutcomes(context: Context, api: Api, round: Round, previous: List<PrinterStatus>) {
        val prevById = previous.associateBy { it.id }
        val settings = AppSettings(context)
        for (now in round.statuses) {
            val prev = prevById[now.id] ?: continue
            val printer = round.byId[now.id] ?: continue
            val outcome = Notifications.outcome(prev, now) ?: continue
            Notifier.cancel(context, Notifier.progressId(now.id))
            if (!settings.notifications) continue
            val snap = api.snapshot(now.id)?.let { saveSnapshot(context, now.id, it); decode(it, 1280) }
            Notifier.outcome(context, Notifications.outcomeModel(printer, prev, outcome, now), snap)
        }
    }

    // --- webcam snapshots, cached for widgets --------------------------------------------

    fun snapshotFile(context: Context, printerId: String) = File(context.cacheDir, "snapshots/${printerId.hashCode()}.jpg")

    fun saveSnapshot(context: Context, printerId: String, bytes: ByteArray) {
        val f = snapshotFile(context, printerId)
        f.parentFile?.mkdirs()
        f.writeBytes(bytes)
    }

    /** Fetches a fresh snapshot for the printer, keeping the last one if the camera can't be reached. */
    fun refreshSnapshot(context: Context, api: Api, printerId: String) {
        api.snapshot(printerId)?.let { saveSnapshot(context, printerId, it) }
    }

    fun cachedSnapshot(context: Context, printerId: String, maxWidth: Int): Bitmap? {
        val f = snapshotFile(context, printerId)
        if (!f.exists()) return null
        return decode(f.readBytes(), maxWidth)
    }

    fun decode(bytes: ByteArray, maxWidth: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** Refreshes every widget from this round (and fresh snapshots when asked). */
    fun updateWidgets(context: Context, api: Api?, round: Round, snapshots: Boolean) {
        if (snapshots && api != null) {
            for (id in WidgetUpdater.configuredPrinters(context)) refreshSnapshot(context, api, id)
        }
        WidgetUpdater.updateAll(context, round)
    }
}
