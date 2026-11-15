package com.forgereserve.ai

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.RemoteException
import android.os.SystemClock
import java.io.File

/**
 * Forge Private Voice's speech to text in a process of its own (":asr", declared only in the
 * privatevoice manifest), bound by AsrPlugin. Two reasons for the process: a crash in native code (ONNX
 * Runtime) ends this process, not the app, which then uses the phone's recogniser or the engine; and
 * ending the process when the app lets the model go hands every byte of it back. It never touches the
 * microphone: the app records and sends the sound here 100 ms at a time.
 *
 * Messages in: START {id, threads, pin}, AUDIO {id, pcm}, FINISH {id}, CANCEL {id}. Messages out (to
 * replyTo), EVENT {type}: loaded {loadMs, threads}, partial {id, text}, final {id, text, ms, audioS,
 * loadMs, waitedMs, partials, busyMs}, error {id, code, message}.
 */
class AsrService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var work: Handler
    private val messenger = Messenger(Handler(Looper.getMainLooper()) { m -> receive(m); true })

    /** Set on the work thread; read on the main thread to know live words can start. */
    @Volatile private var model: AsrRecognizer? = null
    private var loadMs = -1.0
    private var loadError: Throwable? = null

    private class Session(val id: String, val to: Messenger?) {
        val rec = AsrRules.Recording()
        @Volatile var lastRun = 0
        @Volatile var step = AsrRules.STEP
        @Volatile var busy = false
        @Volatile var done = false
        @Volatile var finishing = false
        var partials = 0
        var busyNs = 0L
    }

    /** The session being heard; set and read on the main thread, read on the work thread. */
    @Volatile private var live: Session? = null

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("forge-asr", Process.THREAD_PRIORITY_AUDIO).apply { start() }
        work = Handler(thread.looper)
    }

    override fun onBind(intent: Intent): IBinder = messenger.binder

    override fun onUnbind(intent: Intent?): Boolean {
        stopSelf()
        return false
    }

    override fun onDestroy() {
        // Ending the process gives the model's memory back at once (native allocations included).
        Process.killProcess(Process.myPid())
    }

    private fun send(to: Messenger?, type: String, data: Bundle) {
        val m = Message.obtain(null, EVENT)
        m.data = Bundle(data).apply { putString("type", type) }
        try {
            to?.send(m)
        } catch (_: RemoteException) {
            // The app is gone.
        }
    }

    /** Loads the model once, on the work thread, on the fast cores when asked (VoiceRules.pinFor). */
    private fun ensureModel(threads: Int, pin: IntArray?, to: Messenger?): AsrRecognizer {
        model?.let { return it }
        loadError?.let { throw it }
        try {
            // Threads the runtime starts from now on stay on these cores. The pin call is the natural
            // voice's (libforge_ptts.so), loaded only where that library runs (VoiceRules.cpuOk).
            if (pin != null) runCatching { PttsNative.load(); PttsNative.pin(pin) }
            val t0 = SystemClock.elapsedRealtimeNanos()
            val m = AsrBundle.open(applicationContext.assets, threads)
            loadMs = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
            model = m
            send(to, "loaded", Bundle().apply { putDouble("loadMs", loadMs); putInt("threads", threads) })
            return m
        } catch (t: Throwable) {
            loadError = t
            throw t
        }
    }

    private fun receive(m: Message) {
        val data = Bundle(m.data)
        val id = data.getString("id") ?: return
        when (m.what) {
            START -> {
                live?.done = true
                val s = Session(id, m.replyTo)
                live = s
                val threads = data.getInt("threads", 2)
                val pin = data.getIntArray("pin")
                // The model loads while the person starts talking.
                work.post {
                    try {
                        ensureModel(threads, pin, s.to)
                    } catch (t: Throwable) {
                        if (!s.done) fail(s, "load", t)
                    }
                }
            }
            AUDIO -> {
                val s = live?.takeIf { it.id == id && !it.done && !it.finishing } ?: return
                val pcm = data.getFloatArray("pcm") ?: return
                s.rec.add(pcm)
                if (model != null && AsrRules.partialDue(s.rec.size, s.lastRun, s.busy, s.step)) {
                    s.busy = true
                    work.post { partial(s) }
                }
            }
            FINISH -> {
                val s = live?.takeIf { it.id == id } ?: return
                val asked = SystemClock.elapsedRealtimeNanos()
                // A live-words pass not yet started is skipped; one already running is waited for.
                s.finishing = true
                // After any pass already queued; waits for the model when it is still loading.
                work.post { finish(s, asked) }
            }
            CANCEL -> live?.takeIf { it.id == id }?.let {
                it.done = true
                live = null
            }
        }
    }

    /** Hears the recording so far again, for the live words. On the work thread. */
    private fun partial(s: Session) {
        try {
            if (s.done || s.finishing) return
            val m = model ?: return
            val pcm = s.rec.snapshot()
            s.lastRun = pcm.size
            val t0 = SystemClock.elapsedRealtimeNanos()
            val text = AsrRules.clean(m.transcribe(pcm))
            val took = SystemClock.elapsedRealtimeNanos() - t0
            s.busyNs += took
            s.step = AsrRules.stepAfter(took / 1e6)
            s.partials++
            if (!s.done && !s.finishing && text.isNotEmpty()) send(s.to, "partial", Bundle().apply { putString("id", s.id); putString("text", text) })
        } catch (t: Throwable) {
            fail(s, "failure", t)
        } finally {
            s.busy = false
        }
    }

    /** The whole recording, once the button is let go. On the work thread. */
    private fun finish(s: Session, asked: Long) {
        if (s.done) return
        try {
            val waitStart = SystemClock.elapsedRealtimeNanos()
            val m = ensureModel(2, null, s.to)
            val pcm = s.rec.snapshot()
            val t0 = SystemClock.elapsedRealtimeNanos()
            val text = if (pcm.size < AsrRules.MIN_SAMPLES) "" else AsrRules.clean(m.transcribe(pcm))
            val now = SystemClock.elapsedRealtimeNanos()
            s.done = true
            if (live === s) live = null
            send(
                s.to,
                "final",
                Bundle().apply {
                    putString("id", s.id)
                    putString("text", text)
                    // From the button let go to the words: the wait the person has.
                    putDouble("ms", (now - asked) / 1e6)
                    putDouble("decodeMs", (now - t0) / 1e6)
                    putDouble("waitedMs", (t0 - waitStart) / 1e6)
                    putDouble("audioS", pcm.size.toDouble() / AsrRules.RATE)
                    putDouble("loadMs", loadMs)
                    putInt("partials", s.partials)
                    putDouble("busyMs", s.busyNs / 1e6)
                    putLong("peakKb", peakKb())
                },
            )
        } catch (t: Throwable) {
            fail(s, if (model == null) "load" else "failure", t)
        }
    }

    private fun fail(s: Session, code: String, t: Throwable) {
        s.done = true
        if (live === s) live = null
        send(s.to, "error", Bundle().apply { putString("id", s.id); putString("code", code); putString("message", t.message ?: t.toString()) })
    }

    /** This process's peak memory (VmHWM), in kB, or -1. */
    private fun peakKb(): Long = try {
        Regex("^VmHWM:\\s+([0-9]+) kB", RegexOption.MULTILINE).find(File("/proc/self/status").readText())?.groupValues?.get(1)?.toLong() ?: -1
    } catch (_: Exception) {
        -1
    }

    companion object {
        const val START = 1
        const val AUDIO = 2
        const val FINISH = 3
        const val CANCEL = 4
        const val EVENT = 100
    }
}
