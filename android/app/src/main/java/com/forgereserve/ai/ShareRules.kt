package com.forgereserve.ai

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.SecureRandom
import java.util.Base64

/**
 * The rules for a photo another app shares into Forge. Plain Kotlin with no Android types, so the JVM
 * unit tests cover it (app/src/test).
 */
object ShareIntake {
    /** The largest photo taken in, as the web app's share target takes (public/v2/sw.js SHARE_MAX). */
    const val MAX_BYTES = 40 * 1024 * 1024

    const val ACTION_SEND = "android.intent.action.SEND"

    enum class Decision {
        /** Read the stream: it may be a photo. */
        TAKE,

        /** Not a share for Forge (the app was opened, or reopened from recent apps). */
        IGNORE,

        /** A share with no photo in it (text only, or another kind of file). */
        NO_PHOTO,
    }

    /**
     * What to do with an intent. fromHistory: the app was reopened from recent apps, which hands back the
     * old intent; a photo shared then was already taken once.
     */
    fun decide(action: String?, type: String?, hasStream: Boolean, fromHistory: Boolean): Decision {
        if (fromHistory || action != ACTION_SEND) return Decision.IGNORE
        if (!hasStream || type == null || !type.lowercase().startsWith("image/")) return Decision.NO_PHOTO
        return Decision.TAKE
    }

    /** Reads at most max bytes. null when the stream is longer: the photo is too big and is not kept. */
    fun readBounded(input: InputStream, max: Int = MAX_BYTES): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > max) return null
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /**
     * The image type from the file's first bytes, never from what the other app claims. Only the kinds
     * the web view can draw: JPEG, PNG, WebP and GIF. null for anything else.
     */
    fun sniff(b: ByteArray): String? {
        fun at(i: Int, vararg v: Int) = b.size >= i + v.size && v.indices.all { (b[i + it].toInt() and 0xff) == v[it] }
        return when {
            at(0, 0xff, 0xd8, 0xff) -> "image/jpeg"
            at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "image/png"
            at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
            at(0, 0x47, 0x49, 0x46, 0x38) -> "image/gif"
            else -> null
        }
    }

    fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
}

/** The rules for a file Forge shares out or saves (Share unseen hands over the protected photo only). */
object ShareOut {
    /** Files to share live here, inside the app's cache, and are removed on the next share and at start. */
    const val DIR = "shared-out"

    const val MAX_BYTES = 40 * 1024 * 1024

    private val EXT = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp")

    /** The type, if it is one Forge shares out. */
    fun mime(m: String?): String? = m?.lowercase()?.trim()?.takeIf { it in EXT }

    /**
     * A file name that is safe on any app's side: letters, digits, dot, dash and underscore, no path, at
     * most 60 characters, ending in the extension of its type.
     */
    fun safeName(name: String?, mime: String): String {
        val ext = EXT[mime] ?: "bin"
        val base = (name ?: "")
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .substringBeforeLast('.')
            .replace(Regex("[^A-Za-z0-9_-]+"), "-")
            .trim('-', '.', '_')
            .take(60)
        return "${base.ifEmpty { "forge-photo" }}.$ext"
    }

    /** Decodes base64 the page sends (a piece of a staged file). null when it is not base64 or is over max bytes. */
    fun decode(data: String?, max: Int = MAX_BYTES): ByteArray? {
        if (data.isNullOrEmpty() || data.length > (max / 3 + 1) * 4) return null
        return try {
            Base64.getDecoder().decode(data).takeIf { it.isNotEmpty() && it.size <= max }
        } catch (e: IllegalArgumentException) {
            null
        }
    }
}

/** Why a staged file was refused; code is the one the page gets (call.reject). */
class StageError(val code: String, message: String) : Exception(message)

/**
 * The file the page hands to Share or Save, staged in the app's cache first (SharePlugin.kt). The call
 * that opens the save screen is kept by Capacitor in the app's saved state while that screen is up, and
 * Android refuses saved state over about 1 MB (a full size photo as base64 in that call stopped the app).
 * So the page sends the file in pieces through calls that open nothing, and Share or Save then carries
 * only a token, the name and the type.
 *
 * Plain Kotlin with no Android types, so the JVM unit tests cover it. The staged files are inside the
 * app's cache, outside the folder the share sheet's FileProvider may hand out (ShareOut.DIR), so no
 * other app can read them. SharePlugin touches them from one thread only.
 */
