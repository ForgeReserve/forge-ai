package com.forgereserve.ai

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * The rules of Forge Private Voice's speech to text (ForgeAsr: AsrPlugin, AsrService; docs/VOICE.md,
 * Bundled speech to text) that need no phone: whether it can run here, the sound it hears, when live
 * words are worked out again, and when the model is let go. JVM tested (AsrRulesTest).
 */
object AsrRules {
    /** The model hears 16 kHz mono. */
    const val RATE = 16000

    /** The microphone is read 100 ms at a time. */
    const val CHUNK = RATE / 10

    /** Live words: the recording so far is heard again every 500 ms of new sound (the ASR lab's :s500). */
    const val STEP = RATE / 2

    /** The page stops at 60 s (forge.voice-in.bundled maxSeconds); the plugin stops itself at 90 s. */
    const val MAX_SECONDS = 90

    /** Under 0.3 s there is nothing to hear (a tap): no words, and the model is not run. */
    const val MIN_SAMPLES = RATE * 3 / 10

    /** The words wait this long after the button is let go before what was heard so far is the question. */
    const val FINISH_MS = 5_000L

    /** The model is let go (its process ended) when the app has been in the background this long... */
    const val RELEASE_BACKGROUND_MS = 60_000L

    /** ...or when nothing was heard for this long with the app open. */
    const val RELEASE_IDLE_MS = 5 * 60_000L

    /**
     * Why this APK cannot hear on this phone, or null when it can: the model is bundled only in Forge
     * Private Voice (bundled), the library is arm64 only (installed with lib/arm64, VoiceRules.arm64Libs,
     * and the file there), the model's files must be in the APK, and a crash or failed load earlier this
     * session (broken) keeps it off until the app starts again.
     */
    fun unavailable(bundled: Boolean, arm64: Boolean, libThere: Boolean, modelThere: Boolean, broken: String?): String? = when {
        !bundled -> "no speech to text in this app"
        !arm64 || !libThere -> "not a 64-bit ARM phone"
        !modelThere -> "the speech to text files are not in this app"
        broken != null -> broken
        else -> null
    }

    /** 16-bit microphone samples as floats in -1..1. */
    fun floats(pcm: ShortArray, n: Int = pcm.size): FloatArray = FloatArray(n) { pcm[it] / 32768f }

    /** The sound's level for the talk button's bars, 0 to 1, as the web microphone's (core/wav.js level). */
    fun level(samples: FloatArray): Double {
        if (samples.isEmpty()) return 0.0
        var sum = 0.0
        for (s in samples) sum += s * s
        val rms = sqrt(sum / samples.size)
        return (rms * 4).coerceIn(0.0, 1.0)
    }

    /**
     * Whether to hear the recording again for live words: not while a pass runs, and only after a step
     * of new sound (step, from stepAfter).
     */
    fun partialDue(samples: Int, lastRun: Int, busy: Boolean, step: Int = STEP): Boolean = !busy && samples >= MIN_SAMPLES && samples - lastRun >= step

    /**
     * The new sound to wait for (counted from the start of the last pass) before the next live-words
     * pass, after one that took passMs: 500 ms, or twice the pass when that is longer, so live words keep
     * the processor busy at most about half the time as the recording grows (a 15 s request takes about
     * 0.7 s a pass on the Galaxy A16) and a pass running when the button is let go is a shorter wait.
     */
    fun stepAfter(passMs: Double): Int = maxOf(STEP, (2 * passMs * RATE / 1000).toInt())

    /** The model's words as the page shows them: spaces collapsed, nothing at the ends. */
    fun clean(text: String): String = text.replace(Regex("\\s+"), " ").trim()

    /** The recording so far: grows as the microphone fills, up to MAX_SECONDS; what comes after is dropped. */
    class Recording(private val max: Int = RATE * MAX_SECONDS) {
        private var buf = FloatArray(RATE * 5)
        var size = 0
            private set

        /** Adds samples; false once the recording is full (the rest is dropped). */
        @Synchronized
        fun add(samples: FloatArray): Boolean {
            val room = max - size
            if (room <= 0) return false
            val n = minOf(room, samples.size)
            if (size + n > buf.size) buf = buf.copyOf(minOf(max, maxOf(size + n, buf.size * 2)))
            System.arraycopy(samples, 0, buf, size, n)
            size += n
            return n == samples.size
        }

        /** A copy of the recording so far (the model takes a whole array). */
        @Synchronized
        fun snapshot(): FloatArray = buf.copyOf(size)
    }

    /** A test clip's name in the app's files (files/asr-check/), as a debug build takes it from adb. */
    fun checkName(name: String?): Boolean = name != null && Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.wav$").matches(name)

    /** 16 kHz mono 16-bit PCM WAV as floats in -1..1 (debug check clips); throws on anything else. */
    fun wav(bytes: ByteArray): FloatArray {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(bytes.size >= 12 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") { "not a WAV file" }
        var at = 12
        var fmtOk = false
        while (at + 8 <= bytes.size) {
            val id = String(bytes, at, 4)
            val len = b.getInt(at + 4)
            require(len >= 0 && at + 8 + len <= bytes.size) { "bad WAV chunk $id" }
            if (id == "fmt ") {
                val format = b.getShort(at + 8).toInt()
                val channels = b.getShort(at + 10).toInt()
                val rate = b.getInt(at + 12)
                val bits = b.getShort(at + 22).toInt()
                require(format == 1 && channels == 1 && rate == RATE && bits == 16) { "want 16 kHz mono 16-bit PCM, got format $format, $channels channels, $rate Hz, $bits bits" }
                fmtOk = true
            } else if (id == "data") {
                require(fmtOk) { "WAV data before its format" }
                val n = len / 2
                return FloatArray(n) { b.getShort(at + 8 + it * 2) / 32768f }
            }
            at += 8 + len + (len and 1)
        }
        throw IllegalArgumentException("no WAV data")
    }
}

/** A speech to text model the voice process holds: hears a whole recording at once. */
interface AsrRecognizer {
    fun transcribe(samples: FloatArray): String

    fun close()
}
