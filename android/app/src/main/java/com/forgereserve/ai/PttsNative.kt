package com.forgereserve.ai

/**
 * Gradium's Phonon runtime (libptts_ffi.so, xn-ptts v0.7.0, MIT OR Apache-2.0) through the app's JNI
 * glue (libforge_ptts.so, src/main/cpp/forge_ptts_jni.c). Both are built by scripts/android-ptts.sh
 * and committed in jniLibs/arm64-v8a. Loaded only in the voice process (VoiceService), and only on a
 * processor VoiceRules.cpuOk accepts.
 *
 * Every call blocks and must come from one thread at a time (the voice thread). Failures throw
 * IllegalStateException with the library's own words.
 */
object PttsNative {
    @Volatile private var loaded = false

    /** Loads the two libraries once. Throws UnsatisfiedLinkError when they are not in this APK. */
    @Synchronized
    fun load() {
        if (loaded) return
        System.loadLibrary("ptts_ffi")
        System.loadLibrary("forge_ptts")
        loaded = true
    }

    /** Receives the sound as it is made: 24 kHz mono, -1 to 1. Returns false to stop. */
    fun interface PcmSink {
        fun onPcm(pcm: FloatArray): Boolean
    }

    /** Loads the checkpoint folder dir; lang is how numbers and symbols are read ("en"). The slow call. */
    @JvmStatic external fun open(dir: ByteArray, lang: ByteArray): Long

    /** The voice names, one per line. */
    @JvmStatic external fun voices(h: Long): String

    @JvmStatic external fun setVoice(h: Long, name: ByteArray)

    @JvmStatic external fun setTemperature(h: Long, t: Float)

    @JvmStatic external fun setSeed(h: Long, seed: Long)

    /** Speaks text (VoiceRules.textBytes), handing the sound to sink; timings gets frames, samples, first-audio ms, total ms. */
    @JvmStatic external fun speak(h: Long, text: ByteArray, sink: PcmSink, timings: DoubleArray)

    @JvmStatic external fun free(h: Long)

    /** Keeps the calling thread, and the threads it starts from now on, on these cores. 0, or the errno. */
    @JvmStatic external fun pin(cpus: IntArray): Int
}
