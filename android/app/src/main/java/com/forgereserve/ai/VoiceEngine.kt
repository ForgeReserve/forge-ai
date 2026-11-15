package com.forgereserve.ai

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The native natural voice inside the voice process (VoiceService): the model loaded once, on one
 * thread, with the thread count this process was started for. The model is the one the APK already
 * carries for the web view (public/v2/voice/phonon/). The library reads a checkpoint folder from the
 * file system, by path (ptts_new), and cannot read inside the APK, so the files are copied once into
 * the app's no-backup storage, laid out as that folder (VoiceRules.modelCopies), and kept until the
 * model changes. Every call here runs on the voice thread.
 */
class VoiceEngine(private val ctx: Context) {
    private var handle = 0L
    private var threads = 0
    private var pinned: IntArray? = null
    private var pinError = 0
    private var voice: String? = null
    var loadMs = 0L
        private set
    var copyMs = 0L
        private set

    /** The ids Stop was sent for, from another thread: the speaking callback sees it at the next piece of sound. */
    val stopped: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    @Volatile private var playing: Pair<String, VoicePlayer>? = null

    /** Stop for one answer or bench, from any thread: the sound stops at once, the model at its next piece. */
    fun stop(id: String) {
        stopped.add(id)
        playing?.let { (pid, p) -> if (pid == id) p.stop() }
    }

    /** Threads and cores, fixed for the life of this process: the model's worker pool is built once. */
    fun open(threadsAsked: Int) {
        if (handle != 0L) {
            check(threadsAsked == threads) { "the voice runs on $threads threads in this process" }
            return
        }
        PttsNative.load()
        val big = VoiceRules.bigCores(cpuMaxFreqs())
        val cores = Runtime.getRuntime().availableProcessors()
        threads = VoiceRules.threads(threadsAsked, cores, big)
        // Read by the runtime when it builds its worker pool (xn get_num_threads).
        Os.setenv("RAYON_NUM_THREADS", threads.toString(), true)
        // The fast cores, when the threads fit on them. The system may refuse (pinError, an errno): the
        // process's cpuset may leave them out. Then the threads go wherever the system puts them.
        val want = VoiceRules.pinFor(threads, big)
        pinError = want?.let { PttsNative.pin(it) } ?: 0
        pinned = want?.takeIf { pinError == 0 }
        val dir = modelDir()
        val t0 = SystemClock.elapsedRealtime()
        handle = PttsNative.open(VoiceRules.textBytes(dir.path), VoiceRules.textBytes("en"))
        loadMs = SystemClock.elapsedRealtime() - t0
    }

    fun info(): Bundle = Bundle().apply {
        putInt("threads", threads)
        putIntArray("pinned", pinned ?: IntArray(0))
        putInt("pinError", pinError)
        putLong("loadMs", loadMs)
        putLong("copyMs", copyMs)
    }

    private fun useVoice(name: String?) {
        val v = name?.takeIf { it.isNotBlank() } ?: return
        if (v == voice) return
        PttsNative.setVoice(handle, VoiceRules.textBytes(v))
        voice = v
    }

    /** One answer, read aloud. events gets started, buffering {fraction}, then end or error. */
    fun speak(job: Bundle, events: (String, Bundle) -> Unit) {
        val id = job.getString("id") ?: ""
        val pieces = job.getStringArrayList("pieces") ?: arrayListOf()
        val kept = job.getDouble("rtf", -1.0).takeIf { it > 0 }
        val spc = job.getDouble("spc", -1.0).takeIf { it > 0 }
        val pacer = VoicePace.Pacer(pieces.map { it.length }, kept, spc, job.getBoolean("preferNatural"), job.getBoolean("phoneVoice"))
        val player = VoicePlayer()
        playing = id to player
        val t0 = SystemClock.elapsedRealtime().toDouble()
        var firstMs = -1.0
        var audioS = 0.0
        var tooSlow: Double? = null
        var waitMs = -1.0
        var lastFraction = -1.0
        var error: Throwable? = null
        val play = job.getBoolean("play", true)
        fun step(s: VoicePace.Step) {
            if (s.fallback) tooSlow = s.rtf
            if (s.start) {
                if (play) player.begin()
                waitMs = SystemClock.elapsedRealtime() - t0
                events("started", Bundle().apply { putString("id", id); putDouble("waitMs", waitMs) })
            } else if (!pacer.started && s.fraction - lastFraction >= 0.05) {
                lastFraction = s.fraction
                events("buffering", Bundle().apply { putString("id", id); putDouble("fraction", s.fraction) })
            }
        }
        try {
            useVoice(job.getString("voice"))
            for (text in pieces) {
                if (id in stopped || tooSlow != null) break
                val p0 = SystemClock.elapsedRealtime()
                var pieceS = 0.0
                PttsNative.speak(handle, VoiceRules.textBytes(text), { pcm ->
                    if (id in stopped) return@speak false
                    val s = pcm.size.toDouble() / VoiceRules.SAMPLE_RATE
                    if (firstMs < 0) firstMs = SystemClock.elapsedRealtime() - t0
                    pieceS += s
                    audioS += s
                    if (play) player.push(pcm)
                    step(pacer.audio(s, SystemClock.elapsedRealtime().toDouble()))
                    tooSlow == null
                }, DoubleArray(4))
                step(pacer.pieceDone(pieceS, (SystemClock.elapsedRealtime() - p0).toDouble(), SystemClock.elapsedRealtime().toDouble()))
            }
            if (tooSlow == null && id !in stopped) step(pacer.finish())
        } catch (t: Throwable) {
            error = t
        }
        val wasStopped = stopped.remove(id)
        if (wasStopped || tooSlow != null || error != null) player.stop() else {
            player.end()
            player.await((audioS * 1000).toLong() + 5000)
        }
        val genMs = SystemClock.elapsedRealtime() - t0
        val stats = Bundle().apply {
            putString("id", id)
            putDouble("firstMs", firstMs)
            putDouble("waitMs", waitMs)
            putDouble("audioS", audioS)
            putDouble("totalMs", genMs.toDouble())
            pacer.rtf()?.let { putDouble("rtf", it) }
            pacer.spc()?.let { putDouble("spc", it) }
            putInt("gaps", player.gaps)
            putInt("underruns", player.underruns())
            putInt("threads", threads)
            putBoolean("stopped", wasStopped)
        }
        playing = null
        player.release()
        when {
            error != null -> events("error", stats.apply { putString("code", "failed"); putString("message", error.message ?: error.toString()) })
            tooSlow != null -> events("error", stats.apply { putString("code", "too-slow"); putDouble("rtf", tooSlow!!); putString("message", "the natural voice is too slow on this phone for this answer") })
            else -> events("end", stats)
        }
    }

