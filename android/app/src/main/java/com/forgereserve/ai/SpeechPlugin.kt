package com.forgereserve.ai

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * ForgeSpeech: Hold to talk heard by the phone's own on-device speech recogniser (docs/VOICE.md, Speech
 * input), for public/v2/core/native.js nativeSpeech. The sound never leaves the phone: only
 * SpeechRecognizer.createOnDeviceSpeechRecognizer is used (Android 12 and up), never the default
 * recogniser, which may send it to a server. There is no fallback to one here; the page uses the engine
 * instead. Ported from flash-mobile's VoiceInputBridgeModule (MIT, Galoy Inc.).
 *
 * available({locale}) resolves {onDevice, reason, locale}. start({id, locale}) resolves once listening
 * starts, or rejects with code permission, busy or unavailable; then events "speech" {id, type}: started,
 * level {level 0..1}, partial {text}, final {text}, error {code: permission, unavailable, no-speech, busy,
 * audio, failure, interrupted}, and end, always last. stop({id}) ends listening and the last result
 * becomes final; cancel({id}) drops it. The microphone permission is the one the app already has for
 * Hold to talk (RECORD_AUDIO), asked here the first time if the web view has not asked yet.
 */
@CapacitorPlugin(name = "ForgeSpeech", permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])])
class SpeechPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())

    private inner class Live(val id: String, val intent: Intent, val recognizer: SpeechRecognizer) {
        val rules = SpeechSession()
        var deadline: Runnable? = null
        var lastLevel = 0L
    }

    private var live: Live? = null

    @PluginMethod
    fun available(call: PluginCall) {
        SpeechCheck.run(context, main, call.getString("locale")) { a -> call.resolve(JSObject().put("onDevice", a.onDevice).put("reason", a.reason).put("locale", a.locale)) }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (call.getString("id") == null) return call.reject("No id.", "bad_call")
        if (getPermissionState("microphone") != PermissionState.GRANTED) return requestPermissionForAlias("microphone", call, "afterMicrophone")
        begin(call)
    }

    @PermissionCallback
    private fun afterMicrophone(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call) else call.reject("The microphone is not allowed.", "permission")
    }

    private fun begin(call: PluginCall) {
        val id = call.getString("id")!!
        val locale = SpeechRules.tag(call.getString("locale"))
        main.post {
            if (live != null) return@post call.reject("Already listening.", "busy")
            SpeechRules.base(Build.VERSION.SDK_INT, onDeviceService(context), locale)?.takeIf { !it.onDevice }?.let { return@post call.reject(it.reason, "unavailable") }
            val r = try {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            } catch (e: Exception) {
                return@post call.reject(e.message ?: "No on-device recogniser.", "unavailable")
            }
            val l = Live(id, SpeechCheck.intent(locale), r)
            live = l
            r.setRecognitionListener(listener(l))
            try {
                r.startListening(l.intent)
            } catch (e: Exception) {
                release(l)
                return@post call.reject(e.message ?: "The recogniser did not start.", "unavailable")
            }
            // A safety stop well past the page's own 60 s limit.
            later(l, 90_000) { stopLive(l) }
            call.resolve()
        }
    }

    private fun listener(l: Live) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = emit(l.id, "started")
        override fun onRmsChanged(rmsdB: Float) {
            val now = System.currentTimeMillis()
            if (now - l.lastLevel < 80 || live !== l) return
            l.lastLevel = now
            // About -2 dB in silence to 10 dB when speaking, as 0 to 0.6 for the level bars.
            emit(l.id, "level", JSObject().put("level", ((rmsdB + 2f) / 20f).coerceIn(0f, 0.6f).toDouble()))
        }
        override fun onPartialResults(results: Bundle?) = act(l, l.rules.onPartial(transcript(results)))
        override fun onResults(results: Bundle?) = act(l, l.rules.onResults(transcript(results)))
        override fun onError(error: Int) = act(l, l.rules.onError(SpeechRules.errorCode(error)))
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun transcript(results: Bundle?) = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    private fun act(l: Live, acts: List<SpeechSession.Act>) {
        if (live !== l) return
        for (a in acts) when (a) {
            is SpeechSession.Act.Words -> emit(l.id, a.type, JSObject().put("text", a.text))
            is SpeechSession.Act.Fail -> emit(l.id, "error", JSObject().put("code", a.code))
            SpeechSession.Act.Restart -> main.post {
                if (live !== l) return@post
                try {
                    l.recognizer.startListening(l.intent)
                } catch (_: Exception) {
                    act(l, l.rules.onError("failure"))
                }
            }
            SpeechSession.Act.End -> {
                release(l)
                emit(l.id, "end")
            }
        }
    }

    private fun later(l: Live, ms: Long, fn: () -> Unit) {
        l.deadline?.let { main.removeCallbacks(it) }
        l.deadline = Runnable { if (live === l) fn() }.also { main.postDelayed(it, ms) }
    }

    private fun stopLive(l: Live) {
        if (!l.rules.held) return act(l, l.rules.onDeadline())
        l.rules.onStop()
        try {
            l.recognizer.stopListening()
        } catch (_: Exception) {
            return act(l, l.rules.onDeadline())
        }
        // The last result usually comes within a second; if not, what was heard so far is the question.
        later(l, 4_000) { act(l, l.rules.onDeadline()) }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val id = call.getString("id")
        main.post {
            live?.takeIf { it.id == id }?.let { stopLive(it) }
            call.resolve()
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id")
        main.post {
            live?.takeIf { it.id == id }?.let {
                release(it)
                emit(it.id, "end")
            }
            call.resolve()
        }
    }

    private fun release(l: Live) {
        if (live === l) live = null
        l.deadline?.let { main.removeCallbacks(it) }
        try {
            l.recognizer.cancel()
        } catch (_: Exception) {
            /* already ended */
        }
        try {
            l.recognizer.destroy()
        } catch (_: Exception) {
            /* already destroyed by the service */
        }
    }

    private fun emit(id: String, type: String, data: JSObject = JSObject()) = notifyListeners("speech", data.put("id", id).put("type", type))

    /** Leaving the app drops what was being heard: nothing is sent unseen. */
    override fun handleOnPause() {
        main.post {
            live?.let {
                release(it)
                emit(it.id, "error", JSObject().put("code", "interrupted"))
                emit(it.id, "end")
            }
        }
        super.handleOnPause()
    }

    override fun handleOnDestroy() {
        main.post { live?.let { release(it) } }
        super.handleOnDestroy()
    }

    companion object {
        fun onDeviceService(context: Context) = Build.VERSION.SDK_INT >= SpeechRules.MIN_SDK && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    }
}

