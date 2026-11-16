package com.forgereserve.ai

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AsrRulesTest {
    @Test
    fun saysWhyItCannotHear() {
        assertNull(AsrRules.unavailable(bundled = true, arm64 = true, libThere = true, modelThere = true, broken = null))
        assertEquals("no speech to text in this app", AsrRules.unavailable(false, true, true, true, null))
        assertEquals("not a 64-bit ARM phone", AsrRules.unavailable(true, false, true, true, null))
        assertEquals("not a 64-bit ARM phone", AsrRules.unavailable(true, true, false, true, null))
        assertEquals("the speech to text files are not in this app", AsrRules.unavailable(true, true, true, false, null))
        assertEquals("The speech to text stopped working.", AsrRules.unavailable(true, true, true, true, "The speech to text stopped working."))
    }

    @Test
    fun eachApkSaysWhetherItCarriesTheModel() {
        // The JVM tests run once per flavour, each with its own AsrBundle.
        if (AsrBundle.BUNDLED) {
            assertEquals("moonshine-tiny-en", AsrBundle.MODEL)
            assertEquals("asr/moonshine-tiny-en", AsrBundle.DIR)
        } else {
            assertEquals("", AsrBundle.MODEL)
            assertEquals("no speech to text in this app", AsrRules.unavailable(AsrBundle.BUNDLED, true, true, true, null))
        }
    }

    @Test
    fun readsTheMicrophoneAsFloats() {
        assertArrayEquals(floatArrayOf(0f, 0.5f, -1f), AsrRules.floats(shortArrayOf(0, 16384, -32768)), 0f)
        assertArrayEquals(floatArrayOf(0f, 0.5f), AsrRules.floats(shortArrayOf(0, 16384, -32768), 2), 0f)
        assertEquals(1600, AsrRules.CHUNK)
    }

    @Test
    fun levelIsTheWebMicrophonesLevel() {
        assertEquals(0.0, AsrRules.level(FloatArray(0)), 0.0)
        assertEquals(0.0, AsrRules.level(FloatArray(100)), 0.0)
        assertEquals(0.4, AsrRules.level(FloatArray(100) { if (it % 2 == 0) 0.1f else -0.1f }), 1e-6)
        assertEquals(1.0, AsrRules.level(FloatArray(100) { 0.9f }), 0.0)
    }

    @Test
    fun hearsAgainEveryHalfSecondOfNewSound() {
        val r = AsrRules.RATE
        assertFalse("too short", AsrRules.partialDue(r / 5, 0, false))
        assertFalse("not half a second yet", AsrRules.partialDue(r * 4 / 10, 0, false))
        assertTrue(AsrRules.partialDue(r / 2, 0, false))
        assertFalse("a pass runs", AsrRules.partialDue(r, 0, true))
        assertFalse(AsrRules.partialDue(r + r / 4, r, false))
        assertTrue(AsrRules.partialDue(r + r / 2, r, false))
        // A slow pass waits twice as long as it took, so the processor stays free half the time.
        assertEquals(AsrRules.STEP, AsrRules.stepAfter(120.0))
        assertEquals(AsrRules.STEP, AsrRules.stepAfter(250.0))
        assertEquals(r * 146 / 100, AsrRules.stepAfter(730.0))
        assertFalse(AsrRules.partialDue(r * 4, r * 2, false, AsrRules.stepAfter(1500.0)))
        assertTrue(AsrRules.partialDue(r * 5, r * 2, false, AsrRules.stepAfter(1500.0)))
    }

    @Test
    fun cleansTheWords() {
        assertEquals("What is the weather?", AsrRules.clean("  What is  the\nweather? "))
        assertEquals("", AsrRules.clean(" \t "))
    }

    @Test
    fun recordingGrowsUpToItsLimit() {
        val rec = AsrRules.Recording(max = 5000)
        assertTrue(rec.add(FloatArray(1600) { 0.25f }))
        assertTrue(rec.add(FloatArray(1600) { 0.5f }))
        assertEquals(3200, rec.size)
        val snap = rec.snapshot()
        assertEquals(3200, snap.size)
        assertEquals(0.25f, snap[0], 0f)
        assertEquals(0.5f, snap[3199], 0f)
        assertFalse("the rest is dropped", rec.add(FloatArray(3000) { 1f }))
        assertEquals(5000, rec.size)
        assertFalse(rec.add(FloatArray(10)))
        assertEquals(5000, rec.snapshot().size)
        assertEquals(AsrRules.RATE * 90, AsrRules.RATE * AsrRules.MAX_SECONDS)
    }

    @Test
    fun checkClipsArePlainWavNames() {
        assertTrue(AsrRules.checkName("s01-maeve.wav"))
        for (bad in listOf(null, "", "../x.wav", "a/b.wav", ".hidden.wav", "clip.mp3", "x".repeat(90) + ".wav")) assertFalse(bad.toString(), AsrRules.checkName(bad))
    }

    private fun wav(samples: ShortArray, rate: Int = 16000, channels: Int = 1, extra: Boolean = false): ByteArray {
        val list = if (extra) 12 else 0
        val b = ByteBuffer.allocate(44 + list + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()).putInt(36 + list + samples.size * 2).put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort()).putInt(rate).putInt(rate * 2 * channels).putShort((2 * channels).toShort()).putShort(16)
        if (extra) b.put("LIST".toByteArray()).putInt(4).put("INFO".toByteArray())
        b.put("data".toByteArray()).putInt(samples.size * 2)
        for (s in samples) b.putShort(s)
        return b.array()
    }

    @Test
    fun readsSixteenKilohertzMonoWav() {
        assertArrayEquals(floatArrayOf(0f, 0.5f, -0.5f), AsrRules.wav(wav(shortArrayOf(0, 16384, -16384))), 0f)
        assertArrayEquals(floatArrayOf(0.5f), AsrRules.wav(wav(shortArrayOf(16384), extra = true)), 0f)
        assertThrows(IllegalArgumentException::class.java) { AsrRules.wav(wav(shortArrayOf(1), rate = 44100)) }
        assertThrows(IllegalArgumentException::class.java) { AsrRules.wav(wav(shortArrayOf(1, 1), channels = 2)) }
        assertThrows(IllegalArgumentException::class.java) { AsrRules.wav("not a wav file".toByteArray()) }
    }

    @Test
    fun letsTheModelGoWhenNotNeeded() {
        assertEquals(60_000L, AsrRules.RELEASE_BACKGROUND_MS)
        assertEquals(300_000L, AsrRules.RELEASE_IDLE_MS)
        assertTrue(AsrRules.FINISH_MS < 6_000L) // under the page's own wait (voice-in phone FINISH_MS)
    }
}
