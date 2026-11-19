package com.forgereserve.ai

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class TillRulesTest {
    private val token = "ab".repeat(32)

    private fun ok(text: String) = (TillRules.parsePairing(text) as TillRules.Parsed.Ok).pairing
    private fun no(text: String?) = (TillRules.parsePairing(text) as TillRules.Parsed.No).why

    @Test
    fun takesATillsPayCode() {
        assertEquals(TillRules.Pairing("https://till.example.org", token), ok("fedimintcard-till-pay:https://till.example.org?t=$token"))
        assertEquals(TillRules.Pairing("https://till.example.org:9877", token), ok("  fedimintcard-till-pay:https://Till.Example.org:9877/?t=${token.uppercase()} "))
        // A till on this phone itself (tests and adb), plain http.
        assertEquals("http://127.0.0.1:9877", ok("fedimintcard-till-pay:http://127.0.0.1:9877?t=$token").url)
    }

    @Test
    fun refusesAPosCodePlainHttpAndAnythingElse() {
        // A till's own POS code opens the whole till: never taken for the pairing code a paying app scans.
        assertEquals(TillRules.Refusal.POS, no("fedimintcard-till:http://192.168.1.5:9877?t=$token"))
        // The PIN and the token would cross the network in clear.
        assertEquals(TillRules.Refusal.INSECURE, no("fedimintcard-till-pay:http://192.168.1.5:9877?t=$token"))
        for (bad in listOf(
            null,
            "",
            "cashuBxyz",
            "fedimintcard-till-pay:https://till.example.org",
            "fedimintcard-till-pay:https://till.example.org?t=abc",
            "fedimintcard-till-pay:https://till.example.org?t=${"zz".repeat(32)}",
            "fedimintcard-till-pay:https://till.example.org/path?t=$token",
            "fedimintcard-till-pay:https://me@till.example.org?t=$token",
            "fedimintcard-till-pay:ftp://till.example.org?t=$token",
            "fedimintcard-till-pay:till.example.org?t=$token",
        )) assertEquals(bad, TillRules.Refusal.INVALID, no(bad))
    }

    @Test
    fun theTokenNeverShowsInAPairingsText() {
        assertFalse(ok("fedimintcard-till-pay:https://till.example.org?t=$token").toString().contains(token))
    }

    @Test
    fun sendsOnlyThePayRoutes() {
        assertTrue(TillRules.allowed("POST", "/v1/pay"))
        assertTrue(TillRules.allowed("GET", "/v1/health"))
        assertTrue(TillRules.allowed("GET", "/v1/pay/12?client_ref=0f8e2c1a-1b2c-4d5e-8f90-123456789abc"))
        assertTrue(TillRules.allowed("POST", "/v1/pay/12/refund"))
        // Every holder's pays, a charge, the card's balance, top-ups: never with this token.
        for ((m, p) in listOf(
            "GET" to "/v1/pays",
            "POST" to "/v1/charge",
            "POST" to "/v1/card/balance",
            "GET" to "/v1/status",
            "GET" to "/v1/pay/12",
            "GET" to "/v1/pay/x?client_ref=a",
            "GET" to "/v1/pay/12?client_ref=a&b=c",
            "DELETE" to "/v1/pay",
            "POST" to "/v1/pay?x=1",
            "POST" to "/v1/pay/12/refund/../../charge",
            "GET" to "/v1/card/link",
        )) assertFalse("$m $p", TillRules.allowed(m, p))
        assertFalse(TillRules.allowed(null, "/v1/pay"))
        assertFalse(TillRules.allowed("POST", null))
    }

    @Test
    fun checksLinkIdsAndTimeouts() {
        assertTrue(TillRules.linkId("0123456789abcdef"))
        assertFalse(TillRules.linkId("0123456789ABCDEF"))
        assertFalse(TillRules.linkId("0123\r\nX-Evil: 1"))
        assertFalse(TillRules.linkId(null))
        assertEquals(130_000, TillRules.timeout(130_000))
        assertEquals(TillRules.MAX_REQUEST_MS, TillRules.timeout(10_000_000))
        assertEquals(TillRules.MIN_REQUEST_MS, TillRules.timeout(1))
        assertEquals(20_000, TillRules.timeout(null))
    }

    @Test
    fun opensTheCardLinkOnTheTillsOwnHost() {
        val t = TillRules.linkTarget("https://till.example.org")
        assertEquals(TillRules.LinkTarget("till.example.org", 443, true, "/v1/card/link", "till.example.org"), t)
        val l = TillRules.linkTarget("http://127.0.0.1:9877")
        assertEquals(TillRules.LinkTarget("127.0.0.1", 9877, false, "/v1/card/link", "127.0.0.1:9877"), l)
    }

    @Test
    fun readsTheTillsFramesAndWritesOnlyWellFormedAnswers() {
        assertEquals(TillRules.Incoming.Ready("0123456789abcdef"), TillRules.readFrame("{\"type\":\"ready\",\"link\":\"0123456789abcdef\"}"))
        assertEquals(TillRules.Incoming.Apdu(7, "00a4040008f0464d4341524401"), TillRules.readFrame("{\"type\":\"apdu\",\"id\":7,\"apdu\":\"00A4040008F0464D4341524401\"}"))
        assertEquals(TillRules.Incoming.Other, TillRules.readFrame("{\"type\":\"apdu\",\"id\":7,\"apdu\":\"zz\"}"))
        assertEquals(TillRules.Incoming.Other, TillRules.readFrame("{\"type\":\"ready\",\"link\":\"short\"}"))
        assertEquals(TillRules.Incoming.Other, TillRules.readFrame("not json"))
        assertEquals("{\"type\":\"rapdu\",\"id\":7,\"rapdu\":\"9000\"}", TillRules.answerFrame("rapdu", 7, "9000"))
        assertEquals("{\"type\":\"lost\",\"id\":7}", TillRules.answerFrame("lost", 7, null))
        // Nothing but hex goes into the frame, and an answer always carries a status word.
        assertNull(TillRules.answerFrame("rapdu", 7, "90\",\"x\":\"1"))
        assertNull(TillRules.answerFrame("rapdu", 7, "90"))
        assertNull(TillRules.answerFrame("ready", 7, "9000"))
        assertNull(TillRules.answerFrame("rapdu", null, "9000"))
        // The id as the bridge hands it over: an Int for the small numbers a till counts with.
        assertEquals("{\"type\":\"rapdu\",\"id\":1,\"rapdu\":\"9000\"}", TillRules.answerFrame("rapdu", TillRules.wholeNumber(1 as Any), "9000"))
        assertEquals(5000000000L, TillRules.wholeNumber(5000000000L))
        assertEquals(3L, TillRules.wholeNumber(3.0))
        assertNull(TillRules.wholeNumber(3.5))
        assertNull(TillRules.wholeNumber("1"))
        assertNull(TillRules.wholeNumber(null))
    }

    @Test
    fun answersTheWebSocketHandshakeAsRfc6455Says() {
        // The example in RFC 6455 section 1.3.
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", Ws.accept("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test
    fun masksWhatItSendsAndReadsWhatTheTillSends() {
        val payload = "{\"type\":\"lost\",\"id\":1}".toByteArray()
        val mask = byteArrayOf(1, 2, 3, 4)
        val framed = Ws.encode(Ws.TEXT, payload, mask)
        assertEquals(0x81, framed[0].toInt() and 0xff)
        assertEquals(0x80 or payload.size, framed[1].toInt() and 0xff)
        // A server reads it back by unmasking.
        val back = Ws.read(ByteArrayInputStream(framed))
        assertEquals(Ws.TEXT, back.opcode)
        assertArrayEquals(payload, back.payload)
        // The till sends unmasked frames, long ones with a 16 bit length, and pings.
        val long = ByteArray(300) { 'a'.code.toByte() }
        val out = ByteArrayOutputStream()
        Ws.write(out, Ws.PING, byteArrayOf(9), null)
        Ws.write(out, Ws.TEXT, long, null)
        val input = ByteArrayInputStream(out.toByteArray())
        assertEquals(Ws.PING, Ws.read(input).opcode)
        val f = Ws.read(input)
        assertEquals(300, f.payload.size)
        // A message in two frames is joined.
        val parts = byteArrayOf(0x01, 2, 'a'.code.toByte(), 'b'.code.toByte(), 0x80.toByte(), 1, 'c'.code.toByte())
        assertEquals("abc", String(Ws.read(ByteArrayInputStream(parts)).payload))
    }
}
