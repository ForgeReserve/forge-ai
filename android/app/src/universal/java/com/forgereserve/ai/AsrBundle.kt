package com.forgereserve.ai

import android.content.res.AssetManager

/**
 * The universal APK carries no speech to text of its own: ForgeAsr says it is unavailable and Hold to
 * talk uses the phone's recogniser or the engine, as before. Forge Private Voice has the other AsrBundle
 * (src/privatevoice/).
 */
object AsrBundle {
    const val BUNDLED = false
    const val MODEL = ""
    const val DIR = ""

    fun open(assets: AssetManager, threads: Int): AsrRecognizer = throw UnsupportedOperationException("no speech to text in this app")
}
