package com.forgereserve.ai

import kotlin.math.max
import kotlin.math.min

/**
 * When to start playing on a phone that makes the natural voice slower than it plays it: the same
 * rules and numbers as public/v2/core/voicepace.js (docs/VOICE.md, Slow phones), for the native voice,
 * whose sound never passes through the page. JVM tested (VoicePaceTest, with the web test's numbers).
 */
object VoicePace {
    const val BUFFER_RTF = 0.8
    const val FALLBACK_RTF = 1.6
    const val MAX_WAIT_S = 6.0
    const val MARGIN_S = 0.5
    const val MEASURE_S = 0.32
    const val SEC_PER_CHAR = 0.065

    /** Seconds of sound needed before the start: remaining * (1 - 1/rtf) + margin; 0 when the phone keeps up. */
    fun bufferTarget(remainingS: Double, rtf: Double): Double =
        if (!(rtf > BUFFER_RTF)) 0.0 else max(0.0, remainingS * (1 - 1 / rtf)) + MARGIN_S

    fun waitFor(remainingS: Double, rtf: Double): Double = bufferTarget(remainingS, rtf) * rtf

    fun fallBack(rtf: Double?, totalS: Double, preferNatural: Boolean, phoneVoice: Boolean): Boolean {
        if (preferNatural || !phoneVoice || rtf == null || !(rtf > 0)) return false
        return rtf > FALLBACK_RTF || waitFor(totalS, rtf) > MAX_WAIT_S
    }

    fun sayS(chars: Int, spc: Double): Double = chars * (if (spc > 0) spc else SEC_PER_CHAR)

    data class Step(val start: Boolean, val fraction: Double, val rtf: Double?, val fallback: Boolean)

    /** One answer's start, as createPacer in voicepace.js. Times are in ms. */
    class Pacer(
        private val chars: List<Int>,
        private val kept: Double?,
        spc: Double?,
        private val preferNatural: Boolean,
        private val phoneVoice: Boolean,
    ) {
        private val spcUse = if (spc != null && spc > 0) spc else SEC_PER_CHAR
        private val doneS = DoubleArray(chars.size)
        private var piece = 0
        private var pieceS = 0.0
        private var madeS = 0.0
        private var firstAt: Double? = null
        private var firstS = 0.0
        private var checked = false
        private var firstRtf: Double? = null
        private var doneChars = 0
        private var doneAudio = 0.0
        var started = false
            private set

        fun remainingS(): Double {
            var s = 0.0
            for (i in chars.indices) {
                s += when {
                    i < piece -> doneS[i]
                    i == piece -> max(pieceS, sayS(chars[i], spcUse))
                    else -> sayS(chars[i], spcUse)
                }
            }
            return max(s, madeS)
        }

        private fun live(at: Double): Double? {
            val f = firstAt ?: return null
            return if (madeS - firstS >= MEASURE_S) max(0.0, at - f) / 1000 / (madeS - firstS) else null
        }

        private fun decide(at: Double): Step {
            if (started) return Step(false, 1.0, null, false)
            val lr = live(at)
            if (lr != null && !checked) {
                checked = true
                if (fallBack(lr, remainingS(), preferNatural, phoneVoice)) return Step(false, 0.0, lr, true)
            }
            val r = lr ?: kept
            if (r == null || !(r > 0)) return Step(false, 0.0, null, false)
            val target = bufferTarget(remainingS(), r)
            val start = madeS >= target
            if (start) started = true
            return Step(start, if (target > 0) min(1.0, madeS / target) else 1.0, r, false)
        }

        fun audio(seconds: Double, at: Double): Step {
            if (firstAt == null) {
                firstAt = at
                firstS = seconds
            }
            madeS += seconds
            pieceS += seconds
            return decide(at)
        }

        fun pieceDone(seconds: Double, genMs: Double, at: Double): Step {
            if (piece < doneS.size) doneS[piece] = seconds
            if (piece == 0 && seconds > 0) firstRtf = genMs / 1000 / seconds
            if (seconds > 0) {
                doneChars += chars.getOrElse(piece) { 0 }
                doneAudio += seconds
            }
            piece++
            pieceS = 0.0
            return decide(at)
        }

        fun finish(): Step {
            val s = !started
            started = true
            return Step(s, 1.0, null, false)
        }

        /** The first piece's rtf and the seconds of speech per character, for the kept estimate. */
        fun rtf(): Double? = firstRtf

        fun spc(): Double? = if (doneChars > 0) doneAudio / doneChars else null
    }
}
