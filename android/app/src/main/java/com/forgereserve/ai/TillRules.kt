package com.forgereserve.ai

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest
import java.util.Base64

/**
 * The rules for talking to a till (slice A14, TillPlugin): what a pairing code is, which requests the
 * page may send with the till's pay token, and the card link's frames. Plain Kotlin with no Android
 * types, so the JVM unit tests cover it (app/src/test). The till is fedimintcard's
 * `till serve --pay-enabled`; its routes are in fedimintcard-pay docs/PAY.md, POS-LINK.md and
 * TILL-API.md.
 */
object TillRules {
    const val PAY_SCHEME = "fedimintcard-till-pay:"
    const val POS_SCHEME = "fedimintcard-till:"

    /** The till waits up to 10 s for each card answer and ends a link after 120 s. */
    const val LINK_READ_MS = 130_000
    const val CONNECT_MS = 10_000

    /** The longest a request may wait: POST /v1/pay can take 120 s at the till. */
    const val MAX_REQUEST_MS = 150_000
    const val MIN_REQUEST_MS = 5_000

    /** The largest answer the page is given (a pay record is well under 4 KB). */
    const val MAX_BODY = 64 * 1024

    /** A till this phone pays through: where it is, and the pay token it wants as a bearer. */
    data class Pairing(val url: String, val token: String) {
        override fun toString() = "Pairing(url=$url, token=<hidden>)" // never log the token
    }

    /** Why a scanned code is not a pairing code. */
    enum class Refusal { POS, INSECURE, INVALID }

    sealed class Parsed {
        data class Ok(val pairing: Pairing) : Parsed()
        data class No(val why: Refusal) : Parsed()
    }

    private val LOOPBACK = Regex("^(localhost|127(\\.\\d{1,3}){3}|::1|\\[::1])$", RegexOption.IGNORE_CASE)
    private val TOKEN = Regex("^[0-9a-fA-F]{64}$")
    private val PAY_ID = Regex("^[0-9]{1,19}$")
    private val LINK_ID = Regex("^[0-9a-f]{16}$")
    private val HEX = Regex("^([0-9a-fA-F]{2})+$")

    /**
     * Reads `fedimintcard-till-pay:<url>?t=<64 hex>`, the text `till pair --scope pay` puts in its QR
     * code. A till's own POS code is refused (its token opens the whole till), and so is plain http to
     * another computer: the PIN and the token would cross the network in clear.
     */
    fun parsePairing(input: String?): Parsed {
        val s = input?.trim() ?: return Parsed.No(Refusal.INVALID)
        val lower = s.lowercase()
        if (lower.startsWith(POS_SCHEME) && !lower.startsWith(PAY_SCHEME)) return Parsed.No(Refusal.POS)
        if (!lower.startsWith(PAY_SCHEME)) return Parsed.No(Refusal.INVALID)
        val rest = s.substring(PAY_SCHEME.length)
        val q = rest.lastIndexOf("?t=")
        if (q < 0) return Parsed.No(Refusal.INVALID)
        val token = rest.substring(q + 3)
        if (!TOKEN.matches(token)) return Parsed.No(Refusal.INVALID)
        return when (val u = tillUrl(rest.substring(0, q))) {
            is Url.Ok -> Parsed.Ok(Pairing(u.value, token.lowercase()))
            is Url.No -> Parsed.No(u.why)
        }
    }

    sealed class Url {
        data class Ok(val value: String) : Url()
        data class No(val why: Refusal) : Url()
    }

