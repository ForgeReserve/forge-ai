package com.forgereserve.ai

import android.Manifest
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * ForgeAsr: Hold to talk heard by Forge Private Voice's own speech to text (docs/VOICE.md, Bundled speech
 * to text), for public/v2/core/native.js nativeAsr and the forge.voice-in.bundled module. The sound never
 * leaves the phone and no other app hears it: the app records the microphone itself and the model
 * (Moonshine tiny through sherpa-onnx, AsrBundle) runs in the app's own :asr process (AsrService), through
 * AsrClient. In the universal APK there is no model, and available() says so.
 *
 * The calls and events are ForgeSpeech's, so the page handles both alike. available() resolves
 * {available, reason, model, language}. start({id}) resolves once the microphone records, or rejects with
 * code permission, busy, unavailable or audio; then events "asr" {id, type}: started, level {level 0..1},
 * partial {text} (the recording so far heard again every 500 ms), final {text}, error {code: unavailable,
 * audio, failure, interrupted}, and end, always last. stop({id}) ends the recording and the whole of it is
 * heard: final; cancel({id}) drops it. The microphone permission is the one the app already has for Hold
 * to talk (RECORD_AUDIO), asked here the first time if the web view has not asked yet.
 */
@CapacitorPlugin(name = "ForgeAsr", permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])])
class AsrPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private val made = lazy { AsrClient(context) { id, type, data -> notifyListeners("asr", data.put("id", id).put("type", type)) } }
    private val client by made

    @PluginMethod
    fun available(call: PluginCall) {
        main.post {
            val why = client.unavailable()
            call.resolve(JSObject().put("available", why == null).put("reason", why).put("model", AsrBundle.MODEL.ifEmpty { null }).put("language", "en"))
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (call.getString("id") == null) return call.reject("No id.", "bad_call")
        // Before the microphone is asked for: the universal APK never asks on this plugin's account.
        client.unavailable()?.let { return call.reject(it, "unavailable") }
        if (getPermissionState("microphone") != PermissionState.GRANTED) return requestPermissionForAlias("microphone", call, "afterMicrophone")
        begin(call)
    }

    @PermissionCallback
    private fun afterMicrophone(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call) else call.reject("The microphone is not allowed.", "permission")
    }

    private fun begin(call: PluginCall) {
        val id = call.getString("id")!!
        main.post {
            client.unavailable()?.let { return@post call.reject(it, "unavailable") }
            if (client.listening) return@post call.reject("Already listening.", "busy")
            try {
                client.start(id)
            } catch (e: Exception) {
                return@post call.reject(e.message ?: "The microphone did not start.", "audio")
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val id = call.getString("id")
        main.post {
            client.stop(id)
            call.resolve()
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id")
        main.post {
            client.cancel(id)
            call.resolve()
        }
    }

    /** Debug builds only (MainActivity, forge.asrCheck; AsrClient.check). */
    fun check(name: String) = main.post { client.check(name) }

    override fun handleOnPause() {
        main.post { if (made.isInitialized()) client.paused() }
        super.handleOnPause()
    }

    override fun handleOnResume() {
        main.post { if (made.isInitialized()) client.resumed() }
        super.handleOnResume()
    }

    override fun handleOnDestroy() {
        main.post { if (made.isInitialized()) client.destroy() }
        super.handleOnDestroy()
    }
}
