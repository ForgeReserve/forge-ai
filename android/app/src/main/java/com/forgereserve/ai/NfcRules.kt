package com.forgereserve.ai

/**
 * The rules for the bytes that pass between the page and a card (NfcPlugin). Plain Kotlin with no
 * Android types, so the JVM unit tests cover it (app/src/test). The page builds every APDU itself
 * (public/v2/core/card/apdu.js); this side only checks that what it is asked to send is one well formed
 * short APDU, and hands back the card's whole answer, status word included.
 */
object NfcRules {
    /** How long one command may take on the card before the tap counts as lost (IsoDep.setTimeout). */
    const val TIMEOUT_MS = 5000

    /** The largest short APDU: header (4), Lc (1), 255 data bytes, Le (1). */
    const val MAX_APDU = 4 + 1 + 255 + 1

    /** Bytes from lowercase or uppercase hex, or null when it is not hex of whole bytes. */
    fun fromHex(hex: String?): ByteArray? {
        if (hex == null || hex.length % 2 != 0) return null
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(hex[i * 2], 16)
            val lo = Character.digit(hex[i * 2 + 1], 16)
            if (hi < 0 || lo < 0) return null
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(Character.forDigit(v shr 4, 16)).append(Character.forDigit(v and 0x0f, 16))
        }
        return sb.toString()
    }

    /**
     * The APDU to send, or null when it is not one well formed ISO 7816 short APDU: case 1 (header
     * only), case 2 (header and Le), case 3 (header, Lc and that many bytes) or case 4 (case 3 and Le).
     * An extended length or a length byte that does not match is refused before it reaches the card.
     */
    fun apdu(hex: String?): ByteArray? {
        val b = fromHex(hex) ?: return null
        if (b.size < 4 || b.size > MAX_APDU) return null
        if (b.size == 4 || b.size == 5) return b
        val lc = b[4].toInt() and 0xff
        if (lc == 0) return null
        return if (b.size == 5 + lc || b.size == 6 + lc) b else null
    }

    /** The card's answer as the page takes it, or null when it is too short to carry a status word. */
    fun answer(response: ByteArray?): String? = if (response == null || response.size < 2) null else toHex(response)
}
