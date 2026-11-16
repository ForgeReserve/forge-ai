package com.forgereserve.ai

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.os.Environment
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Share unseen, out: the protected photo goes to the phone's own share sheet, or is saved where the
 * person picks (the system's save screen, so no storage permission is needed). The original photo
 * never comes here; the page sends only the protected copy. The page's side is public/v2/core/native.js.
 */
@CapacitorPlugin(name = "ForgeShare")
class SharePlugin : Plugin() {
    private var toSave: ByteArray? = null

    // Files shared out or taken with the camera in an earlier run are not needed any more.
    override fun load() {
        forgetFiles()
    }

    private fun outDir() = File(context.cacheDir, ShareOut.DIR)

    /**
     * Removes what this app wrote to storage for photos: files handed to the share sheet, and photos the
     * camera took for the page (Capacitor keeps those in the app's own pictures folder).
     */
    private fun forgetFiles() {
        outDir().deleteRecursively()
        context.getExternalFilesDir(Environment.DIRECTORY_PICTURES)?.listFiles()?.forEach { it.deleteRecursively() }
    }

    /** Opens the share sheet with one file: {name, mime, data (base64)}. Resolves {opened: true}. */
    @PluginMethod
    fun share(call: PluginCall) {
        val mime = ShareOut.mime(call.getString("mime")) ?: return call.reject("This kind of file cannot be shared.", "bad_type")
        val bytes = ShareOut.decode(call.getString("data")) ?: return call.reject("The file could not be read.", "bad_file")
        val name = ShareOut.safeName(call.getString("name"), mime)
        try {
            outDir().deleteRecursively()
            outDir().mkdirs()
            val file = File(outDir(), name)
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(send, null))
            call.resolve(JSObject().put("opened", true))
        } catch (e: Exception) {
            call.reject("The share sheet could not open.", "share_failed")
        }
    }

    /** Saves one file where the person picks: {name, mime, data}. Resolves {saved: true|false}. */
    @PluginMethod
    fun save(call: PluginCall) {
        val mime = ShareOut.mime(call.getString("mime")) ?: return call.reject("This kind of file cannot be saved.", "bad_type")
        val bytes = ShareOut.decode(call.getString("data")) ?: return call.reject("The file could not be read.", "bad_file")
        toSave = bytes
        val pick = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, ShareOut.safeName(call.getString("name"), mime))
        }
        startActivityForResult(call, pick, "saved")
    }

    @ActivityCallback
    fun saved(call: PluginCall?, result: ActivityResult) {
        val bytes = toSave
        toSave = null
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null || bytes == null) {
            call.resolve(JSObject().put("saved", false))
            return
        }
        try {
            val out = context.contentResolver.openOutputStream(uri) ?: throw IllegalStateException("no stream")
            out.use { it.write(bytes) }
            call.resolve(JSObject().put("saved", true))
        } catch (e: Exception) {
            call.reject("The file could not be saved.", "save_failed")
        }
    }

    /** Erase everything, and leaving Share unseen: removes the photo files above and the web view's own cache. */
    @PluginMethod
    fun forget(call: PluginCall) {
        toSave = null
        forgetFiles()
        // The voice lab's results kept for adb (VoicePlugin.saveLab).
        File(context.filesDir, "voice-lab").deleteRecursively()
        activity.runOnUiThread {
            bridge.webView.clearCache(true)
            call.resolve()
        }
    }
}
