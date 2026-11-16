package com.forgereserve.ai

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.SystemClock
import android.util.Log
import com.getcapacitor.JSObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile
import kotlin.concurrent.thread

/**
 * The app's side of Forge Private Voice's speech to text, for ForgeAsr (AsrPlugin): records the
 * microphone (16 kHz mono, AudioRecord) and hands the sound 100 ms at a time to the :asr process
 * (AsrService), which holds the model; passes its words back as events. A debug check (check()) feeds a
 * WAV clip through the same path in place of the microphone.
 *
 * emit(id, type, data) gets started, level {level}, partial {text}, final {text}, error {code} and end,
 * always last. Every call is made on the main thread.
 *
 * Memory: the model loads on the first Hold to talk (0.6 to 0.8 s, while the person starts talking) and
 * stays loaded while the app is used; it is let go, by ending the :asr process, after a minute in the
 * background or five minutes with nothing heard (AsrRules). A crash or failed load there makes
 * unavailable() say why until the app starts again.
 */
class AsrClient(private val context: Context, private val emit: (String, String, JSObject) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val exec = Executors.newSingleThreadExecutor()
    private val replies = Messenger(Handler(Looper.getMainLooper()) { m -> onEvent(m); true })

    private class Link(val conn: ServiceConnection, val to: Messenger) {
        @Volatile var dropping = false
    }

    @Volatile private var link: Link? = null

    /** Why it stopped working this session (a crash or a failed load), or null. */
    @Volatile private var broken: String? = null

    /** One Hold to talk. `clip` is a debug check's sound in place of the microphone. */
    private class Live(val id: String, val clip: FloatArray? = null) {
        @Volatile var to: Messenger? = null
        val pending = ArrayList<FloatArray>()
        @Volatile var capturing = true
        var capture: Thread? = null
        var deadline: Runnable? = null
        var stopped = false
        @Volatile var lastLevel = 0L
        var lastPartial = ""
        val startedAt = SystemClock.elapsedRealtime()
        var firstWordsMs = -1L
    }

    /** On the main thread only. */
    private var live: Live? = null

    private val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    private val libThere by lazy {
        try {
            ZipFile(context.applicationInfo.sourceDir).use { it.getEntry("lib/arm64-v8a/libsherpa-onnx-jni.so") != null }
        } catch (_: Exception) {
            false
        }
    }

    private fun modelThere() = AsrBundle.BUNDLED && try {
        context.assets.open("${AsrBundle.DIR}/tokens.txt").close()
        true
    } catch (_: Exception) {
        false
    }

    /** Why this app cannot hear here, or null when it can. */
    fun unavailable(): String? = AsrRules.unavailable(
        AsrBundle.BUNDLED,
        Build.SUPPORTED_ABIS.contains("arm64-v8a") && VoiceRules.arm64Libs(context.applicationInfo.nativeLibraryDir),
        AsrBundle.BUNDLED && libThere,
        modelThere(),
        broken,
    )

    val listening get() = live != null

    @SuppressLint("MissingPermission") // AsrPlugin asks for it first
    private fun openMic(): AudioRecord {
        val min = AudioRecord.getMinBufferSize(AsrRules.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, AsrRules.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, AsrRules.CHUNK * 2 * 4))
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            throw IllegalStateException("The microphone did not open.")
        }
        r.startRecording()
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            r.release()
            throw IllegalStateException("The microphone did not start.")
        }
        return r
    }

    /** Starts listening on the microphone. Throws with the reason when the microphone does not start. */
    fun start(id: String) {
        val rec = openMic()
        val l = Live(id)
        launch(l) { capture(l, rec) }
    }

    /** Starts a session: the :asr process and the model on exec, the sound on its own thread. */
    private fun launch(l: Live, source: () -> Unit) {
        live = l
        main.removeCallbacks(releaser)
        exec.execute {
            try {
                val to = ensure()
                val big = VoiceRules.bigCores(cpuMaxFreqs())
                val threads = VoiceRules.threads(0, Runtime.getRuntime().availableProcessors(), big)
                val cpuOk = VoiceRules.cpuOk(runCatching { File("/proc/cpuinfo").readText() }.getOrDefault(""))
                synchronized(l) {
                    send(to, AsrService.START, Bundle().apply {
                        putString("id", l.id)
                        putInt("threads", threads)
                        if (cpuOk) VoiceRules.pinFor(threads, big)?.let { putIntArray("pin", it) }
                    })
                    for (p in l.pending) send(to, AsrService.AUDIO, audio(l.id, p))
                    l.pending.clear()
                    l.to = to
                }
            } catch (e: Exception) {
                main.post { if (live === l) fail(l, "unavailable", e.message ?: "The speech to text did not start.", breaks = true) }
            }
        }
        l.capture = thread(name = "forge-asr-sound", priority = Thread.MAX_PRIORITY) { source() }
        later(l, AsrRules.MAX_SECONDS * 1000L) { stop(l.id) }
        emit(l.id, "started", JSObject())
    }

    private fun cpuMaxFreqs() = (0 until Runtime.getRuntime().availableProcessors()).map { i ->
        try {
            File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").readText().trim().toLong()
        } catch (_: Exception) {
            null
        }
    }

    private fun audio(id: String, pcm: FloatArray) = Bundle().apply {
        putString("id", id)
        putFloatArray("pcm", pcm)
    }

    /** Reads the microphone 100 ms at a time until stopped. On the sound thread. */
    private fun capture(l: Live, rec: AudioRecord) {
        val buf = ShortArray(AsrRules.CHUNK)
        try {
            while (l.capturing) {
                var n = 0
                while (n < buf.size && l.capturing) {
                    val r = rec.read(buf, n, buf.size - n)
                    if (r < 0) throw IllegalStateException("The microphone stopped ($r).")
                    n += r
                }
                if (n > 0) feed(l, AsrRules.floats(buf, n))
            }
        } catch (e: Exception) {
            main.post { if (live === l) fail(l, "audio", e.message ?: "The microphone stopped.") }
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
    }

    /** A debug check's clip, fed as a microphone would (100 ms every 100 ms), then let go. On the sound thread. */
    private fun play(l: Live, clip: FloatArray) {
        var at = 0
        val t0 = SystemClock.elapsedRealtime()
        while (at < clip.size && l.capturing) {
            val end = minOf(clip.size, at + AsrRules.CHUNK)
            feed(l, clip.copyOfRange(at, end))
            at = end
            val wait = t0 + at * 1000L / AsrRules.RATE - SystemClock.elapsedRealtime()
            if (wait > 0) Thread.sleep(wait)
        }
        main.post { if (live === l) stop(l.id) }
    }

    private fun feed(l: Live, pcm: FloatArray) {
        synchronized(l) {
            val to = l.to
            if (to == null) l.pending.add(pcm) else runCatching { send(to, AsrService.AUDIO, audio(l.id, pcm)) }
        }
        val now = SystemClock.elapsedRealtime()
        if (now - l.lastLevel >= 80) {
            l.lastLevel = now
            val level = AsrRules.level(pcm)
            main.post { if (live === l && !l.stopped) emit(l.id, "level", JSObject().put("level", level)) }
        }
    }

    private fun send(to: Messenger, what: Int, data: Bundle) {
        val m = Message.obtain(null, what)
        m.data = data
        m.replyTo = replies
        to.send(m)
    }

    /** The button was let go: the rest of the sound, then the whole recording heard. */
    fun stop(id: String?) {
        val l = live?.takeIf { it.id == id } ?: return
        if (l.stopped) return
        l.stopped = true
        l.capturing = false
        val capture = l.capture
        exec.execute {
            capture?.join(1_000)
            synchronized(l) { l.to?.let { runCatching { send(it, AsrService.FINISH, Bundle().apply { putString("id", l.id) }) } } }
        }
        // If the words do not come in time, what was heard so far is the question.
        later(l, AsrRules.FINISH_MS) {
            emit(l.id, "final", JSObject().put("text", l.lastPartial))
            end(l)
            emit(l.id, "end", JSObject())
        }
    }

    /** Drops what is being heard. */
    fun cancel(id: String?) {
        val l = live?.takeIf { it.id == id } ?: return
        abort(l)
        emit(l.id, "end", JSObject())
    }

    /** The microphone off, the process told to forget it. */
    private fun abort(l: Live) {
        l.capturing = false
        exec.execute { synchronized(l) { l.to?.let { runCatching { send(it, AsrService.CANCEL, Bundle().apply { putString("id", l.id) }) } } } }
        end(l)
    }

    private fun end(l: Live) {
        l.capturing = false
        l.deadline?.let { main.removeCallbacks(it) }
        if (live === l) live = null
        releaseIn(AsrRules.RELEASE_IDLE_MS)
    }

    private fun fail(l: Live, code: String, message: String, breaks: Boolean = false) {
        if (breaks) broken = message
        Log.w(TAG, "failed code=$code: $message")
        emit(l.id, "error", JSObject().put("code", code))
        abort(l)
        emit(l.id, "end", JSObject())
    }

    private fun later(l: Live, ms: Long, fn: () -> Unit) {
        l.deadline?.let { main.removeCallbacks(it) }
        l.deadline = Runnable { if (live === l) fn() }.also { main.postDelayed(it, ms) }
    }

    private fun onEvent(m: Message) {
        if (m.what != AsrService.EVENT) return
        val b = m.data
        val l = live?.takeIf { it.id == b.getString("id") }
        when (b.getString("type")) {
            "loaded" -> if (debuggable) Log.i(TAG, "loaded loadMs=${"%.0f".format(b.getDouble("loadMs"))} threads=${b.getInt("threads")}")
            "partial" -> l?.let {
                it.lastPartial = b.getString("text") ?: ""
                if (it.firstWordsMs < 0) it.firstWordsMs = SystemClock.elapsedRealtime() - it.startedAt
                emit(it.id, "partial", JSObject().put("text", it.lastPartial))
            }
            "final" -> l?.let {
                val text = b.getString("text") ?: ""
                if (debuggable) {
                    // Timings only; the words are logged for a debug check's clip, never for the microphone.
                    val words = if (it.clip != null) " text=\"$text\"" else ""
                    Log.i(TAG, "final${if (it.clip != null) " check" else ""} afterReleaseMs=${"%.0f".format(b.getDouble("ms"))} decodeMs=${"%.0f".format(b.getDouble("decodeMs"))} waitedMs=${"%.0f".format(b.getDouble("waitedMs"))} audioS=${"%.2f".format(b.getDouble("audioS"))} firstWordsMs=${it.firstWordsMs} partials=${b.getInt("partials")} busyMs=${"%.0f".format(b.getDouble("busyMs"))} loadMs=${"%.0f".format(b.getDouble("loadMs"))} peakKb=${b.getLong("peakKb")}$words")
                }
                emit(it.id, "final", JSObject().put("text", text))
                end(it)
                emit(it.id, "end", JSObject())
            }
            "error" -> l?.let {
                val load = b.getString("code") == "load"
                fail(it, if (load) "unavailable" else "failure", b.getString("message") ?: "The speech to text failed.", breaks = load)
            }
        }
    }

    // ------------------------------------------------------------------ the :asr process

    /** The :asr process, started when needed. On exec. */
    private fun ensure(): Messenger {
        link?.let { return it.to }
        var to: Messenger? = null
        val up = CountDownLatch(1)
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                to = service?.let { Messenger(it) }
                up.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {}
        }
        if (!context.bindService(Intent(context, AsrService::class.java), conn, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)) throw IllegalStateException("The speech to text could not start.")
        if (!up.await(10, TimeUnit.SECONDS) || to == null) {
            runCatching { context.unbindService(conn) }
            throw IllegalStateException("The speech to text did not start.")
        }
        val l = Link(conn, to!!)
        to!!.binder.linkToDeath({ died(l) }, 0)
        link = l
        return l.to
    }

    private fun died(l: Link) {
        if (link === l) link = null
        if (l.dropping) return
        runCatching { context.unbindService(l.conn) }
        main.post { live?.let { fail(it, "unavailable", "The speech to text stopped working.", breaks = true) } }
    }

    /** Lets the model go: ends the :asr process. Only between questions. */
    private val releaser = Runnable {
        if (live != null) return@Runnable
        exec.execute {
            link?.let {
                it.dropping = true
                link = null
                runCatching { context.unbindService(it.conn) }
                if (debuggable) Log.i(TAG, "released")
            }
        }
    }

    private fun releaseIn(ms: Long) {
        main.removeCallbacks(releaser)
        main.postDelayed(releaser, ms)
    }

    /** The app went to the background: drops what was being heard (nothing is sent unseen), lets the model go a minute later. */
    fun paused() {
        live?.let {
            if (it.clip == null) {
                emit(it.id, "error", JSObject().put("code", "interrupted"))
                abort(it)
                emit(it.id, "end", JSObject())
            }
        }
        releaseIn(AsrRules.RELEASE_BACKGROUND_MS)
    }

    fun resumed() {
        if (live == null && link != null) releaseIn(AsrRules.RELEASE_IDLE_MS)
    }

    fun destroy() {
        main.removeCallbacks(releaser)
        live?.let { it.capturing = false }
        link?.let {
            it.dropping = true
            runCatching { context.unbindService(it.conn) }
        }
        exec.shutdown()
    }

    /**
     * Debug builds only: hears a 16 kHz mono WAV from the app's own files (files/asr-check/<name>, put
     * there with adb run-as) through this whole path, fed as a microphone would, and logs the words and
     * timings (`adb logcat -s ForgeAsr`).
     */
    fun check(name: String) {
        if (!debuggable || !AsrRules.checkName(name)) return
        val why = unavailable() ?: if (live != null) "busy" else null
        if (why != null) {
            Log.i(TAG, "check not run: $why")
            return
        }
        val clip = try {
            AsrRules.wav(File(File(context.filesDir, "asr-check"), name).readBytes())
        } catch (e: Exception) {
            Log.i(TAG, "check could not read $name: ${e.message}")
            return
        }
        Log.i(TAG, "check $name ${"%.2f".format(clip.size.toDouble() / AsrRules.RATE)} s")
        val l = Live("check-${SystemClock.elapsedRealtime()}", clip)
        launch(l) { play(l, clip) }
    }

    companion object {
        const val TAG = "ForgeAsr"
    }
}
