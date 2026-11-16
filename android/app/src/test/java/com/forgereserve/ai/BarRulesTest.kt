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
    fun takesOnlyPlainHexColours() {
        for (bad in listOf(null, "", "red", "#12", "#12345", "#1234567", "rgb(0,0,0)", "#GGGGGG", "0B0D10")) assertNull(bad, BarRules.forColor(bad))
    }
}
