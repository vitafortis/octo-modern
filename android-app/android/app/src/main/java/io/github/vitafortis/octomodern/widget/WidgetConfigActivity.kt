package io.github.vitafortis.octomodern.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import io.github.vitafortis.octomodern.MainActivity
import io.github.vitafortis.octomodern.R
import io.github.vitafortis.octomodern.core.Notifications
import io.github.vitafortis.octomodern.data.AppSettings
import io.github.vitafortis.octomodern.net.ApiException
import io.github.vitafortis.octomodern.watch.StatusSync
import io.github.vitafortis.octomodern.watch.StatusWorker

/** Picks the printer a new widget shows. */
class WidgetConfigActivity : AppCompatActivity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        setContentView(R.layout.activity_widget_config)
        findViewById<View>(R.id.cancel).setOnClickListener { finish() }
        load()
    }

    private fun load() {
        val list = findViewById<LinearLayout>(R.id.list)
        val message = findViewById<TextView>(R.id.message)
        val spinner = findViewById<ProgressBar>(R.id.loading)
        val open = findViewById<View>(R.id.open_app)
        val api = AppSettings.api(this)
        if (api == null) {
            spinner.visibility = View.GONE
            message.text = "Open octo·modern and connect to your server first."
            message.visibility = View.VISIBLE
            open.visibility = View.VISIBLE
            open.setOnClickListener { startActivity(Intent(this, MainActivity::class.java)); finish() }
            return
        }
        Thread {
            val result = runCatching { StatusSync.fetch(this, api) }
            runOnUiThread {
                spinner.visibility = View.GONE
                result.onFailure { e ->
                    message.text = if (e is ApiException && e.status == 401) "Sign in in the app first, then add the widget again." else "Couldn’t load your printers: ${e.message}"
                    message.visibility = View.VISIBLE
                    open.visibility = View.VISIBLE
                    open.setOnClickListener { startActivity(Intent(this, MainActivity::class.java)); finish() }
                }
                result.onSuccess { round ->
                    if (round.printers.isEmpty()) {
                        message.text = "No printers yet: add one in octo·modern."
                        message.visibility = View.VISIBLE
                    }
                    val inflater = LayoutInflater.from(this)
                    for (p in round.printers) {
                        val row = inflater.inflate(R.layout.item_printer_choice, list, false)
                        row.findViewById<TextView>(R.id.name).text = p.name
                        val s = round.statuses.firstOrNull { it.id == p.id }
                        row.findViewById<TextView>(R.id.state).text = s?.let { Notifications.stateLabel(it) } ?: ""
                        row.setOnClickListener { choose(p.id) }
                        list.addView(row)
                    }
                }
            }
        }.start()
    }

    private fun choose(printerId: String) {
        AppSettings(this).setWidgetPrinter(widgetId, printerId)
        WidgetUpdater.update(this, AppWidgetManager.getInstance(this), widgetId)
        StatusWorker.schedule(this)
        StatusWorker.runOnce(this)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
    }
}
