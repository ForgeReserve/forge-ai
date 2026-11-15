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

/**
 * The native natural voice in a process of its own (":voice", AndroidManifest.xml), bound by
 * VoicePlugin. Two reasons for the process: the model's worker pool is built once per process, with
 * the thread count set before the model loads, so another thread count is another process (the voice
 * lab compares 2, 4 and 6); and a crash in native code ends this process, not the app, which then
 * reads with the browser's build of the same voice. The process ends when the app unbinds.
 *
 * Messages in (from the app): OPEN {threads}, SPEAK {id, pieces, voice, rtf, spc, preferNatural,
 * phoneVoice, play}, STOP {id}, BENCH {id, text, voice}. Messages out (to replyTo): EVENT with
 * {type: opened | started | buffering | end | error | bench, ...}.
 */
class VoiceService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var work: Handler
    private lateinit var engine: VoiceEngine
    private val messenger = Messenger(Handler(Looper.getMainLooper()) { m -> receive(m); true })

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("forge-voice", Process.THREAD_PRIORITY_URGENT_AUDIO).apply { start() }
        work = Handler(thread.looper)
        engine = VoiceEngine(applicationContext)
    }

    override fun onBind(intent: Intent): IBinder = messenger.binder

    override fun onUnbind(intent: Intent?): Boolean {
        stopSelf()
        return false
    }

    override fun onDestroy() {
        // The thread count lives as long as the process: end it, so the next bind starts afresh.
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

    private fun fail(to: Messenger?, id: String?, code: String, t: Throwable) =
        send(to, "error", Bundle().apply { putString("id", id); putString("code", code); putString("message", t.message ?: t.toString()) })

    private fun receive(m: Message) {
        val data = Bundle(m.data)
        val to = m.replyTo
        val id = data.getString("id")
        when (m.what) {
            OPEN -> work.post {
                try {
                    engine.open(data.getInt("threads", 0))
                    send(to, "opened", engine.info().apply { putString("id", id) })
                } catch (t: Throwable) {
                    fail(to, id, "load", t)
                }
            }
            // Stop is seen at once, from this thread, by the speaking loop on the voice thread.
            STOP -> id?.let { engine.stop(it) }
            SPEAK -> {
                work.post {
                    if (id != null && engine.stopped.remove(id)) return@post send(to, "end", Bundle().apply { putString("id", id); putBoolean("stopped", true) })
                    try {
                        engine.open(data.getInt("threads", 0))
                        engine.speak(data) { type, b -> send(to, type, b) }
                    } catch (t: Throwable) {
                        fail(to, id, "load", t)
                    }
                }
            }
            BENCH -> work.post {
                try {
                    engine.open(data.getInt("threads", 0))
                    send(to, "bench", engine.bench(data))
                } catch (t: Throwable) {
                    fail(to, id, "failed", t)
                }
            }
        }
    }

    companion object {
        const val OPEN = 1
        const val SPEAK = 2
        const val STOP = 3
        const val BENCH = 4
        const val EVENT = 100
    }
}
