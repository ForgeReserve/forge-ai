package com.forgereserve.ai

import kotlin.math.max
import kotlin.math.min

/**
 * The native natural voice's rules that need no phone (docs/VOICE.md, Native voice in the Android
 * app): whether this processor can run the library, how many threads and which cores, and where the
 * model's files go. JVM tested (VoiceRulesTest).
 */
object VoiceRules {
    const val SAMPLE_RATE = 24000

    /**
     * Whether every core has the instructions libptts_ffi.so was built for (scripts/android-ptts.sh):
     * the int8 dot product (`asimddp`) and half-precision arithmetic (`fphp`, `asimdhp`), ARMv8.2. The
     * library would crash on a processor without them, so it is never loaded there. cpuinfo is
     * /proc/cpuinfo; every "Features" line must have all three (a phone may mix core types).
     */
    fun cpuOk(cpuinfo: String): Boolean {
        val lines = cpuinfo.lineSequence().filter { it.trimStart().startsWith("Features") }.toList()
        if (lines.isEmpty()) return false
        val need = setOf("asimddp", "fphp", "asimdhp")
        return lines.all { line -> line.substringAfter(':', "").trim().split(Regex("\\s+")).toSet().containsAll(need) }
    }

    /**
     * The fast cores: those whose highest clock is the highest of all (cpufreq's cpuinfo_max_freq, one
     * per core, null where unknown). Empty when nothing is known or every core is the same.
     */
    fun bigCores(maxFreqs: List<Long?>): List<Int> {
        val known = maxFreqs.filterNotNull()
        if (known.isEmpty()) return emptyList()
        val top = known.max()
        val big = maxFreqs.indices.filter { maxFreqs[it] == top }
        return if (big.size == maxFreqs.size || known.size < maxFreqs.size) emptyList() else big
    }

    /**
     * The threads the app reads with when nobody chose: as many as there are fast cores when the
     * phone mixes fast and slow ones, never fewer than 2 or more than 4; 4 on a phone of one kind.
     * Measured on the Galaxy A16 (2 fast, 6 slow): see docs/VOICE.md.
     */
    fun defaultThreads(cores: Int, big: List<Int>): Int {
        val n = if (big.isEmpty()) 4 else big.size
        return min(max(2, n), max(1, min(4, cores)))
    }

    /** A thread count asked for, kept to 1..cores; 0 or less is the default. */
    fun threads(asked: Int?, cores: Int, big: List<Int>): Int =
        if (asked == null || asked <= 0) defaultThreads(cores, big) else min(asked, max(1, cores))

    /**
     * The cores to keep the voice on, or null for wherever the system puts it: the fast cores when
     * the threads fit on them, so a slow core never holds the others back at each step.
     */
    fun pinFor(threads: Int, big: List<Int>): IntArray? =
        if (big.isNotEmpty() && threads <= big.size) big.toIntArray() else null

    /** A model folder as ptts_new reads it: what to copy from the APK's assets, and where to. */
    data class Copy(val asset: String, val path: String, val size: Long)

    /** A voice by name, its file under the voice folder, and its size. */
    data class Voice(val name: String, val file: String, val size: Long)

    private val SAFE_PATH = Regex("^[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$")
    private val SAFE_NAME = Regex("^[\\p{L}\\p{N} ._-]{1,40}$")

    /**
     * The copies that lay out the bundled model (public/v2/voice/phonon/, index.json) as a checkpoint
     * folder: config.json, tokenizer.json, model.q8.gguf and voices/<name>.safetensors. sizes gives
     * each file's size by its index path (the index's `files`). Throws on a path or name that is not
     * plain, so nothing is written outside the folder.
     */
    fun modelCopies(base: String, weights: String, tokenizer: String, config: String, voices: List<Voice>, sizes: Map<String, Long>): List<Copy> {
        fun at(p: String): String {
            require(SAFE_PATH.matches(p)) { "bad model path $p" }
            return "$base/$p"
        }
        val out = mutableListOf(
            Copy(at(config), "config.json", sizes[config] ?: -1),
            Copy(at(tokenizer), "tokenizer.json", sizes[tokenizer] ?: -1),
            Copy(at(weights), "model.q8.gguf", sizes[weights] ?: -1),
        )
        val seen = mutableSetOf<String>()
        for (v in voices) {
            require(SAFE_NAME.matches(v.name) && v.name.trim() == v.name && !v.name.startsWith(".")) { "bad voice name ${v.name}" }
            require(seen.add(v.name.lowercase())) { "voice ${v.name} twice" }
            out += Copy(at(v.file), "voices/${v.name}.safetensors", v.size)
        }
        return out
    }

    /** The folder's name for one model revision: its first 12 hex digits. */
    fun folderFor(revision: String): String {
        require(Regex("^[0-9a-f]{12,64}$").matches(revision)) { "bad revision $revision" }
        return "phonon-${revision.take(12)}"
    }

    /** Whether the app was installed with its 64-bit ARM libraries: its native library folder is lib/arm64. */
    fun arm64Libs(nativeLibraryDir: String?): Boolean = nativeLibraryDir?.trimEnd('/')?.endsWith("/arm64") == true

    /** A voice lab result's file name, as the lab makes them: forge-voice-lab-<time>.json. */
    fun labName(name: String): Boolean = Regex("^forge-voice-lab-[0-9A-Za-z-]{1,60}\\.json$").matches(name)

    /** Text as the library reads it: UTF-8, with no NUL (it would end the C string early). */
    fun textBytes(text: String): ByteArray = text.replace('\u0000', ' ').encodeToByteArray()
}

/**
 * The voice lab run a debug build takes from adb (MainActivity): "native:10", "native-2,native-4:3",
 * and ":play" at the end to play each line through the speaker rather than only make it.
 */
object LabAuto {
    private val SPEC = Regex("^([a-z0-9-]{1,40}(?:,[a-z0-9-]{1,40}){0,9}):([0-9]{1,2})(:play)?$")

    /** The script that starts it in the page, or null when the extra is missing or not of that form. */
    fun script(extra: String?): String? {
        val m = SPEC.matchEntire(extra?.trim() ?: return null) ?: return null
        val names = m.groupValues[1].split(",")
        val candidates = if (names == listOf("native")) "'native'" else names.joinToString(",", "[", "]") { "'$it'" }
        // Once the app has started (its first run may change the route), and afresh when the lab is open.
        return "window.__forgeLabAuto={candidates:$candidates,lines:${m.groupValues[2].toInt()},play:${m.groupValues[3].isNotEmpty()}};" +
            "if(location.hash==='#/voice-lab')location.hash='#/';setTimeout(function(){location.hash='#/voice-lab';},1500);"
    }
}