/**
 * Whether the phone's on-device recogniser can hear `locale` now. Also run by a debug build from adb
 * (MainActivity, forge.speechCheck), which logs the same line: `adb logcat -s ForgeSpeech`.
 */
object SpeechCheck {
    const val TAG = "ForgeSpeech"
    private const val CHECK_MS = 3_000L

    fun intent(locale: String) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    }

    fun run(context: Context, main: Handler, rawLocale: String?, done: (SpeechRules.Availability) -> Unit) {
        val locale = SpeechRules.tag(rawLocale)
        main.post {
            var settled = false
            var probe: SpeechRecognizer? = null
            var deadline: Runnable? = null
            fun complete(a: SpeechRules.Availability) {
                if (settled) return
                settled = true
                deadline?.let { main.removeCallbacks(it) }
                try {
                    probe?.destroy()
                } catch (_: Exception) {
                    /* already released */
                }
                Log.i(TAG, "available locale=$locale onDevice=${a.onDevice} reason=${a.reason} listen=${a.locale} sdk=${Build.VERSION.SDK_INT} model=${Build.MODEL}")
                done(a)
            }
            try {
                SpeechRules.base(Build.VERSION.SDK_INT, SpeechPlugin.onDeviceService(context), locale)?.let { return@post complete(it) }
                // Never reached below Android 13 (base answers there); kept so the API level is plain here.
                if (Build.VERSION.SDK_INT < SpeechRules.SUPPORT_SDK) return@post
                val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                probe = r
                deadline = Runnable { complete(SpeechRules.Availability(false, "check-timed-out", locale)) }.also { main.postDelayed(it, CHECK_MS) }
                r.checkRecognitionSupport(
                    intent(locale),
                    { main.post(it) },
                    object : RecognitionSupportCallback {
                        override fun onSupportResult(support: RecognitionSupport) =
                            complete(SpeechRules.fromSupport(support.installedOnDeviceLanguages, support.pendingOnDeviceLanguages, support.supportedOnDeviceLanguages, locale))

                        override fun onError(error: Int) = complete(SpeechRules.fromSupportError(error, locale))
                    },
                )
            } catch (e: Exception) {
                complete(SpeechRules.Availability(false, "check-failed-${e.javaClass.simpleName}", locale))
            }
        }
    }
}
