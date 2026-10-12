package io.github.vitafortis.octomodern.core

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/** A printer the signed-in user can see (GET /api/printers). */
data class PrinterInfo(val id: String, val name: String, val canControl: Boolean)

/** One printer's live state (an entry of GET /api/printers/status, see src/lib/printer.ts). */
data class PrinterStatus(
    val id: String,
    /** octo·modern's state: offline, disconnected, connecting, operational, printing, pausing, paused, resuming, cancelling, finishing, error, unknown. */
    val state: String,
    val stateText: String,
    val file: String?,
    /** 0–100. */
    val completion: Double?,
    val printTime: Long?,
    val printTimeLeft: Long?,
    val currentZ: Double?,
    /** The pre-print step running before the file starts ("Leveling the bed"), if any. */
    val preparing: String?,
    val error: String?,
    val updatedAt: Long,
) {
    val isPreparing get() = preparing != null
    val isPrinting get() = state in PRINTING_STATES
    /** A print is under way or about to start: what the progress notification follows. */
    val isActive get() = isPreparing || isPrinting
    val isPaused get() = state == "paused" || state == "pausing"
    /** Can't tell what the printer is doing right now (no connection). */
    val isUnknown get() = state == "offline" || state == "unknown" || state == "connecting"

    companion object {
        val PRINTING_STATES = setOf("printing", "pausing", "paused", "resuming", "cancelling", "finishing")
    }
}

object StatusParser {
    fun printers(json: String): List<PrinterInfo> {
        val arr = JSONArray(json)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            PrinterInfo(
                id = o.getString("id"),
                name = o.optString("name").ifEmpty { "Printer" },
                canControl = o.optJSONObject("access")?.optBoolean("control", false) ?: false,
            )
        }
    }

    fun statuses(json: String): List<PrinterStatus> {
        val arr = JSONArray(json)
        return (0 until arr.length()).map { status(arr.getJSONObject(it)) }
    }

    fun status(o: JSONObject): PrinterStatus {
        val job = o.optJSONObject("job")
        val file = job?.optJSONObject("file")
        val progress = o.optJSONObject("progress")
        val preparing = o.optJSONObject("preparing")
        return PrinterStatus(
            id = o.getString("id"),
            state = o.optString("state", "unknown"),
            stateText = o.optString("stateText", ""),
            file = file?.let { f -> f.optStringOrNull("display") ?: f.optStringOrNull("name") } ?: preparing?.optStringOrNull("file"),
            completion = progress?.optDoubleOrNull("completion"),
            printTime = progress?.optLongOrNull("printTime"),
            printTimeLeft = progress?.optLongOrNull("printTimeLeft"),
            currentZ = o.optDoubleOrNull("currentZ"),
            preparing = preparing?.let { it.optStringOrNull("label") ?: "Preparing" },
            error = o.optStringOrNull("printerError") ?: o.optJSONObject("problem")?.optStringOrNull("message"),
            updatedAt = o.optLong("updatedAt", 0),
        )
    }

    private fun JSONObject.optStringOrNull(k: String): String? = if (has(k) && !isNull(k)) optString(k).ifEmpty { null } else null
    private fun JSONObject.optDoubleOrNull(k: String): Double? = if (has(k) && !isNull(k)) optDouble(k).takeIf { !it.isNaN() } else null
    private fun JSONObject.optLongOrNull(k: String): Long? = optDoubleOrNull(k)?.toLong()
}

enum class JobAction(val command: String, val label: String) {
    PAUSE("pause", "Pause"),
    RESUME("resume", "Resume"),
    CANCEL("cancel", "Cancel"),
    /** Stops a pre-print preparation (DELETE /api/printers/<id>/preprint). */
    STOP_PREPARING("stop-preparing", "Stop"),
}

/** What a printer's ongoing progress notification shows. */
data class ProgressModel(
    val printerId: String,
    val title: String,
    val text: String,
    val subText: String,
    /** 0–100, or -1 for an indeterminate bar. */
    val progress: Int,
    val actions: List<JobAction>,
)

enum class Outcome { FINISHED, FAILED, CANCELLED }

/** What the completion notification says. */
data class OutcomeModel(val printerId: String, val outcome: Outcome, val title: String, val text: String)

