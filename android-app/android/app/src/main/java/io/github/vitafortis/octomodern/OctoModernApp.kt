package io.github.vitafortis.octomodern

import android.app.Application
import io.github.vitafortis.octomodern.watch.Notifier
import io.github.vitafortis.octomodern.watch.StatusWorker

class OctoModernApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        StatusWorker.schedule(this)
    }
}
