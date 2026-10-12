package io.github.vitafortis.octomodern.watch

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.net.ApiException

/** Pause and Resume from a progress notification (not exported: only our PendingIntents reach it). */
class JobActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val printer = intent.getStringExtra(EXTRA_PRINTER) ?: return
        val command = intent.getStringExtra(EXTRA_COMMAND)?.takeIf { it == "pause" || it == "resume" } ?: return
        val pending = goAsync()
        val app = context.applicationContext
        Thread {
            val message = try {
                val api = AppSettings.api(app) ?: throw IllegalStateException("No server set up")
                api.job(printer, command)
                null
            } catch (e: ApiException) {
                e.message
            } catch (e: Exception) {
                e.message ?: "Couldn’t reach octo·modern"
            }
            Handler(Looper.getMainLooper()).post {
                if (message != null) Toast.makeText(app, "Couldn’t $command: $message", Toast.LENGTH_LONG).show()
                PrintWatchService.instance?.pollSoon(500)
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val ACTION = "io.github.vitafortis.octomodern.JOB_ACTION"
        const val EXTRA_PRINTER = "printer"
        const val EXTRA_COMMAND = "command"
    }
}
