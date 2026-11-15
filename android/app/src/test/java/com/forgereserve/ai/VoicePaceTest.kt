package com.forgereserve.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same numbers as test/unit/v2/voicepace.test.ts: the web and the native voice start alike. */
class VoicePaceTest {
    @Test
    fun startsAtOnceWhenThePhoneKeepsUp() {
        assertEquals(0.0, VoicePace.bufferTarget(10.0, 0.2), 0.0)
        assertEquals(0.0, VoicePace.bufferTarget(10.0, 0.8), 0.0)
    }

    @Test
    fun waitsForRemainingTimesOneMinusOneOverRtfPlusTheMargin() {
        assertEquals(10 * (1 - 1 / 1.3) + 0.5, VoicePace.bufferTarget(10.0, 1.3), 1e-9)
        assertEquals(5.5, VoicePace.bufferTarget(10.0, 2.0), 1e-9)
        assertEquals(0.5, VoicePace.bufferTarget(10.0, 0.9), 1e-9)
        assertEquals((10 * (1 - 1 / 1.3) + 0.5) * 1.3, VoicePace.waitFor(10.0, 1.3), 1e-9)
    }

    @Test
    fun fallsBackOverRtf16OrAWaitOver6s() {
        assertTrue(VoicePace.fallBack(1.7, 2.0, preferNatural = false, phoneVoice = true))
        assertFalse(VoicePace.fallBack(1.3, 10.0, preferNatural = false, phoneVoice = true))
        assertTrue(VoicePace.fallBack(1.3, 30.0, preferNatural = false, phoneVoice = true))
        assertFalse(VoicePace.fallBack(0.7, 600.0, preferNatural = false, phoneVoice = true))
        assertFalse(VoicePace.fallBack(3.0, 30.0, preferNatural = true, phoneVoice = true))
        assertFalse(VoicePace.fallBack(3.0, 30.0, preferNatural = false, phoneVoice = false))
        assertFalse(VoicePace.fallBack(null, 30.0, preferNatural = false, phoneVoice = true))
    }

    private class Run(val startAt: Double?, val fallback: Boolean, val gaps: Int, val pacer: VoicePace.Pacer)

    /** An engine at a steady rtf, 80 ms pieces, through the pacer; then playback from the start. */
    private fun simulate(rtf: Double, audioS: List<Double>, chars: List<Int>, kept: Double? = null, phoneVoice: Boolean = false, preferNatural: Boolean = false, firstMs: Double = 200.0): Run {
        val p = VoicePace.Pacer(chars, kept, null, preferNatural, phoneVoice)
        var t = 0.0
        val arrivals = mutableListOf<Double>()
        var startAt: Double? = null
        fun note(s: VoicePace.Step): Boolean {
            if (s.start && startAt == null) startAt = t
            return s.fallback
        }
        for (total in audioS) {
            val p0 = t
            t += firstMs
            val n = Math.round(total / 0.08).toInt()
            repeat(n) {
                t += 0.08 * rtf * 1000
                arrivals += t
                if (note(p.audio(0.08, t))) return Run(null, true, 0, p)
            }
            if (note(p.pieceDone(n * 0.08, t - p0, t))) return Run(null, true, 0, p)
        }
        note(p.finish())
        var end = startAt!!
        var gaps = 0
        for (a in arrivals) {
            val at = maxOf(a, startAt!!)
            if (at > end + 1e-6) {
                gaps++
                end = at
            }
            end += 80.0
        }
        return Run(startAt, false, gaps, p)
    }

    @Test
    fun withThatMuchInHandASteadyEngineNeverRunsDry() {
        for (rtf in listOf(0.85, 0.95, 1.1, 1.3, 1.5)) {
            for (pieces in listOf(listOf(2.0), listOf(8.0), listOf(6.0, 6.0, 6.0), listOf(20.0))) {
                val r = simulate(rtf, pieces, pieces.map { Math.round(it / VoicePace.SEC_PER_CHAR).toInt() })
                assertFalse(r.fallback)
                assertEquals("rtf $rtf, pieces $pieces", 0, r.gaps)
            }
        }
    }

    @Test
    fun saysOnceWhenThisAnswerMeasuresTooSlow() {
        val r = simulate(2.0, listOf(6.0), listOf(92), phoneVoice = true)
        assertTrue(r.fallback)
        assertNull(r.startAt)
        val kept = simulate(2.0, listOf(6.0), listOf(92), phoneVoice = true, preferNatural = true)
        assertFalse(kept.fallback)
        assertEquals(0, kept.gaps)
    }

    @Test
    fun measuresTheFirstPiecesRtfAndTheSpeechPerCharacter() {
        val r = simulate(1.0, listOf(4.0, 4.0), listOf(60, 60))
        assertEquals((200 + 4000) / 1000.0 / 4, r.pacer.rtf()!!, 1e-6)
        assertEquals(8.0 / 120, r.pacer.spc()!!, 1e-6)
    }
}
