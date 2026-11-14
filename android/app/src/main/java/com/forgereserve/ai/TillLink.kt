package com.forgereserve.ai

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** The till answered the card link's upgrade with [status] instead of 101 (401: the token is refused). */
class LinkRefused(val status: Int?) : IOException("the till refused the card link: HTTP $status")

/**
 * The card link (fedimintcard-pay docs/POS-LINK.md): while a tap is in progress this phone holds a
 * WebSocket open to the till, and the till sends the card's commands down it. Each command goes to
 * [onApdu] (the page, which asks the card and calls [answer]); the till closes the link after the job.
 * Made after the link in fedimintcard-pay's android-relay (TillLink.kt, MIT). Nothing that passes
 * through here is logged or stored.
 */
class TillLink private constructor(private val socket: Socket, private val writeFrame: (Int, ByteArray) -> Unit) : Closeable {
    @Volatile var id: String = ""
        private set

    @Volatile var closed = false
        private set

    /** Sends the page's answer to a command, already checked by TillRules.answerFrame. */
    fun answer(frame: String) {
        if (closed) return
        try { writeFrame(Ws.TEXT, frame.toByteArray(Charsets.UTF_8)) } catch (_: IOException) {}
    }

    override fun close() {
        if (closed) return
        closed = true
        try { writeFrame(Ws.CLOSE, ByteArray(0)) } catch (_: Exception) {}
        try { socket.close() } catch (_: Exception) {}
    }

    companion object {
        /**
         * Opens a link to the till at [baseUrl] with the pay token as the bearer, and waits for the
         * till's `ready`. A reader thread then hands each command to [onApdu] until the link ends, then
         * calls [onClosed]. Throws IOException when it cannot ([LinkRefused] for an answer but 101).
         */
        @Throws(IOException::class)
        fun open(baseUrl: String, token: String, onApdu: (Long, String) -> Unit, onClosed: () -> Unit): TillLink {
            val t = TillRules.linkTarget(baseUrl)
            val s = if (t.tls) SSLSocketFactory.getDefault().createSocket() else Socket()
            try {
                s.connect(InetSocketAddress(t.host, t.port), TillRules.CONNECT_MS)
                if (s is SSLSocket) {
                    // A bare SSLSocket checks the chain but not the name: ask for the HTTPS name check
                    // (and send SNI, which a proxy routes on) before any byte is written.
                    val p = s.sslParameters
                    p.endpointIdentificationAlgorithm = "HTTPS"
                    if (!isIpLiteral(t.host)) p.serverNames = listOf(SNIHostName(t.host))
                    s.sslParameters = p
                    s.soTimeout = TillRules.CONNECT_MS
                    s.startHandshake()
                }
                s.soTimeout = TillRules.CONNECT_MS
                s.tcpNoDelay = true
                val out = s.getOutputStream()
                val input = s.getInputStream().buffered()
                val key = Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
                val req = "GET ${t.path} HTTP/1.1\r\nHost: ${t.hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer $token\r\n\r\n"
                out.write(req.toByteArray(Charsets.ISO_8859_1))
                out.flush()
                val head = readHead(input, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(TillRules.CONNECT_MS.toLong()))
                val status = head.firstOrNull()?.split(" ")?.getOrNull(1)?.toIntOrNull()
                if (status != 101) throw LinkRefused(status)
                val accept = head.drop(1).firstOrNull { it.lowercase().startsWith("sec-websocket-accept:") }?.substringAfter(':')?.trim()
                if (accept != Ws.accept(key)) throw IOException("bad WebSocket handshake")
                // Open: from here the till may take its time over each command of the job.
                s.soTimeout = TillRules.LINK_READ_MS
                val rng = SecureRandom()
                val lock = Any()
                val writer: (Int, ByteArray) -> Unit = { op, p -> synchronized(lock) { Ws.write(out, op, p, ByteArray(4).also { rng.nextBytes(it) }) } }
                val link = TillLink(s, writer)
                val ready = CountDownLatch(1)
                val reader = Thread({
                    try {
                        while (true) {
                            val f = Ws.read(input)
                            when (f.opcode) {
                                Ws.TEXT -> when (val m = TillRules.readFrame(String(f.payload, Charsets.UTF_8))) {
                                    is TillRules.Incoming.Ready -> { link.id = m.link; ready.countDown() }
                                    is TillRules.Incoming.Apdu -> onApdu(m.id, m.apdu)
                                    else -> {}
                                }
                                Ws.PING -> writer(Ws.PONG, f.payload)
                                Ws.CLOSE -> break
                            }
                        }
                    } catch (_: Exception) {
                    } finally {
                        link.close()
                        ready.countDown()
                        onClosed()
                    }
                }, "till-link")
                reader.isDaemon = true
                reader.start()
                if (!ready.await(TillRules.CONNECT_MS.toLong(), TimeUnit.MILLISECONDS) || link.id.isEmpty()) {
                    link.close()
                    throw IOException("no ready from the till")
                }
                return link
            } catch (e: Exception) {
                try { s.close() } catch (_: Exception) {}
                throw e as? IOException ?: IOException(e.message, e)
            }
        }

        private fun isIpLiteral(host: String) = host.contains(':') || host.all { it.isDigit() || it == '.' }

        /** The upgrade's answer, up to its blank line, within [deadline] (System.nanoTime) for all of it. */
        private fun readHead(input: InputStream, deadline: Long): List<String> {
            val head = ByteArrayOutputStream()
            var tail = 0
            while (true) {
                if (System.nanoTime() - deadline > 0) throw SocketTimeoutException("the till did not answer the card link in time")
                val b = input.read()
                if (b < 0) throw EOFException("the till closed during the handshake")
                head.write(b)
                tail = (tail shl 8) or b
                if (tail == 0x0D0A0D0A) break
                if (head.size() > 8192) throw IOException("handshake headers too large")
            }
            return head.toString(Charsets.ISO_8859_1.name()).split("\r\n").filter { it.isNotEmpty() }
        }
    }
}