    /** https://host[:port], or http to this phone itself; nothing else. Without a trailing slash. */
    fun tillUrl(input: String): Url {
        val s = input.trim()
        if (!Regex("^https?://[^/?#\\s]+/?$", RegexOption.IGNORE_CASE).matches(s)) return Url.No(Refusal.INVALID)
        val u = try { URI(s) } catch (e: Exception) { return Url.No(Refusal.INVALID) }
        val scheme = u.scheme?.lowercase() ?: return Url.No(Refusal.INVALID)
        val host = u.host?.takeIf { it.isNotEmpty() } ?: return Url.No(Refusal.INVALID)
        if (u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return Url.No(Refusal.INVALID)
        if (scheme == "http" && !LOOPBACK.matches(host)) return Url.No(Refusal.INSECURE)
        val port = if (u.port > 0) ":${u.port}" else ""
        return Url.Ok("$scheme://${host.lowercase()}$port")
    }

    /**
     * The requests the page may send with the pay token, and nothing else, so the token can never be
     * turned to another use: POST /v1/pay, GET /v1/pay/{id}?client_ref=..., POST /v1/pay/{id}/refund
     * and GET /v1/health. The pay token opens no more than these at the till either.
     */
    fun allowed(method: String?, path: String?): Boolean {
        if (method == null || path == null) return false
        val q = path.indexOf('?')
        val p = if (q < 0) path else path.substring(0, q)
        val query = if (q < 0) null else path.substring(q + 1)
        if (!p.startsWith("/v1/")) return false
        val parts = p.removePrefix("/v1/").split('/')
        return when {
            method == "POST" && parts == listOf("pay") && query == null -> true
            method == "GET" && parts == listOf("health") && query == null -> true
            method == "GET" && parts.size == 2 && parts[0] == "pay" && PAY_ID.matches(parts[1]) ->
                query != null && Regex("^client_ref=[A-Za-z0-9%._~-]{1,400}$").matches(query)
            method == "POST" && parts.size == 3 && parts[0] == "pay" && PAY_ID.matches(parts[1]) && parts[2] == "refund" && query == null -> true
            else -> false
        }
    }

    /** A card link id as the till makes it: 16 hex characters. */
    fun linkId(id: String?): Boolean = id != null && LINK_ID.matches(id)

    /** How long a request may wait for the till, from what the page asked. */
    fun timeout(ms: Int?): Int = (ms ?: 20_000).coerceIn(MIN_REQUEST_MS, MAX_REQUEST_MS)

    // ------------------------------------------------------------------ the card link

    /**
     * Where the card link goes for a till at [baseUrl]: http to ws (plain TCP), https to wss (TLS,
     * the certificate checked against [host]). [hostHeader] carries the port only when it is not the
     * scheme's default, as a browser sends it.
     */
    data class LinkTarget(val host: String, val port: Int, val tls: Boolean, val path: String, val hostHeader: String)

    @Throws(IOException::class)
    fun linkTarget(baseUrl: String): LinkTarget {
        val u = try { URI(baseUrl.trimEnd('/') + "/v1/card/link") } catch (e: Exception) { throw IOException("bad till URL", e) }
        val tls = when (u.scheme) {
            "https" -> true
            "http" -> false
            else -> throw IOException("the till URL must be https://")
        }
        val host = u.host?.takeIf { it.isNotEmpty() } ?: throw IOException("the till URL has no host")
        val default = if (tls) 443 else 80
        val port = if (u.port > 0) u.port else default
        val hostHeader = if (port == default) host else "$host:$port"
        return LinkTarget(host.removePrefix("[").removeSuffix("]"), port, tls, u.rawPath, hostHeader)
    }

    /** A frame from the till, as far as the phone needs it. */
    sealed class Incoming {
        data class Ready(val link: String) : Incoming()
        data class Apdu(val id: Long, val apdu: String) : Incoming()
        object Other : Incoming()
    }

    /**
     * Reads one text frame from the till: `{"type":"ready","link":"<id>"}` or
     * `{"type":"apdu","id":<n>,"apdu":"<hex>"}` (POS-LINK.md). Anything else is ignored.
     */
    fun readFrame(text: String): Incoming {
        val type = stringField(text, "type") ?: return Incoming.Other
        return when (type) {
            "ready" -> stringField(text, "link")?.takeIf { linkId(it) }?.let { Incoming.Ready(it) } ?: Incoming.Other
            "apdu" -> {
                val id = Regex("\"id\"\\s*:\\s*(\\d{1,18})").find(text)?.groupValues?.get(1)?.toLongOrNull() ?: return Incoming.Other
                val apdu = stringField(text, "apdu")?.takeIf { HEX.matches(it) } ?: return Incoming.Other
                Incoming.Apdu(id, apdu.lowercase())
            }
            else -> Incoming.Other
        }
    }

    private fun stringField(text: String, name: String): String? =
        Regex("\"$name\"\\s*:\\s*\"([^\"\\\\]*)\"").find(text)?.groupValues?.get(1)

    /**
     * A whole number as the page gives it. The bridge hands a small number over as an Int and a large
     * one as a Long (PluginCall.getLong takes a Long alone, so it loses every command id), and a number
     * with nothing after the point may come as a Double. Null for anything else.
     */
    fun wholeNumber(value: Any?): Long? = when (value) {
        is Long -> value
        is Int -> value.toLong()
        is Double -> if (value.isFinite() && value == Math.floor(value) && Math.abs(value) <= 9007199254740992.0) value.toLong() else null
        else -> null
    }

    /**
     * The phone's answer to the till's command [id], from what the page gave: the card's answer as
     * hex (`rapdu`), or `lost` when the card left. Null when the page gave something else.
     */
    fun answerFrame(type: String?, id: Long?, rapdu: String?): String? {
        if (id == null || id < 0) return null
        return when (type) {
            "rapdu" -> if (rapdu != null && HEX.matches(rapdu) && rapdu.length >= 4) "{\"type\":\"rapdu\",\"id\":$id,\"rapdu\":\"${rapdu.lowercase()}\"}" else null
            "lost" -> "{\"type\":\"lost\",\"id\":$id}"
            else -> null
        }
    }
}

/** Just enough RFC 6455 for a client: masked frames out, text, close and ping in. */
object Ws {
    const val TEXT = 1
    const val CLOSE = 8
    const val PING = 9
    const val PONG = 10
    private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    private const val MAX_FRAME = 1 shl 20

