package com.forgereserve.ai

/**
 * Cross-origin isolation for the app's own files (docs/VOICE.md). The natural voice runs its model on
 * several threads, which needs SharedArrayBuffer, which a page only gets when it is served with these
 * headers. The website sends them for /v2/ (src/app.ts); here Capacitor's local server serves the
 * bundle at https://localhost, so MainActivity adds them to each of its responses. Only the app's own
 * files get them: anything else the web view loads is left as it came.
 */
object IsolationRules {
    val HEADERS: Map<String, String> = linkedMapOf(
        "Cross-Origin-Opener-Policy" to "same-origin",
        "Cross-Origin-Embedder-Policy" to "require-corp",
        "Cross-Origin-Resource-Policy" to "same-origin",
    )

    /** The headers to add to a response for this address: the isolation headers on the app's own origin, none elsewhere. */
    fun headersFor(scheme: String?, host: String?, appScheme: String, appHost: String): Map<String, String> =
        if (scheme.equals(appScheme, ignoreCase = true) && host.equals(appHost, ignoreCase = true)) HEADERS else emptyMap()

    /** The response's headers with `add` put in, replacing any header of the same name whatever its case. */
    fun merge(existing: Map<String, String>?, add: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        val names = add.keys.map { it.lowercase() }.toSet()
        existing?.forEach { (k, v) -> if (k.lowercase() !in names) out[k] = v }
        out.putAll(add)
        return out
    }
}