class ShareStage(private val dir: File, private val random: SecureRandom = SecureRandom()) {
    companion object {
        const val DIR = "share-staged"

        /**
         * The most bytes one piece carries: 192 KiB, a multiple of 3, so each piece is whole base64 on its
         * own (exactly 256 KiB of text). A full size photo of 5 MB is about 27 pieces. Small enough that no
         * bridge message is large and the phone holds little extra memory at once; large enough that the
         * number of calls stays small.
         */
        const val CHUNK_BYTES = 192 * 1024

        /**
         * The longest a Share or Save call's options may be, as JSON: Capacitor writes the options of the
         * call that opened the save screen into the app's saved state, twice. A token, a name of at most a
         * few hundred letters and a type fit in far less.
         */
        const val MAX_CALL_CHARS = 2048

        private val TOKEN = Regex("^[0-9a-f]{32}$")

        /** The token, when it is one this class makes (32 lowercase hex digits), else null. */
        fun token(s: String?): String? = s?.takeIf { TOKEN.matches(it) }
    }

    /** token -> the size the page said the file has. Only files still being staged are here. */
    private val sizes = HashMap<String, Long>()

    private fun fileOf(token: String) = File(dir, token)

    /**
     * Starts a file of size bytes and returns its token. Every other staged file goes first, except keep
     * (the file of a save whose save screen is still up), so at most two are ever on disk.
     */
    fun start(size: Long, keep: String? = null): String {
        if (size <= 0) throw StageError("bad_file", "The file is empty.")
        if (size > ShareOut.MAX_BYTES) throw StageError("too_big", "The file is too large.")
        sweep(keep)
        dir.mkdirs()
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        val token = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        fileOf(token).writeBytes(ByteArray(0))
        sizes[token] = size
        return token
    }

    /** Adds the next piece (base64, at most CHUNK_BYTES once decoded). Returns the bytes staged so far. */
    fun append(token: String?, data: String?): Long {
        val t = token(token)
        val size = t?.let { sizes[it] }
        val file = t?.let { fileOf(it) }
        if (size == null || file == null || !file.isFile) throw StageError("no_file", "The file is not staged.")
        val bytes = ShareOut.decode(data, CHUNK_BYTES)
        if (bytes == null) {
            drop(t)
            throw StageError("bad_file", "The file could not be read.")
        }
        val total = file.length() + bytes.size
        if (total > size) {
            drop(t)
            throw StageError("bad_file", "The file is longer than it said.")
        }
        FileOutputStream(file, true).use { it.write(bytes) }
        return total
    }

    /**
     * The staged file, once all of it came: it is then no longer open for pieces, and stays on disk until
     * drop. A file that is missing or short is dropped and refused.
     */
    fun take(token: String?): File {
        val t = token(token) ?: throw StageError("no_file", "The file is not staged.")
        val size = sizes.remove(t)
        val file = fileOf(t)
        if (size == null || !file.isFile) {
            file.delete()
            throw StageError("no_file", "The file is not staged.")
        }
        if (file.length() != size) {
            file.delete()
            throw StageError("bad_file", "Not all of the file came.")
        }
        return file
    }

    /** The file a save screen was opened for, if it is still there (after Android restarted the app). */
    fun taken(token: String?): File? = token(token)?.let { fileOf(it) }?.takeIf { it.isFile }

    fun drop(token: String?) {
        val t = token(token) ?: return
        sizes.remove(t)
        fileOf(t).delete()
    }

    /** Removes every staged file except keep's. */
    fun sweep(keep: String? = null) {
        val k = token(keep)
        sizes.keys.retainAll { it == k }
        dir.listFiles()?.forEach { if (it.name != k) it.deleteRecursively() }
    }
}

/** The web view's back button: back through the app's screens, then out of the app. */
object BackRule {
    enum class Step { WEB_BACK, LEAVE }

    fun step(canGoBack: Boolean): Step = if (canGoBack) Step.WEB_BACK else Step.LEAVE
}
