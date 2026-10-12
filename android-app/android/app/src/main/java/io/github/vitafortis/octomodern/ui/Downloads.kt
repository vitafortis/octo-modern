package io.github.vitafortis.octomodern.ui

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.widget.Toast
import io.github.vitafortis.octomodern.core.ServerAddress
import java.io.File

/**
 * Downloads from the WebView: CSV exports and timelapse videos (plain links, handed to
 * Android's download manager with the session cookie), and files the web app builds in
 * the page (`blob:` links: backups, G-code exports), which the injected script sends here
 * as data URLs.
 */
object Downloads {
    fun listener(context: Context, server: () -> String?) = DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
        if (url.startsWith("blob:") || url.startsWith("data:")) return@DownloadListener // the page script handles these
        val origin = server()
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val req = DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setMimeType(mimeType)
            .addRequestHeader("User-Agent", userAgent)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        // The session cookie only goes to our own server.
        if (origin != null && ServerAddress.sameOrigin(origin, url)) {
            CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        } else {
            req.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
        }
        try {
            (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            Toast.makeText(context, "Downloading $name…", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Couldn’t download $name: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Saves a `data:` URL from the page to Downloads (app storage on Android 8–9). */
    fun saveDataUrl(context: Context, rawName: String, dataUrl: String) {
        val comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith("data:") || comma < 0) return
        val meta = dataUrl.substring(5, comma)
        val mime = meta.substringBefore(';').ifEmpty { "application/octet-stream" }
        val bytes = if (meta.endsWith(";base64")) Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT) else Uri.decode(dataUrl.substring(comma + 1)).toByteArray()
        val name = rawName.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").take(120).ifEmpty { "download" }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("No Downloads folder")
                resolver.openOutputStream(item)!!.use { it.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(item, values, null, null)
            } else {
                val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
                val f = File(dir, name)
                f.writeBytes(bytes)
            }
            Toast.makeText(context, "Saved $name to Downloads", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Couldn’t save $name: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }
}
