package com.forgereserve.ai

/**
 * The colour of the phone's status and navigation bars, from the page's colour (its theme-color: the
 * look's ground, or the first run's dark one), and the room the page leaves for them. Plain Kotlin with no
 * Android types, so the JVM unit tests cover it (app/src/test).
 */
object BarRules {
    /** Pixels on each side of the screen: what a bar, the camera cutout or the keyboard covers, or the room left for them. */
    data class Edges(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        companion object {
            val NONE = Edges(0, 0, 0, 0)
        }
    }

    /**
     * The room the web view leaves on each side, so no part of the page sits under the status bar, the
     * navigation bar, the camera cutout or the keyboard (Android 15 and up draw every app edge to edge).
     * The keyboard's height is counted from the bottom of the screen, so it already covers the navigation
     * bar: the bottom is the larger of the two, never their sum. The page resizes to what is left
     * (interactive-widget=resizes-content), as it did when Android made that room itself.
     */
    fun room(bars: Edges, cutout: Edges, keyboard: Edges): Edges = Edges(
        left = maxOf(bars.left, cutout.left),
        top = maxOf(bars.top, cutout.top),
        right = maxOf(bars.right, cutout.right),
        bottom = maxOf(bars.bottom, cutout.bottom, keyboard.bottom),
    )

    /** The bars for a colour: its ARGB value, and whether the icons on it are dark (a light colour). */
    data class Bars(val argb: Int, val darkIcons: Boolean)

    /** Bars for a plain hex colour (#RGB or #RRGGBB), or null for anything else. */
    fun forColor(hex: String?): Bars? {
        val m = Regex("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$").matchEntire(hex?.trim() ?: return null) ?: return null
        val h = m.groupValues[1].let { if (it.length == 3) it.map { c -> "$c$c" }.joinToString("") else it }
        return forRgb(h.toInt(16))
    }

    /** Bars for a colour given as 0xRRGGBB (an alpha byte, as in an Android colour resource, is ignored). */
    fun forRgb(color: Int): Bars {
        val rgb = color and 0xFFFFFF
        val lum = luminance((rgb shr 16) and 0xFF, (rgb shr 8) and 0xFF, rgb and 0xFF)
        // Dark icons where they read better than light ones: the colour's contrast with black beats its
        // contrast with white (WCAG relative luminance).
        val darkIcons = (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05)
        return Bars((0xFF shl 24) or rgb, darkIcons)
    }

    private fun luminance(r: Int, g: Int, b: Int): Double {
        fun ch(v: Int): Double {
            val c = v / 255.0
            return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    }
}
