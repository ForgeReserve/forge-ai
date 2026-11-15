package com.forgereserve.ai

import android.speech.SpeechRecognizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechRulesTest {
    private val words = { type: String, text: String -> SpeechSession.Act.Words(type, text) }

    @Test
    fun tidiesLanguageTags() {
        assertEquals("en-US", SpeechRules.tag("en_us"))
        assertEquals("en-GB", SpeechRules.tag("EN-gb"))
        assertEquals("en", SpeechRules.tag("en"))
        assertEquals("zh-Hant-TW", SpeechRules.tag("zh-Hant-tw"))
        assertEquals("en-US", SpeechRules.tag(""))
        assertEquals("en-US", SpeechRules.tag(null))
        assertEquals("en-US", SpeechRules.tag("123"))
    }

    @Test
    fun matchesTheSameTagFirstThenTheSameLanguage() {
        assertEquals("en-GB", SpeechRules.match(listOf("en-US", "en-GB"), "en_gb"))
        assertEquals("en-US", SpeechRules.match(listOf("de-DE", "en-US"), "en-GB"))
        assertEquals("en-US", SpeechRules.match(listOf("en_US"), "en"))
        assertNull(SpeechRules.match(listOf("de-DE", "fr-FR"), "en-US"))
        assertNull(SpeechRules.match(emptyList(), "en-US"))
    }

    @Test
    fun offersOnlyAnOnDeviceRecogniserThatHasTheLanguage() {
        // Android 11 and older have no on-device recogniser to ask for.
        assertEquals(SpeechRules.Availability(false, "android-older-than-12", "en-US"), SpeechRules.base(30, true, "en-US"))
        assertEquals(SpeechRules.Availability(false, "no-on-device-recognizer", "en-US"), SpeechRules.base(34, false, "en-US"))
        // Android 12 cannot list its languages: offered, and a missing language fails at start.
        assertEquals(SpeechRules.Availability(true, "languages-unknown", "en-US"), SpeechRules.base(31, true, "en-US"))
        assertNull(SpeechRules.base(33, true, "en-US"))

        assertEquals(SpeechRules.Availability(true, null, "en-US"), SpeechRules.fromSupport(listOf("en-US"), emptyList(), listOf("en-US", "de-DE"), "en-GB"))
        assertEquals(SpeechRules.Availability(false, "language-downloading", "en-US"), SpeechRules.fromSupport(emptyList(), listOf("en-US"), listOf("en-US"), "en-US"))
        assertEquals(SpeechRules.Availability(false, "language-not-downloaded", "en-US"), SpeechRules.fromSupport(listOf("de-DE"), emptyList(), listOf("en-US"), "en-US"))
        assertEquals(SpeechRules.Availability(false, "language-not-supported", "en-US"), SpeechRules.fromSupport(emptyList(), emptyList(), emptyList(), "en-US"))
        // A recogniser that cannot even answer the question is not offered.
        val failed = SpeechRules.fromSupportError(SpeechRecognizer.ERROR_SERVER_DISCONNECTED, "en-US")
        assertFalse(failed.onDevice)
        assertEquals("check-failed-unavailable", failed.reason)
    }

    @Test
    fun mapsErrorsToPlainCodes() {
        assertEquals("permission", SpeechRules.errorCode(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS))
        assertEquals("unavailable", SpeechRules.errorCode(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED))
        assertEquals("unavailable", SpeechRules.errorCode(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE))
        assertEquals("unavailable", SpeechRules.errorCode(SpeechRecognizer.ERROR_NETWORK))
        assertEquals("no-speech", SpeechRules.errorCode(SpeechRecognizer.ERROR_NO_MATCH))
        assertEquals("no-speech", SpeechRules.errorCode(SpeechRecognizer.ERROR_SPEECH_TIMEOUT))
        assertEquals("busy", SpeechRules.errorCode(SpeechRecognizer.ERROR_RECOGNIZER_BUSY))
        assertEquals("audio", SpeechRules.errorCode(SpeechRecognizer.ERROR_AUDIO))
        assertEquals("failure", SpeechRules.errorCode(SpeechRecognizer.ERROR_CLIENT))
        assertEquals("failure", SpeechRules.errorCode(999))
    }

    @Test
    fun aHeldQuestionWithPausesIsJoinedAndSentOnRelease() {
        val s = SpeechSession()
        assertEquals(listOf(words("partial", "what should")), s.onPartial("what should"))
        // The recogniser ends after a pause while the button is still held: it listens again.
        assertEquals(listOf(words("partial", "what should I bring"), SpeechSession.Act.Restart), s.onResults("what should I bring"))
        // Silence while held: again.
        assertEquals(listOf(SpeechSession.Act.Restart), s.onError("no-speech"))
        assertEquals(listOf(words("partial", "what should I bring to the")), s.onPartial("to the"))
        s.onStop()
        assertFalse(s.held)
        assertEquals(listOf(words("final", "what should I bring to the beach"), SpeechSession.Act.End), s.onResults("to the beach"))
        assertTrue(s.ended)
        assertEquals(emptyList<SpeechSession.Act>(), s.onResults("late"))
    }

    @Test
    fun nothingHeardEndsWithNoSpeech() {
        val s = SpeechSession()
        s.onStop()
        assertEquals(listOf(SpeechSession.Act.Fail("no-speech"), SpeechSession.Act.End), s.onError("no-speech"))
    }

    @Test
    fun afterTheReleaseWhatWasHeardIsTheQuestion() {
        // No last result in time.
        val a = SpeechSession()
        a.onPartial("hello there")
        a.onStop()
        assertEquals(listOf(words("final", "hello there"), SpeechSession.Act.End), a.onDeadline())
        // An error instead of a last result.
        val b = SpeechSession()
        b.onPartial("hello")
        b.onStop()
        assertEquals(listOf(words("final", "hello"), SpeechSession.Act.End), b.onError("failure"))
    }

    @Test
    fun errorsWhileHeldEndTheQuestion() {
        val s = SpeechSession()
        s.onPartial("hello")
        assertEquals(listOf(SpeechSession.Act.Fail("unavailable"), SpeechSession.Act.End), s.onError("unavailable"))
        // A refused microphone is never turned into a question, even after the release.
        val p = SpeechSession()
        p.onPartial("hello")
        p.onStop()
        assertEquals(listOf(SpeechSession.Act.Fail("permission"), SpeechSession.Act.End), p.onError("permission"))
    }

    @Test
    fun restartsAreCapped() {
        val s = SpeechSession(maxRestarts = 2)
        assertEquals(listOf(SpeechSession.Act.Restart), s.onError("no-speech"))
        assertEquals(listOf(words("partial", "one"), SpeechSession.Act.Restart), s.onResults("one"))
        assertEquals(listOf(words("final", "one two"), SpeechSession.Act.End), s.onResults("two"))
    }
}
