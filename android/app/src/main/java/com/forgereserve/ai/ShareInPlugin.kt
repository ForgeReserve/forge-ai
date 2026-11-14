package com.forgereserve.ai

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * A photo shared into Forge from another app (the Android share sheet). It is read into this app's
 * memory, never written to storage, and handed to the page once (take), which opens Share unseen with
 * it. Nothing is sent anywhere. The page's side is public/v2/core/native.js.
 */
@CapacitorPlugin(name = "ForgeShareIn")
class ShareInPlugin : Plugin() {
    private class Incoming(val mime: String? = null, val bytes: ByteArray? = null, val problem: String? = null)

    private val worker = Executors.newSingleThreadExecutor()

    @Volatile
    private var incoming: Future<Incoming>? = null

    // BridgeActivity hands every plugin the launch intent once the bridge is up, and each new intent after.
    override fun handleOnNewIntent(intent: Intent) {
        val stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        incoming = when (ShareIntake.decide(intent.action, intent.type, stream != null, fromHistory)) {
            ShareIntake.Decision.IGNORE -> return
            ShareIntake.Decision.NO_PHOTO -> CompletableFuture.completedFuture(Incoming(problem = "none"))
            ShareIntake.Decision.TAKE -> worker.submit<Incoming> { read(stream!!) }
        }
        // Taken: a re-created screen must not take the same photo again.
        activity?.intent = Intent(Intent.ACTION_MAIN)
        notifyListeners("shared", JSObject())
    }

    private fun read(uri: Uri): Incoming =
        try {
            val bytes = context.contentResolver.openInputStream(uri)?.use { ShareIntake.readBounded(it) }
            when {
                bytes == null -> Incoming(problem = "missed")
                else -> ShareIntake.sniff(bytes)?.let { Incoming(mime = it, bytes = bytes) } ?: Incoming(problem = "none")
            }
        } catch (e: Exception) {
            Incoming(problem = "missed")
        }

    /** Whether a shared photo is waiting for the page. */
    @PluginMethod
    fun waiting(call: PluginCall) {
        call.resolve(JSObject().put("waiting", incoming != null))
    }

    /** Hands the waiting photo to the page and forgets it: {mime, data} (base64), {problem}, or {}. */
    @PluginMethod
    fun take(call: PluginCall) {
        val f = incoming
        incoming = null
        if (f == null) {
            call.resolve(JSObject())
            return
        }
        worker.execute {
            val r = try {
                f.get()
            } catch (e: Exception) {
                Incoming(problem = "missed")
            }
            val out = JSObject()
            if (r.bytes != null) out.put("mime", r.mime).put("data", ShareIntake.encode(r.bytes)) else out.put("problem", r.problem)
            call.resolve(out)
        }
    }

    /** Drops a waiting photo unread (Erase everything). */
    @PluginMethod
    fun clear(call: PluginCall) {
        incoming = null
        call.resolve()
    }
}