object Notifications {
    val STATE_LABEL = mapOf(
        "offline" to "Unreachable",
        "disconnected" to "Disconnected",
        "connecting" to "Connecting",
        "operational" to "Ready",
        "printing" to "Printing",
        "pausing" to "Pausing",
        "paused" to "Paused",
        "resuming" to "Resuming",
        "cancelling" to "Cancelling",
        "finishing" to "Finishing",
        "error" to "Error",
        "unknown" to "Unknown",
    )

    fun stateLabel(s: PrinterStatus): String = if (s.isPreparing) "Preparing" else STATE_LABEL[s.state] ?: s.state.replaceFirstChar { it.uppercase() }

    fun progress(printer: PrinterInfo, s: PrinterStatus): ProgressModel {
        val pct = s.completion?.coerceIn(0.0, 100.0)
        val parts = mutableListOf<String>()
        if (s.isPreparing) {
            parts += s.preparing!!
            s.file?.let { parts += it }
        } else {
            pct?.let { parts += "${it.toInt()}%" }
            s.printTimeLeft?.takeIf { it > 0 && s.state != "paused" }?.let { parts += "${Format.duration(it)} left" }
            s.currentZ?.takeIf { it > 0 }?.let { parts += "Z ${Format.z(it)}" }
        }
        val actions = when {
            !printer.canControl -> emptyList()
            s.isPreparing -> listOf(JobAction.STOP_PREPARING)
            s.state == "printing" || s.state == "resuming" -> listOf(JobAction.PAUSE, JobAction.CANCEL)
            s.state == "paused" -> listOf(JobAction.RESUME, JobAction.CANCEL)
            s.state == "pausing" -> listOf(JobAction.CANCEL)
            else -> emptyList()
        }
        val sub = if (s.isPreparing) "Preparing" else stateLabel(s)
        return ProgressModel(
            printerId = printer.id,
            title = if (!s.isPreparing && s.file != null) "${printer.name} · ${s.file}" else printer.name,
            text = parts.joinToString(" · ").ifEmpty { stateLabel(s) },
            subText = sub,
            progress = if (s.isPreparing || pct == null) -1 else pct.roundToInt(),
            actions = actions,
        )
    }

    /**
     * How a print ended, comparing the last active status with the new one; null while it's
     * still going, or when the printer can't be reached (that says nothing about the print).
     */
    fun outcome(prev: PrinterStatus, now: PrinterStatus): Outcome? {
        if (!prev.isActive || now.isActive || now.isUnknown) return null
        if (prev.isPreparing && !prev.isPrinting) {
            // A preparation that stopped without the file starting: failed or was cancelled.
            return if (now.state == "error") Outcome.FAILED else Outcome.CANCELLED
        }
        if (now.state == "error") return Outcome.FAILED
        if (prev.state == "cancelling") return Outcome.CANCELLED
        val done = (now.completion ?: prev.completion ?: 0.0) >= 99.5 || prev.state == "finishing"
        return if (done) Outcome.FINISHED else Outcome.CANCELLED
    }

    fun outcomeModel(printer: PrinterInfo, prev: PrinterStatus, outcome: Outcome, now: PrinterStatus): OutcomeModel {
        val file = prev.file ?: now.file ?: "The print"
        return when (outcome) {
            Outcome.FINISHED -> OutcomeModel(printer.id, outcome, "${printer.name}: print finished", prev.printTime?.let { "$file · took ${Format.duration(it)}" } ?: file)
            Outcome.FAILED -> OutcomeModel(printer.id, outcome, "${printer.name}: print failed", now.error?.let { "$file · $it" } ?: file)
            Outcome.CANCELLED -> OutcomeModel(
                printer.id,
                outcome,
                "${printer.name}: print cancelled",
                prev.completion?.let { "$file · stopped at ${it.toInt()}%" } ?: file,
            )
        }
    }
}

object Format {
    /** `2h 05m`, `12m`, `<1m`, `1d 3h`. */
    fun duration(seconds: Long): String {
        if (seconds < 60) return "<1m"
        val m = seconds / 60
        val h = m / 60
        val d = h / 24
        return when {
            d > 0 -> "${d}d ${h % 24}h"
            h > 0 -> "${h}h ${"%02d".format(m % 60)}m"
            else -> "${m}m"
        }
    }

    fun z(z: Double): String = "%.2f mm".format(java.util.Locale.ROOT, z)
}
