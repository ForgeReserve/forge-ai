package com.forgereserve.ai

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * ForgeVoice: the natural voice made by native code (docs/VOICE.md, Native voice in the Android app),
 * for public/v2/core/native.js nativeVoice. The model runs in the voice process (VoiceService), which
 * plays the sound itself through an AudioTrack: no sound passes through the page. The page gets
 * events: started, buffering {fraction}, end {stats}, error {code, message}, each with the answer's id.
 *
 * status() says whether this phone can run it (64-bit ARM with ARMv8.2's dot product and half floats,
 * the libraries in this APK). speak({id, pieces, voice, rtf, spc, preferNatural, phoneVoice, threads})
 * resolves with the stats once the answer was read, or rejects with code too-slow (the phone's own
 * voice should read it), crashed (the voice process ended), load or failed. bench({id, text, voice,
 * threads}) makes the sound without playing it. threads is fixed per voice process: asking for another
 * count ends the process and starts a new one.
 */
@CapacitorPlugin(name = "ForgeVoice")
class VoicePlugin : Plugin() {
    private val exec = Executors.newSingleThreadExecutor()
    private val calls = ConcurrentHashMap<String, PluginCall>()
    private val replies by lazy { Messenger(Handler(Looper.getMainLooper()) { m -> onEvent(m); true }) }

    private class Link(val conn: ServiceConnection, val to: Messenger, val threads: Int) {
        val dead = CountDownLatch(1)
        @Volatile var dropping = false
    }

    @Volatile private var link: Link? = null

    private fun cores() = Runtime.getRuntime().availableProcessors()

    private fun big() = VoiceRules.bigCores((0 until cores()).map { i ->
        try {
            File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").readText().trim().toLong()
        } catch (_: Exception) {
            null
        }
    })

    private fun prefs() = context.getSharedPreferences("forge.voice", Context.MODE_PRIVATE)

