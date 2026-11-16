package com.forgereserve.ai

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Plays the native voice: 24 kHz mono floats into one AudioTrack, fed by a thread of its own, so the
 * model never waits on the speaker. Sound pushed before begin() is held (the start can wait for sound
 * in hand, VoicePace); after it, each piece is played as it comes. A piece that arrives after the one
 * before has finished is a gap (gaps), on top of what AudioTrack itself counts (underruns).
 */
class VoicePlayer(private val rate: Int = VoiceRules.SAMPLE_RATE) {
    private val track: AudioTrack = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT), rate * 4 / 4))
        .build()
    private val queue = LinkedBlockingQueue<FloatArray>()
    @Volatile private var started = false
    @Volatile private var ended = false
    @Volatile private var stopped = false
    @Volatile var gaps = 0
        private set
    private var written = 0L
    private val writer = Thread({ feed() }, "forge-voice-play")
    private val doneLatch = java.util.concurrent.CountDownLatch(1)

    init {
        writer.start()
    }

    fun push(pcm: FloatArray) {
        if (!stopped && pcm.isNotEmpty()) queue.put(pcm)
    }

    /** Starts playing what is held, and what comes after as it comes. */
    fun begin() {
        if (started || stopped) return
        track.play()
        started = true
        synchronized(this) { (this as Object).notifyAll() }
    }

    /** No more sound comes: play what is left, then done. */
    fun end() {
        ended = true
        queue.put(FloatArray(0))
        synchronized(this) { (this as Object).notifyAll() }
    }

    /** Silence at once. */
    fun stop() {
        stopped = true
        queue.clear()
        queue.put(FloatArray(0))
        synchronized(this) { (this as Object).notifyAll() }
        try {
            track.pause()
            track.flush()
        } catch (_: IllegalStateException) {
        }
    }

    /** Waits until everything played (or stop), up to ms. */
    fun await(ms: Long): Boolean = doneLatch.await(ms, TimeUnit.MILLISECONDS)

    fun underruns(): Int = try {
        track.underrunCount
    } catch (_: Exception) {
        -1
    }

    fun release() {
        stop()
        writer.join(2000)
        try {
            track.release()
        } catch (_: Exception) {
        }
    }

    private fun feed() {
        try {
            synchronized(this) { while (!started && !stopped && !ended) (this as Object).wait(50) }
            if (!started && ended && !stopped) begin()
            // When the sound written so far runs out, by the clock: a piece written after that is a gap.
            var dryAt = android.os.SystemClock.elapsedRealtime() + LEAD_MS
            while (!stopped) {
                val pcm = queue.poll(30, TimeUnit.SECONDS) ?: break
                if (pcm.isEmpty()) {
                    if (ended || stopped) break else continue
                }
                val now = android.os.SystemClock.elapsedRealtime()
                if (written > 0 && now > dryAt + GAP_MS) {
                    gaps++
                    dryAt = now
                }
                track.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING)
                written += pcm.size
                dryAt += pcm.size * 1000L / rate
            }
            if (!stopped) {
                // Let the last of it come out of the speaker before saying it ended.
                val deadline = System.currentTimeMillis() + 2000 + written * 1000 / rate
                while (!stopped && (track.playbackHeadPosition.toLong() and 0xffffffffL) < written && System.currentTimeMillis() < deadline) Thread.sleep(20)
            }
        } catch (_: InterruptedException) {
        } finally {
            doneLatch.countDown()
        }
    }

    private companion object {
        const val LEAD_MS = 50L
        const val GAP_MS = 20L
    }
}
