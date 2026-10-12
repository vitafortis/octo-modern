package io.github.vitafortis.octomodern

import io.github.vitafortis.octomodern.core.Format
import io.github.vitafortis.octomodern.core.JobAction
import io.github.vitafortis.octomodern.core.Notifications
import io.github.vitafortis.octomodern.core.Outcome
import io.github.vitafortis.octomodern.core.PrinterInfo
import io.github.vitafortis.octomodern.core.StatusParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** GET /api/printers/status → what the progress notification shows (shapes from src/lib/printer.ts). */
@RunWith(RobolectricTestRunner::class)
class StatusModelTest {
    private fun status(state: String, completion: Double? = null, left: Long? = null, z: Double? = null, preparing: String? = null, file: String? = "benchy.gcode", time: Long? = 600, error: String? = null) =
        StatusParser.statuses(
            """[{"id":"p1","state":"$state","stateText":"x","printerError":${error?.let { "\"$it\"" } ?: "null"},"problem":null,
            "job":${if (file != null) """{"file":{"name":"$file","path":"$file","display":"$file","origin":"local","size":1,"date":1},"estimatedPrintTime":3600,"filament":null,"user":null}""" else "null"},
            "progress":${if (completion != null) """{"completion":$completion,"printTime":$time,"printTimeLeft":${left ?: "null"},"printTimeLeftOrigin":"estimate","filepos":1}""" else "null"},
            "temps":{},"currentZ":${z ?: "null"},"source":"push","version":"1.10.0","updatedAt":1700000000000,
            "preparing":${preparing?.let { """{"id":"x","file":"benchy.gcode","step":"level","label":"$it","startedAt":1,"by":null}""" } ?: "null"}}]""",
        ).single()

    private val operator = PrinterInfo("p1", "MK4", canControl = true)
    private val viewer = PrinterInfo("p1", "MK4", canControl = false)

    @Test fun parsesPrintersAndAccess() {
        val list = StatusParser.printers("""[{"id":"a","name":"MK4","access":{"control":true}},{"id":"b","name":"Voron","access":{"control":false}},{"id":"c","name":""}]""")
        assertEquals(listOf("MK4", "Voron", "Printer"), list.map { it.name })
        assertEquals(listOf(true, false, false), list.map { it.canControl })
    }

    @Test fun printingShowsPercentTimeLeftAndHeight() {
        val s = status("printing", completion = 42.4, left = 4320, z = 12.4)
        assertTrue(s.isActive)
        val m = Notifications.progress(operator, s)
        assertEquals("MK4 · benchy.gcode", m.title)
        assertEquals("42% · 1h 12m left · Z 12.40 mm", m.text)
        assertEquals("Printing", m.subText)
        assertEquals(42, m.progress)
        assertEquals(listOf(JobAction.PAUSE, JobAction.CANCEL), m.actions)
    }

    @Test fun pausedOffersResume() {
        val m = Notifications.progress(operator, status("paused", completion = 50.0, left = 100))
        assertEquals(listOf(JobAction.RESUME, JobAction.CANCEL), m.actions)
        assertEquals("50%", m.text) // no countdown while paused
        assertEquals("Paused", m.subText)
    }

    @Test fun viewersGetNoActions() {
        assertTrue(Notifications.progress(viewer, status("printing", completion = 10.0)).actions.isEmpty())
        assertTrue(Notifications.progress(viewer, status("operational", preparing = "Leveling the bed")).actions.isEmpty())
    }

    @Test fun preparingIsIndeterminateWithStop() {
        val s = status("operational", preparing = "Leveling the bed", completion = null, file = null)
        assertTrue(s.isActive)
        assertTrue(s.isPreparing)
        val m = Notifications.progress(operator, s)
        assertEquals(-1, m.progress)
        assertEquals("Leveling the bed · benchy.gcode", m.text)
        assertEquals("MK4", m.title)
        assertEquals(listOf(JobAction.STOP_PREPARING), m.actions)
    }

    @Test fun unknownProgressIsIndeterminate() {
        assertEquals(-1, Notifications.progress(operator, status("printing", completion = null)).progress)
    }

    @Test fun outcomes() {
        val printing = status("printing", completion = 97.0)
        assertEquals(Outcome.FINISHED, Notifications.outcome(printing, status("operational", completion = 100.0)))
        assertEquals(Outcome.FINISHED, Notifications.outcome(status("finishing", completion = 99.0), status("operational", completion = 99.0)))
        assertEquals(Outcome.CANCELLED, Notifications.outcome(printing, status("operational", completion = 41.0)))
        assertEquals(Outcome.CANCELLED, Notifications.outcome(status("cancelling", completion = 99.9), status("operational", completion = 100.0)))
        assertEquals(Outcome.FAILED, Notifications.outcome(printing, status("error", error = "Thermal runaway")))
        // Losing the connection says nothing about the print.
        assertNull(Notifications.outcome(printing, status("offline")))
        assertNull(Notifications.outcome(printing, status("printing", completion = 98.0)))
        assertNull(Notifications.outcome(status("operational"), status("operational")))
        // A preparation that ended without the print starting.
        assertEquals(Outcome.CANCELLED, Notifications.outcome(status("operational", preparing = "Leveling"), status("operational")))
        assertNull(Notifications.outcome(status("operational", preparing = "Leveling"), status("printing", completion = 0.0)))
    }

    @Test fun outcomeText() {
        val prev = status("printing", completion = 41.7, time = 3700)
        val m = Notifications.outcomeModel(operator, prev, Outcome.CANCELLED, status("operational"))
        assertEquals("MK4: print cancelled", m.title)
        assertEquals("benchy.gcode · stopped at 41%", m.text)
        val done = Notifications.outcomeModel(operator, status("printing", completion = 100.0, time = 3700), Outcome.FINISHED, status("operational"))
        assertEquals("benchy.gcode · took 1h 01m", done.text)
        val failed = Notifications.outcomeModel(operator, prev, Outcome.FAILED, status("error", error = "Thermal runaway"))
        assertEquals("benchy.gcode · Thermal runaway", failed.text)
    }

    @Test fun durations() {
        assertEquals("<1m", Format.duration(30))
        assertEquals("12m", Format.duration(12 * 60 + 5))
        assertEquals("2h 05m", Format.duration(2 * 3600 + 5 * 60))
        assertEquals("1d 3h", Format.duration(27 * 3600))
        assertFalse(status("operational").isActive)
    }
}
