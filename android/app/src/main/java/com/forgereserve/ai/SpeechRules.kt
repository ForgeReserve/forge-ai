package com.forgereserve.ai

import android.speech.SpeechRecognizer

/**
 * The rules ForgeSpeech (SpeechPlugin) follows, apart from Android so they run in JVM tests: which
 * language the phone's own on-device recogniser can hear, what each recogniser error means to the page,
 * and how one press of Hold to talk turns the recogniser's results into one question (SpeechSession).
 * The approach follows flash-mobile's VoiceInputBridgeModule (MIT, Galoy Inc.): only the on-device
 * recogniser, never the default one that may send the voice to a server.
 */
object SpeechRules {
    /** Android 12: the first with SpeechRecognizer.createOnDeviceSpeechRecognizer. */
    const val MIN_SDK = 31

    /** Android 13: the first that can say which languages the on-device recogniser has (checkRecognitionSupport). */
    const val SUPPORT_SDK = 33

    /** "en_us", "EN-us", "" or null to a BCP 47 tag like "en-US". English when none is given. */
    fun tag(raw: String?): String {
        val parts = raw.orEmpty().trim().replace('_', '-').split('-').filter { it.isNotEmpty() }
        if (parts.isEmpty() || !parts[0].all { it.isLetter() }) return "en-US"
        return (listOf(parts[0].lowercase()) + parts.drop(1).map { if (it.length == 2) it.uppercase() else it }).joinToString("-")
    }

    private fun language(tag: String) = tag.substringBefore('-').lowercase()

    /**
     * The tag from `languages` to listen with for `wanted`: the same tag, else the first with the same
     * language (en-GB asked, en-US installed: en-US), else null.
     */
    fun match(languages: List<String>, wanted: String): String? {
        val w = tag(wanted)
        val tags = languages.map { tag(it) }
        return tags.firstOrNull { it.equals(w, ignoreCase = true) } ?: tags.firstOrNull { language(it) == language(w) }
    }

    /** What the page is told: {onDevice, reason, locale}. reason is null when it is ready. */
    data class Availability(val onDevice: Boolean, val reason: String?, val locale: String)

    /** Before the language check: null when the phone has an on-device recogniser at all. */
    fun base(sdk: Int, onDeviceService: Boolean, locale: String): Availability? = when {
        sdk < MIN_SDK -> Availability(false, "android-older-than-12", tag(locale))
        !onDeviceService -> Availability(false, "no-on-device-recognizer", tag(locale))
        // Android 12 cannot say which languages it has: start still uses only the on-device recogniser,
        // and a language it lacks fails there (ERROR_LANGUAGE_UNAVAILABLE), after which the engine is used.
        sdk < SUPPORT_SDK -> Availability(true, "languages-unknown", tag(locale))
        else -> null
    }

    /** From checkRecognitionSupport's answer: ready only when the language is on the phone. */
    fun fromSupport(installed: List<String>, pending: List<String>, supported: List<String>, locale: String): Availability {
        match(installed, locale)?.let { return Availability(true, null, it) }
        if (match(pending, locale) != null) return Availability(false, "language-downloading", tag(locale))
        if (match(supported, locale) != null) return Availability(false, "language-not-downloaded", tag(locale))
        return Availability(false, "language-not-supported", tag(locale))
    }

    /**
     * When checkRecognitionSupport fails. Not ready: a phone that lists an on-device recogniser it does
     * not have (GrapheneOS lists one with no Google services) fails here, and must not be offered.
     */
    fun fromSupportError(error: Int, locale: String) = Availability(false, "check-failed-${errorCode(error)}", tag(locale))

    /** The plain codes the page gets for the recogniser's errors. */
    fun errorCode(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "unavailable"
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        // Network errors from an on-device recogniser: it is not working offline as it should.
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "unavailable"
        else -> "failure"
    }
}

/**
 * One press of Hold to talk. The phone's recogniser ends a session on its own after a pause; while the
 * button is still held, the session starts again and the words are joined, so a question with a pause
 * in it is not cut short. Pure: each event returns what the plugin does next.
 */
class SpeechSession(private val maxRestarts: Int = 20) {
    sealed class Act {
        /** Send the words so far (partial) or the question (final) to the page. */
        data class Words(val type: String, val text: String) : Act()
        data class Fail(val code: String) : Act()
        object Restart : Act()
        object End : Act()
    }

    var held = true
        private set
    var ended = false
        private set
    private val parts = mutableListOf<String>()
    private var partial = ""
    private var restarts = 0

    private fun join(vararg more: String) = (parts + more).map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")

    fun text() = join(partial)

    fun onPartial(text: String): List<Act> {
        if (ended) return emptyList()
        partial = text
        return listOf(Act.Words("partial", join(partial)))
    }

    fun onResults(text: String): List<Act> {
        if (ended) return emptyList()
        partial = ""
        if (text.isNotBlank()) parts.add(text)
        if (held && restarts < maxRestarts) {
            restarts++
            return listOf(Act.Words("partial", join()), Act.Restart)
        }
        return finish()
    }

    fun onError(code: String): List<Act> {
        if (ended) return emptyList()
        // Silence while held: listen again.
        if (code == "no-speech" && held && restarts < maxRestarts) {
            restarts++
            return listOf(Act.Restart)
        }
        if (code == "no-speech") return finish()
        // After the release, some recognisers end with an error instead of a last result: what was heard is the question.
        if (!held && code != "permission" && text().isNotEmpty()) return finish()
        ended = true
        return listOf(Act.Fail(code), Act.End)
    }

    /** The button was let go: the recogniser is told to stop, and its last result ends the question. */
    fun onStop() {
        held = false
    }

    /** No result came in time after the stop: what was heard so far is the question. */
    fun onDeadline(): List<Act> = if (ended) emptyList() else finish()

    private fun finish(): List<Act> {
        ended = true
        val text = text()
        return if (text.isEmpty()) listOf(Act.Fail("no-speech"), Act.End) else listOf(Act.Words("final", text), Act.End)
    }
}
