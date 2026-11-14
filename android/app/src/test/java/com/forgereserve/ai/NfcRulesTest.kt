package com.forgereserve.ai

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NfcRulesTest {
    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    @Test
    fun givesEachCommandFiveSecondsOnTheCard() {
        assertEquals(5000, NfcRules.TIMEOUT_MS)
    }

    @Test
    fun readsAndWritesHexBothWays() {
        assertArrayEquals(bytes(0x00, 0xa4, 0xff), NfcRules.fromHex("00a4FF"))
        assertEquals("00a4ff", NfcRules.toHex(bytes(0x00, 0xa4, 0xff)))
        assertNull(NfcRules.fromHex("abc"))
        assertNull(NfcRules.fromHex("zz"))
        assertNull(NfcRules.fromHex(null))
        assertEquals(0, NfcRules.fromHex("")!!.size)
    }

    @Test
    fun takesTheCommandsThePageSendsAsTheAppletsTranscriptHasThem() {
        // SELECT by the applet AID with Le (case 4), as public/v2/core/card/apdu.js builds it.
        assertArrayEquals(NfcRules.fromHex("00a404000bf04341534855434152440100"), NfcRules.apdu("00a404000bf04341534855434152440100"))
        // GET_INFO (case 2), SPEND_ALL_BEGIN (case 4), SPEND_ALL_OUTPUTS (case 3), from the transcript.
        assertEquals(5, NfcRules.apdu("b001000000")!!.size)
        assertEquals(7, NfcRules.apdu("b0220000010004")!!.size)
        val outputs = "b023000025" + "0000005a" + "03" + "11".repeat(32)
        assertEquals(5 + 37, NfcRules.apdu(outputs)!!.size)
        // A header alone (case 1).
        assertEquals(4, NfcRules.apdu("b0250000")!!.size)
        // The largest short APDU: 255 data bytes and Le.
        assertEquals(NfcRules.MAX_APDU, NfcRules.apdu("b03000ff" + "ff" + "00".repeat(255) + "00")!!.size)
    }

    @Test
    fun refusesWhatIsNotOneShortApdu() {
        assertNull(NfcRules.apdu("b001"))
        assertNull(NfcRules.apdu("not hex"))
        assertNull(NfcRules.apdu(null))
        // Lc says 2 bytes, 3 follow (and not 2 plus Le): misframed.
        assertNull(NfcRules.apdu("b0300000020102030405"))
        // Lc says 4, only 2 follow.
        assertNull(NfcRules.apdu("b030000004aabb"))
        // An extended length (Lc 00 then two bytes) is not sent.
        assertNull(NfcRules.apdu("b0300000000003aabbcc"))
        // Longer than any short APDU.
        assertNull(NfcRules.apdu("b0300000ff" + "00".repeat(300)))
    }

    @Test
    fun handsBackTheWholeAnswerWithItsStatusWord() {
        assertEquals("02019000", NfcRules.answer(bytes(0x02, 0x01, 0x90, 0x00)))
        assertEquals("6a82", NfcRules.answer(bytes(0x6a, 0x82)))
        assertNull(NfcRules.answer(bytes(0x90)))
        assertNull(NfcRules.answer(null))
    }
}