    /** Makes text without playing it: first-audio ms, audio seconds and generation ms. */
    fun bench(job: Bundle): Bundle {
        useVoice(job.getString("voice"))
        val text = job.getString("text") ?: ""
        val t0 = SystemClock.elapsedRealtime()
        var first = -1L
        var samples = 0L
        var chunks = 0
        var nan = 0
        var peak = 0f
        var clipped = 0
        val timings = DoubleArray(4)
        PttsNative.speak(handle, VoiceRules.textBytes(text), { pcm ->
            if (first < 0) first = SystemClock.elapsedRealtime() - t0
            samples += pcm.size
            chunks++
            for (x in pcm) {
                if (x.isNaN()) nan++ else {
                    val a = kotlin.math.abs(x)
                    if (a > peak) peak = a
                    if (a >= 0.99f) clipped++
                }
            }
            job.getString("id") !in stopped
        }, timings)
        val genMs = SystemClock.elapsedRealtime() - t0
        stopped.remove(job.getString("id") ?: "")
        val audioS = samples.toDouble() / VoiceRules.SAMPLE_RATE
        return Bundle().apply {
            putString("id", job.getString("id"))
            putDouble("firstMs", first.toDouble())
            putDouble("audioS", audioS)
            putDouble("genMs", genMs.toDouble())
            putDouble("rtf", if (audioS > 0) genMs / 1000.0 / audioS else -1.0)
            putDouble("libFirstMs", timings[2])
            putDouble("libTotalMs", timings[3])
            putInt("chunks", chunks)
            putLong("samples", samples)
            putInt("nan", nan)
            putInt("clipped", clipped)
            putDouble("peak", peak.toDouble())
            putAll(info())
        }
    }

    fun close() {
        if (handle != 0L) PttsNative.free(handle)
        handle = 0L
    }

    private fun cpuMaxFreqs(): List<Long?> {
        val n = Runtime.getRuntime().availableProcessors()
        return (0 until n).map { i ->
            try {
                File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").readText().trim().toLong()
            } catch (_: Exception) {
                null
            }
        }
    }

    /** The model as a checkpoint folder in no-backup storage, copied from the APK the first time. */
    private fun modelDir(): File {
        val index = JSONObject(ctx.assets.open("$ASSETS/index.json").bufferedReader().use { it.readText() })
        val model = index.getJSONObject("model")
        val sizes = HashMap<String, Long>()
        index.optJSONArray("files")?.let { a -> for (i in 0 until a.length()) a.getJSONObject(i).let { sizes[it.getString("path")] = it.optLong("size", -1) } }
        val voices = mutableListOf<VoiceRules.Voice>()
        for (key in listOf("voices", "labVoices")) {
            val a: JSONArray = index.optJSONArray(key) ?: continue
            for (i in 0 until a.length()) a.getJSONObject(i).let { voices += VoiceRules.Voice(it.getString("name"), it.getString("file"), it.optLong("size", -1)) }
        }
        val copies = VoiceRules.modelCopies(ASSETS, model.getString("weights"), model.getString("tokenizer"), model.getString("config"), voices, sizes)
        val root = ctx.noBackupFilesDir
        val name = VoiceRules.folderFor(model.getString("revision"))
        val dir = File(root, name)
        val marker = File(dir, ".complete")
        val want = copies.joinToString("\n") { "${it.path} ${it.size}" }
        if (marker.isFile && marker.readText() == want) return dir
        val t0 = SystemClock.elapsedRealtime()
        // Another revision's copy is of no use any more.
        root.listFiles()?.filter { it.name.startsWith("phonon-") && it.name != name }?.forEach { it.deleteRecursively() }
        val part = File(root, "$name.part")
        part.deleteRecursively()
        for (c in copies) {
            val to = File(part, c.path)
            to.parentFile?.mkdirs()
            ctx.assets.open(c.asset).use { input -> to.outputStream().use { input.copyTo(it, 1 shl 20) } }
            check(c.size < 0 || to.length() == c.size) { "${c.asset}: ${to.length()} bytes, the index says ${c.size}" }
        }
        File(part, ".complete").writeText(want)
        dir.deleteRecursively()
        check(part.renameTo(dir)) { "could not put the voice files in place" }
        copyMs = SystemClock.elapsedRealtime() - t0
        return dir
    }

    companion object {
        const val ASSETS = "public/v2/voice/phonon"
    }
}