    class Frame(val opcode: Int, val payload: ByteArray)

    /** The Sec-WebSocket-Accept a server must answer for [key]. */
    fun accept(key: String): String =
        Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.ISO_8859_1)))

    fun encode(opcode: Int, payload: ByteArray, mask: ByteArray?): ByteArray {
        val b = ByteArrayOutputStream()
        b.write(0x80 or opcode)
        val m = if (mask != null) 0x80 else 0
        when {
            payload.size < 126 -> b.write(m or payload.size)
            payload.size < 65536 -> { b.write(m or 126); b.write(payload.size shr 8); b.write(payload.size and 0xFF) }
            else -> { b.write(m or 127); for (i in 7 downTo 0) b.write(((payload.size.toLong() shr (8 * i)) and 0xFF).toInt()) }
        }
        if (mask != null) {
            b.write(mask)
            b.write(ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() })
        } else b.write(payload)
        return b.toByteArray()
    }

    fun write(out: OutputStream, opcode: Int, payload: ByteArray, mask: ByteArray?) {
        out.write(encode(opcode, payload, mask))
        out.flush()
    }

    private fun readFully(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r < 0) throw EOFException("socket closed")
            off += r
        }
        return buf
    }

    /** One message: continuation frames are joined; control frames come back on their own. */
    fun read(input: InputStream): Frame {
        var opcode = -1
        val data = ByteArrayOutputStream()
        while (true) {
            val h = readFully(input, 2)
            val fin = (h[0].toInt() and 0x80) != 0
            val op = h[0].toInt() and 0x0F
            val masked = (h[1].toInt() and 0x80) != 0
            var len = (h[1].toInt() and 0x7F).toLong()
            if (len == 126L) { val e = readFully(input, 2); len = ((e[0].toInt() and 0xFF) shl 8 or (e[1].toInt() and 0xFF)).toLong() }
            else if (len == 127L) { val e = readFully(input, 8); len = e.fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xFF) } }
            if (len > MAX_FRAME) throw IOException("frame too large")
            val mask = if (masked) readFully(input, 4) else null
            val p = readFully(input, len.toInt())
            if (mask != null) for (i in p.indices) p[i] = (p[i].toInt() xor mask[i % 4].toInt()).toByte()
            if (op >= 8) return Frame(op, p) // control frames are never fragmented
            if (op != 0) opcode = op
            data.write(p)
            if (fin) return Frame(opcode, data.toByteArray())
        }
    }
}
