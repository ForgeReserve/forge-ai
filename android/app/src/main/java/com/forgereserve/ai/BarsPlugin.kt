package com.forgereserve.ai

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The phone's status and navigation bars in the page's colour, as a browser keeps them its theme-color:
 * dark with light icons on Midnight and the first run, light with dark icons on the Light look. The
 * app starts with Midnight's (res/values/colors.xml forge_bg). The page's side is public/v2/core/native.js
 * (followBars).
 */
@CapacitorPlugin(name = "ForgeBars")
class BarsPlugin : Plugin() {
    /** Sets the bars: {color: "#RRGGBB"}. */
    @PluginMethod
    fun set(call: PluginCall) {
        val bars = BarRules.forColor(call.getString("color")) ?: return call.reject("Not a colour.", "bad_color")
        activity.runOnUiThread {
            (bridge.webView.parent as? View)?.let { Edge.paint(activity, it, bars) }
            call.resolve()
        }
    }
}

/**
 * The app drawn edge to edge on every Android version, as Android 15 and up require of an app that
 * targets them (the opt-out is gone at API 36). The bars are see-through; the web view's frame is
 * padded by the bars, the camera cutout and the keyboard (BarRules.room) and painted in the page's
 * colour, so the bars show that colour and the page never sits under them. The insets stop at the
 * frame: the web view gets none, so the page's env(safe-area-inset-*) stay 0 as before, and its own
 * safe-area padding adds nothing on top.
 */
object Edge {
    /** Once, from MainActivity.onCreate, with the web view's parent and the start colour. */
    fun fit(activity: Activity, frame: View, start: BarRules.Bars) {
        val window = activity.window
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) {
            // No grey scrim over three-button navigation: the bar is the page's colour, as before.
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        // Into the cutout on the short edges too (landscape), where the frame's padding keeps the page clear
        // of it; Android 15 and up do this whatever is set.
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        paint(activity, frame, start)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            fun edges(types: Int) = insets.getInsets(types).let { BarRules.Edges(it.left, it.top, it.right, it.bottom) }
            val room = BarRules.room(
                bars = edges(WindowInsetsCompat.Type.systemBars()),
                cutout = edges(WindowInsetsCompat.Type.displayCutout()),
                keyboard = edges(WindowInsetsCompat.Type.ime()),
            )
            v.setPadding(room.left, room.top, room.right, room.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(frame)
    }

    /** The bars' colour (the frame's, which shows through them) and their icons. */
    fun paint(activity: Activity, frame: View, bars: BarRules.Bars) {
        frame.setBackgroundColor(bars.argb)
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
            isAppearanceLightStatusBars = bars.darkIcons
            isAppearanceLightNavigationBars = bars.darkIcons
        }
    }
}
