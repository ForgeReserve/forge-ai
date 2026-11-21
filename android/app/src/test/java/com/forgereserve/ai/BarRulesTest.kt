package com.forgereserve.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BarRulesTest {
    @Test
    fun midnightAndTheFirstRunGetDarkBarsWithLightIcons() {
        assertEquals(BarRules.Bars(0xFF0B0D10.toInt(), darkIcons = false), BarRules.forColor("#0B0D10"))
        // The Dark look too.
        assertEquals(false, BarRules.forColor("#161B24")?.darkIcons)
    }

    @Test
    fun theLightLookGetsLightBarsWithDarkIcons() {
        assertEquals(BarRules.Bars(0xFFF6F5F1.toInt(), darkIcons = true), BarRules.forColor("#F6F5F1"))
        assertEquals(true, BarRules.forColor("#fff")?.darkIcons)
        assertEquals(0xFFFFFFFF.toInt(), BarRules.forColor(" #FFF ")?.argb)
    }

    @Test
    fun theStartColourFromItsResourceIsMidnights() {
        // R.color.forge_bg as Android gives it, alpha byte included.
        assertEquals(BarRules.forColor("#0B0D10"), BarRules.forRgb(0xFF0B0D10.toInt()))
        assertEquals(BarRules.Bars(0xFFF6F5F1.toInt(), darkIcons = true), BarRules.forRgb(0x00F6F5F1))
    }

    private val none = BarRules.Edges.NONE

    @Test
    fun thePageIsKeptClearOfTheStatusAndNavigationBars() {
        // Portrait, gesture navigation: status bar on top, the handle's bar at the bottom.
        val bars = BarRules.Edges(0, 136, 0, 63)
        assertEquals(bars, BarRules.room(bars, none, none))
        // Three-button navigation in landscape: the bar is on the side.
        val side = BarRules.Edges(0, 63, 126, 0)
        assertEquals(side, BarRules.room(side, none, none))
    }

    @Test
    fun andOfTheCameraCutoutWhereItReachesFurther() {
        val bars = BarRules.Edges(0, 63, 126, 0)
        // Landscape with the cutout on the left, where no bar is.
        assertEquals(BarRules.Edges(126, 63, 126, 0), BarRules.room(bars, BarRules.Edges(126, 0, 0, 0), none))
        // A tall cutout inside the status bar changes nothing; a taller one wins.
        assertEquals(BarRules.Edges(0, 136, 0, 63), BarRules.room(BarRules.Edges(0, 136, 0, 63), BarRules.Edges(0, 120, 0, 0), none))
        assertEquals(BarRules.Edges(0, 150, 0, 63), BarRules.room(BarRules.Edges(0, 136, 0, 63), BarRules.Edges(0, 150, 0, 0), none))
    }

    @Test
    fun theKeyboardTakesTheBottomAndAlreadyHoldsTheNavigationBar() {
        val bars = BarRules.Edges(0, 136, 0, 63)
        // The keyboard's inset runs from the bottom of the screen, so it already holds the navigation bar.
        assertEquals(BarRules.Edges(0, 136, 0, 885), BarRules.room(bars, none, BarRules.Edges(0, 0, 0, 885)))
        // Closed again: back to the navigation bar.
        assertEquals(bars, BarRules.room(bars, none, none))
        // Only the keyboard's bottom counts.
        assertEquals(bars, BarRules.room(bars, none, BarRules.Edges(40, 40, 40, 0)))
    }

    @Test
    fun takesOnlyPlainHexColours() {
        for (bad in listOf(null, "", "red", "#12", "#12345", "#1234567", "rgb(0,0,0)", "#GGGGGG", "0B0D10")) assertNull(bad, BarRules.forColor(bad))
    }
}
