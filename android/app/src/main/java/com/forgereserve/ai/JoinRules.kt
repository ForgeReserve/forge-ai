package com.forgereserve.ai

import java.net.URI
import java.net.URISyntaxException

/**
 * The rules for an event link that opens the app (docs/ANDROID.md, Event links): the one QR code on an
 * event's slide reads https://ai.forge-reserve.com/j#<pass>, and the /j page's Open button sends the
 * same address. The pass is in the fragment; the web app opens a free balance with it
 * (public/v2/core/join.js takes the same shape). Plain Kotlin with no Android types, so the JVM unit
 * tests cover it (app/src/test).
 */
object JoinRules {
    const val ACTION_VIEW = "android.intent.action.VIEW"

    /** The hosts in the manifest's App Link filter. */
    val HOSTS = setOf("ai.forge-reserve.com")

    /** The paths in that filter. */
    val PATHS = setOf("/j", "/j/")

    /** What a pass looks like: base64url letters, as `pnpm admin passes:create` makes them. */
    private val PASS = Regex("^[A-Za-z0-9_-]{8,128}$")

    /**
     * The pass in an intent, or null when the intent is not an event link. fromHistory: the app was
     * reopened from recent apps, which hands back the old intent; its pass was taken the first time.
     */
    fun passFrom(action: String?, data: String?, fromHistory: Boolean): String? {
        if (fromHistory || action != ACTION_VIEW || data == null) return null
        val uri = try {
            URI(data)
        } catch (e: URISyntaxException) {
            return null
        }
        if (uri.scheme?.lowercase() != "https") return null
        if (uri.host?.lowercase() !in HOSTS) return null
        if (uri.rawPath !in PATHS) return null
        val pass = (uri.rawFragment ?: return null).removePrefix("join=")
        return pass.takeIf { PASS.matches(it) }
    }
}