    /** Why this phone cannot run the native voice, or null when it can. */
    private fun unavailable(): String? {
        // The ABI this app was installed for (lib/arm64), not only what the phone lists: an x86 emulator
        // that translates ARM still installs the x86 placeholder (libforge_noabi.so).
        if (!Build.SUPPORTED_ABIS.contains("arm64-v8a") || !VoiceRules.arm64Libs(context.applicationInfo.nativeLibraryDir)) return "not a 64-bit ARM phone"
        val cpu = try {
            File("/proc/cpuinfo").readText()
        } catch (_: Exception) {
            ""
        }
        if (!VoiceRules.cpuOk(cpu)) return "this processor lacks the instructions the voice needs (ARMv8.2 dot product and half floats)"
        return try {
            context.assets.open("${VoiceEngine.ASSETS}/index.json").close()
            null
        } catch (_: Exception) {
            "the voice files are not in this app"
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val big = big()
        val why = unavailable()
        val chosen = prefs().getInt("threads", 0)
        call.resolve(
            JSObject()
                .put("available", why == null)
                .put("reason", why)
                .put("cores", cores())
                .put("bigCores", JSArray(big))
                .put("threads", VoiceRules.threads(chosen, cores(), big))
                .put("chosenThreads", chosen)
                .put("defaultThreads", VoiceRules.defaultThreads(cores(), big)),
        )
    }

    /** {threads}: the threads the app reads with from now on (0: the default). */
    @PluginMethod
    fun config(call: PluginCall) {
        val n = call.getInt("threads", 0) ?: 0
        prefs().edit().putInt("threads", n.coerceIn(0, cores())).apply()
        status(call)
    }

    private fun threadsOf(call: PluginCall): Int {
        val asked = call.getInt("threads", 0) ?: 0
        return VoiceRules.threads(if (asked > 0) asked else prefs().getInt("threads", 0), cores(), big())
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun speak(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No id.", "bad_call")
        val pieces = call.getArray("pieces")?.toList<Any>()?.map { it.toString() } ?: listOfNotNull(call.getString("text"))
        if (pieces.isEmpty()) return call.reject("No text.", "bad_call")
        val data = Bundle().apply {
            putString("id", id)
            putStringArrayList("pieces", ArrayList(pieces))
            putString("voice", call.getString("voice"))
            putDouble("rtf", call.getDouble("rtf") ?: -1.0)
            putDouble("spc", call.getDouble("spc") ?: -1.0)
            putBoolean("preferNatural", call.getBoolean("preferNatural", false) == true)
            putBoolean("phoneVoice", call.getBoolean("phoneVoice", false) == true)
            putBoolean("play", call.getBoolean("play", true) != false)
        }
        send(call, id, VoiceService.SPEAK, data)
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun bench(call: PluginCall) {
        val id = call.getString("id") ?: "bench-${System.nanoTime()}"
        val data = Bundle().apply {
            putString("id", id)
            putString("text", call.getString("text") ?: "")
            putString("voice", call.getString("voice"))
        }
        send(call, id, VoiceService.BENCH, data)
    }

    /** {id}: stops that answer, or every one when no id is given. */
    @PluginMethod
    fun stop(call: PluginCall) {
        val ids = call.getString("id")?.let { listOf(it) } ?: calls.keys.toList()
        val to = link?.to
        for (id in ids) {
            val m = Message.obtain(null, VoiceService.STOP)
            m.data = Bundle().apply { putString("id", id) }
            try {
                to?.send(m)
            } catch (_: Exception) {
            }
        }
        call.resolve()
    }

    /**
     * {name, json}: the voice lab's results, kept in the app's own files (files/voice-lab/name), where
     * a debug build's adb run-as can read them. Nothing else reads them; Erase everything removes them.
     */
    @PluginMethod
    fun saveLab(call: PluginCall) {
        val name = call.getString("name") ?: ""
        val json = call.getString("json") ?: ""
        if (!VoiceRules.labName(name) || json.length > 4_000_000) return call.reject("Not a lab result.", "bad_call")
        val dir = File(context.filesDir, "voice-lab").apply { mkdirs() }
        File(dir, name).writeText(json)
        call.resolve(JSObject().put("saved", true))
    }

    /** Ends the voice process and frees its memory. */
    @PluginMethod
    fun release(call: PluginCall) {
        exec.execute {
            link?.let { drop(it) }
            call.resolve()
        }
    }

    private fun send(call: PluginCall, id: String, what: Int, data: Bundle) {
        exec.execute {
            try {
                val threads = threadsOf(call)
                val why = unavailable()
                if (why != null) return@execute call.reject(why, "unavailable")
                val to = ensure(threads)
                calls[id] = call
                val m = Message.obtain(null, what)
                m.data = data.apply { putInt("threads", threads) }
                m.replyTo = replies
                to.send(m)
            } catch (e: Exception) {
                calls.remove(id)
                call.reject(e.message ?: e.toString(), "load")
            }
        }
    }

    /** The voice process for this many threads, started (or started afresh) when needed. On exec. */
    private fun ensure(threads: Int): Messenger {
        link?.let { if (it.threads == threads && it.dead.count > 0) return it.to else drop(it) }
        var to: Messenger? = null
        val up = CountDownLatch(1)
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                to = service?.let { Messenger(it) }
                up.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {}
        }
        if (!context.bindService(Intent(context, VoiceService::class.java), conn, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)) throw IllegalStateException("could not start the voice")
        if (!up.await(15, TimeUnit.SECONDS) || to == null) {
            context.unbindService(conn)
            throw IllegalStateException("the voice did not start")
        }
        val l = Link(conn, to!!, threads)
        to!!.binder.linkToDeath({ died(l) }, 0)
        link = l
        return l.to
    }

    /** Unbinds and waits for the process to end, so the next one starts with its own thread count. */
    private fun drop(l: Link) {
        l.dropping = true
        try {
            context.unbindService(l.conn)
        } catch (_: Exception) {
        }
        l.dead.await(5, TimeUnit.SECONDS)
        if (link === l) link = null
    }

    private fun died(l: Link) {
        l.dead.countDown()
        if (link === l) link = null
        if (!l.dropping) {
            try {
                context.unbindService(l.conn)
            } catch (_: Exception) {
            }
        }
        // Whatever was being read or measured is gone with the process.
        for ((id, c) in calls) {
            calls.remove(id)
            c.reject(if (l.dropping) "The voice was stopped." else "The voice stopped working.", if (l.dropping) "stopped" else "crashed")
            notifyListeners("error", JSObject().put("id", id).put("code", if (l.dropping) "stopped" else "crashed"))
        }
    }

    private fun json(b: Bundle): JSObject {
        val o = JSObject()
        for (k in b.keySet()) {
            @Suppress("DEPRECATION")
            when (val v = b.get(k)) {
                null -> {}
                is IntArray -> o.put(k, JSArray(v.toList()))
                is Double -> if (v.isFinite()) o.put(k, v)
                else -> o.put(k, v)
            }
        }
        return o
    }

    private fun onEvent(m: Message) {
        if (m.what != VoiceService.EVENT) return
        val b = m.data
        val type = b.getString("type") ?: return
        val id = b.getString("id") ?: ""
        val o = json(b).apply { remove("type") }
        when (type) {
            "started", "buffering" -> notifyListeners(type, o)
            "end", "bench" -> {
                calls.remove(id)?.resolve(o)
                if (type == "end") notifyListeners("end", o)
            }
            "error" -> {
                val c = calls.remove(id)
                notifyListeners("error", o)
                c?.reject(b.getString("message") ?: "The voice failed.", b.getString("code") ?: "failed", null, o)
            }
        }
    }

    override fun handleOnDestroy() {
        link?.let {
            it.dropping = true
            try {
                context.unbindService(it.conn)
            } catch (_: Exception) {
            }
        }
        exec.shutdown()
        super.handleOnDestroy()
    }
}
