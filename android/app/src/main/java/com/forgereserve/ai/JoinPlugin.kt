package com.forgereserve.ai

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * An event link that opened the app (https://ai.forge-reserve.com/j#<pass>, JoinRules): its pass is kept
 * in memory only and handed to the page once (take), which opens a free balance with it. The page's side
 * is public/v2/core/native.js (join) and app.js joinWith. Nothing is sent anywhere from here.
 */
@CapacitorPlugin(name = "ForgeJoin")
class JoinPlugin : Plugin() {
    @Volatile
    private var pass: String? = null

    // BridgeActivity hands every plugin the launch intent once the bridge is up (a cold start on the
    // link), and each new intent after (the app was running: MainActivity is singleTask).
    override fun handleOnNewIntent(intent: Intent) {
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        pass = JoinRules.passFrom(intent.action, intent.dataString, fromHistory) ?: return
        // Taken: a re-created screen must not use the same pass again.
        activity?.intent = Intent(Intent.ACTION_MAIN)
        notifyListeners("join", JSObject())
    }

    /** Hands the waiting pass to the page and forgets it: {pass}, or {} when there is none. */
    @PluginMethod
    fun take(call: PluginCall) {
        val p = pass
        pass = null
        call.resolve(if (p != null) JSObject().put("pass", p) else JSObject())
    }

    /** Drops a waiting pass unused (Erase everything). */
    @PluginMethod
    fun clear(call: PluginCall) {
        pass = null
        call.resolve()
    }
}
