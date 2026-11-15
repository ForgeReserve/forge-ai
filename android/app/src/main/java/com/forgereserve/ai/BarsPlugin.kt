package com.forgereserve.ai

import androidx.core.view.WindowCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The phone's status and navigation bars in the page's colour, as a browser keeps them its theme-color:
 * dark with light icons on Midnight and the first run, light with dark icons on the Light look. The
 * app starts with Midnight's (res/values/styles.xml). The page's side is public/v2/core/native.js
 * (followBars).
 */
@CapacitorPlugin(name = "ForgeBars")
class BarsPlugin : Plugin() {
    /** Sets the bars: {color: "#RRGGBB"}. */
    @PluginMethod
    fun set(call: PluginCall) {
        val bars = BarRules.forColor(call.getString("color")) ?: return call.reject("Not a colour.", "bad_color")
        activity.runOnUiThread {
            val window = activity.window
            @Suppress("DEPRECATION")
            window.statusBarColor = bars.argb
            @Suppress("DEPRECATION")
            window.navigationBarColor = bars.argb
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = bars.darkIcons
                isAppearanceLightNavigationBars = bars.darkIcons
            }
            call.resolve()
        }
    }
}
