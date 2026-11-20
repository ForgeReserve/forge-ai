package com.forgereserve.ai

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Share unseen, out: the protected photo goes to the phone's own share sheet, or is saved where the
 * person picks (the system's save screen, so no storage permission is needed). The original photo
 * never comes here; the page sends only the protected copy. The page's side is public/v2/core/native.js.
 *
 * The page first stages the file in pieces (stageStart, stageAppend; ShareStage in ShareRules.kt), then
 * calls share or save with the token it got, the name and the type. No call that opens a screen carries
 * the file: Capacitor keeps the options of the call that opened the save screen in the app's saved
 * state, and a photo in them made that state too large for Android, which stopped the app.
 */
@CapacitorPlugin(name = "ForgeShare")
class SharePlugin : Plugin() {
    companion object {
        /**
         * Every staged file is written, read and removed on this one thread, in the order asked: one for the
         * app's process, shared by a plugin made again when Android makes the activity again.
         */
        private val io: ExecutorService = Executors.newSingleThreadExecutor()

        private const val PREFS = "forge-share"

        /** How a save ended when Android restarted the app while its save screen was up: "saved" or "notSaved". */
        private const val AFTER_RESTART = "saveAfterRestart"

        private const val TOKEN = "token"
    }

    private lateinit var staged: ShareStage

    /** The token of the file whose save screen is up, kept in the saved state while it is. */
    @Volatile
    private var saving: String? = null

    // Files shared out or taken with the camera in an earlier run are not needed any more.
    override fun load() {
        staged = ShareStage(File(context.cacheDir, ShareStage.DIR))
        forgetFiles()
        // Staged files left from an earlier run go too, once restoreState has run (it runs right after
        // load when Android restarts the app with a save screen up): that save's file is kept for it.
        Handler(Looper.getMainLooper()).post {
            val keep = saving
            io.execute { staged.sweep(keep) }
        }
    }

    private fun outDir() = File(context.cacheDir, ShareOut.DIR)

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Removes what this app wrote to storage for photos: files handed to the share sheet, and photos the
     * camera took for the page (Capacitor keeps those in the app's own pictures folder).
     */
    private fun forgetFiles() {
        outDir().deleteRecursively()
        context.getExternalFilesDir(Environment.DIRECTORY_PICTURES)?.listFiles()?.forEach { it.deleteRecursively() }
    }

    private fun PluginCall.fail(e: StageError) = reject(e.message, e.code)

    /** Starts staging a file of {size} bytes. Resolves {token}; rejects too_big or bad_file. */
    @PluginMethod
    fun stageStart(call: PluginCall) {
        io.execute {
            try {
                call.resolve(JSObject().put(TOKEN, staged.start((call.getInt("size") ?: 0).toLong(), keep = saving)))
            } catch (e: StageError) {
                call.fail(e)
            } catch (e: Exception) {
                call.reject("The file could not be staged.", "bad_file")
            }
        }
    }

    /** Adds the next piece of a staged file: {token, data (base64, at most ShareStage.CHUNK_BYTES)}. */
    @PluginMethod
    fun stageAppend(call: PluginCall) {
        io.execute {
            try {
                staged.append(call.getString(TOKEN), call.getString("data"))
                call.resolve()
            } catch (e: StageError) {
                call.fail(e)
            } catch (e: Exception) {
                staged.drop(call.getString(TOKEN))
                call.reject("The file could not be staged.", "bad_file")
            }
        }
    }

    /** Removes a staged file the page will not use (a piece failed). */
    @PluginMethod
    fun stageDrop(call: PluginCall) {
        io.execute {
            staged.drop(call.getString(TOKEN))
            call.resolve()
        }
    }

    /**
     * Opens the share sheet with one staged file: {token, name, mime}. Resolves {opened: true}. The staged
     * file is used up either way; the copy the sheet hands out stays in shared-out/ until the next share.
     */
    @PluginMethod
    fun share(call: PluginCall) {
        io.execute { shareNow(call) }
    }

    private fun shareNow(call: PluginCall) {
        val token = call.getString(TOKEN)
        try {
            val mime = ShareOut.mime(call.getString("mime")) ?: return call.reject("This kind of file cannot be shared.", "bad_type")
            val file = try {
                staged.take(token)
            } catch (e: StageError) {
                return call.fail(e)
            }
            val name = ShareOut.safeName(call.getString("name"), mime)
            outDir().deleteRecursively()
            outDir().mkdirs()
            val out = File(outDir(), name)
            if (!file.renameTo(out)) file.copyTo(out, overwrite = true)
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", out)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            // startActivity: no result comes back, so Capacitor keeps nothing of this call.
            activity.startActivity(Intent.createChooser(send, null))
            call.resolve(JSObject().put("opened", true))
        } catch (e: Exception) {
            call.reject("The share sheet could not open.", "share_failed")
        } finally {
            staged.drop(token)
        }
    }

    /**
     * Saves one staged file where the person picks: {token, name, mime}. Resolves {saved: true|false}
     * (false: the save screen was closed); rejects bad_type, no_file, bad_file or save_failed.
     */
    @PluginMethod
    fun save(call: PluginCall) {
        io.execute { saveNow(call) }
    }

    private fun saveNow(call: PluginCall) {
        val token = call.getString(TOKEN)
        // These options go into the saved state while the save screen is up: only small ones may.
        if (call.data.toString().length > ShareStage.MAX_CALL_CHARS) {
            staged.drop(token)
            return call.reject("The file could not be read.", "bad_file")
        }
        val mime = ShareOut.mime(call.getString("mime"))
        if (mime == null) {
            staged.drop(token)
            return call.reject("This kind of file cannot be saved.", "bad_type")
        }
        try {
            staged.take(token)
        } catch (e: StageError) {
            return call.fail(e)
        }
        // A save screen that never answered (none should) leaves its file behind: it goes now.
        saving?.let { if (it != token) staged.drop(it) }
        saving = token
        val pick = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, ShareOut.safeName(call.getString("name"), mime))
        }
        activity.runOnUiThread {
            try {
                startActivityForResult(call, pick, "saved")
            } catch (e: Exception) {
                // No app on this phone has a save screen.
                saving = null
                io.execute { staged.drop(token) }
                call.reject("The save screen could not open.", "save_failed")
            }
        }
    }

    /**
     * Only the token is kept in the saved state (Capacitor adds the call's options, which are as small).
     * Nothing when no save screen is up.
     */
    override fun saveInstanceState(): Bundle? = saving?.let { Bundle().apply { putString(TOKEN, it) } }

    /** Android restarted the app while the save screen was up: the save it opened is finished in saved. */
    override fun restoreState(state: Bundle) {
        ShareStage.token(state.getString(TOKEN))?.let { saving = it }
    }

    /**
     * The save screen closed. call is the page's own call, or after Android restarted the app meanwhile a
     * stand-in Capacitor made from the saved state (its answer reaches no page). Then the photo is still
     * written if its staged file is there, and how it ended is kept for the page to read (restoredSave).
     */
    @ActivityCallback
    fun saved(call: PluginCall?, result: ActivityResult) {
        val token = saving ?: call?.getString(TOKEN)
        saving = null
        val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        val restarted = call == null || call.callbackId == PluginCall.CALLBACK_ID_DANGLING
        io.execute {
            val written = if (uri == null) null else write(token, uri)
            staged.drop(token)
            if (restarted) {
                prefs().edit().putString(AFTER_RESTART, if (written == true) "saved" else "notSaved").commit()
            } else if (written == false) {
                call?.reject("The file could not be saved.", "save_failed")
            } else {
                call?.resolve(JSObject().put("saved", written == true))
            }
        }
    }

    /**
     * Copies the staged file into the document the person made. false when it could not: the empty or
     * partly written document is removed then, so no broken photo is left where they saved it.
     */
    private fun write(token: String?, uri: Uri): Boolean {
        val file = staged.taken(token)
        try {
            if (file == null) throw IllegalStateException("the staged file is gone")
            val out = context.contentResolver.openOutputStream(uri) ?: throw IllegalStateException("no stream")
            out.use { o -> file.inputStream().use { it.copyTo(o) } }
            return true
        } catch (e: Exception) {
            try {
                DocumentsContract.deleteDocument(context.contentResolver, uri)
            } catch (ignored: Exception) {
                // Not every place can remove a document; it stays empty then.
            }
            return false
        }
    }

    /**
     * How the last save ended when Android restarted the app while its save screen was up: {saved:
     * true|false}, once, or {} when there was none.
     */
    @PluginMethod
    fun restoredSave(call: PluginCall) {
        io.execute {
            val p = prefs()
            val v = p.getString(AFTER_RESTART, null)
            if (v != null) p.edit().remove(AFTER_RESTART).commit()
            call.resolve(if (v == null) JSObject() else JSObject().put("saved", v == "saved"))
        }
    }

    /** Erase everything, and leaving Share unseen: removes the photo files above and the web view's own cache. */
    @PluginMethod
    fun forget(call: PluginCall) {
        io.execute {
            forgetFiles()
            staged.sweep(saving)
            prefs().edit().clear().commit()
            // The voice lab's results kept for adb (VoicePlugin.saveLab).
            File(context.filesDir, "voice-lab").deleteRecursively()
            activity.runOnUiThread {
                bridge.webView.clearCache(true)
                call.resolve()
            }
        }
    }
}
