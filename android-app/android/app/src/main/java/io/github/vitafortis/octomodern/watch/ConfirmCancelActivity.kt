package io.github.vitafortis.octomodern.watch

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import io.github.vitafortis.octomodern.R
import io.github.vitafortis.octomodern.data.AppSettings

/**
 * "Cancel the print?" — asked before a notification's Cancel (or Stop, for a preparation)
 * goes to the printer. A small dialog over whatever is on screen.
 */
class ConfirmCancelActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_confirm_cancel)
        setFinishOnTouchOutside(true)
        val printerId = intent.getStringExtra(EXTRA_PRINTER) ?: return finish()
        val name = intent.getStringExtra(EXTRA_NAME) ?: "the printer"
        val file = intent.getStringExtra(EXTRA_FILE)
        val preparing = intent.getBooleanExtra(EXTRA_PREPARING, false)

        findViewById<TextView>(R.id.title).text = if (preparing) "Stop preparing on $name?" else "Cancel the print on $name?"
        findViewById<TextView>(R.id.body).text = if (preparing) {
            "The pre-print steps stop and ${file ?: "the file"} won’t start."
        } else {
            "${file ?: "The print"} stops now. This can’t be undone."
        }
        val confirm = findViewById<Button>(R.id.confirm)
        val keep = findViewById<Button>(R.id.keep)
        confirm.text = if (preparing) "Stop" else "Cancel print"
        keep.text = if (preparing) "Keep going" else "Keep printing"
        keep.setOnClickListener { finish() }
        confirm.setOnClickListener {
            confirm.isEnabled = false
            keep.isEnabled = false
            findViewById<View>(R.id.progress).visibility = View.VISIBLE
            val app = applicationContext
            Thread {
                val error = try {
                    val api = AppSettings.api(app) ?: throw IllegalStateException("No server set up")
                    if (preparing) api.stopPreparing(printerId) else api.job(printerId, "cancel", confirm = true)
                    null
                } catch (e: Exception) {
                    e.message ?: "Couldn’t reach octo·modern"
                }
                runOnUiThread {
                    if (error != null) Toast.makeText(app, "Couldn’t cancel: $error", Toast.LENGTH_LONG).show()
                    else Toast.makeText(app, if (preparing) "Stopped" else "Cancelling the print on $name", Toast.LENGTH_SHORT).show()
                    PrintWatchService.instance?.pollSoon(500)
                    finish()
                }
            }.start()
        }
    }

    companion object {
        const val EXTRA_PRINTER = "printer"
        const val EXTRA_NAME = "name"
        const val EXTRA_FILE = "file"
        const val EXTRA_PREPARING = "preparing"
    }
}
