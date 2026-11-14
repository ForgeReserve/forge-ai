package com.forgereserve.ai

import java.io.ByteArrayOutputStream
import java.io.InputStream
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

    /** Decodes the file the page sends. null when it is not base64 or is over max bytes. */
    fun decode(data: String?, max: Int = MAX_BYTES): ByteArray? {
        if (data.isNullOrEmpty() || data.length > (max / 3 + 1) * 4) return null
        return try {
            Base64.getDecoder().decode(data).takeIf { it.isNotEmpty() && it.size <= max }
        } catch (e: IllegalArgumentException) {
            null
        }
    }
}

/** The web view's back button: back through the app's screens, then out of the app. */
object BackRule {
    enum class Step { WEB_BACK, LEAVE }

    fun step(canGoBack: Boolean): Step = if (canGoBack) Step.WEB_BACK else Step.LEAVE
}
