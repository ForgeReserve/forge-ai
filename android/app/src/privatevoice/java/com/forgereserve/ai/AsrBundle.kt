package com.forgereserve.ai

import android.content.res.AssetManager
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig

/**
 * Forge Private Voice's speech to text (docs/VOICE.md, Bundled speech to text): Moonshine tiny, English
 * (MIT), through sherpa-onnx 2.0.1 (Apache-2.0, ONNX Runtime linked in), both put in place at build time
 * by scripts/asr-model.ts and pinned in scripts/asr/lock.json. sherpa-onnx reads the model straight from
 * the APK's assets (stored uncompressed): nothing is copied to the phone's storage. Loaded only in the
 * :asr process (AsrService).
 */
object AsrBundle {
    const val BUNDLED = true

    /** The model's id in scripts/asr/lock.json, and its folder in the APK's assets. */
    const val MODEL = "moonshine-tiny-en"
    const val DIR = "asr/$MODEL"

    /** Loads the model; the slow call (about 0.6 to 0.8 s on the two test phones). */
    fun open(assets: AssetManager, threads: Int): AsrRecognizer = Moonshine(assets, threads)

    private class Moonshine(assets: AssetManager, threads: Int) : AsrRecognizer {
        private val rec = OfflineRecognizer(
            assets,
            OfflineRecognizerConfig(
                featConfig = FeatureConfig(sampleRate = AsrRules.RATE, featureDim = 80),
                modelConfig = OfflineModelConfig(
                    moonshine = OfflineMoonshineModelConfig(encoder = "$DIR/encoder_model.ort", mergedDecoder = "$DIR/decoder_model_merged.ort"),
                    tokens = "$DIR/tokens.txt",
                    numThreads = threads,
                ),
            ),
        )

        override fun transcribe(samples: FloatArray): String {
            val s = rec.createStream()
            try {
                s.acceptWaveform(samples, AsrRules.RATE)
                rec.decode(s)
                return rec.getResult(s).text
            } finally {
                s.release()
            }
        }

        override fun close() = rec.release()
    }
}
