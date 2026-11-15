package com.forgereserve.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JoinRulesTest {
    private val view = JoinRules.ACTION_VIEW
    private val pass = "pass-AbC_123-xyz0Q9wE"

    @Test
    fun takesThePassFromAnEventLink() {
        assertEquals(pass, JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#$pass", fromHistory = false))
        assertEquals(pass, JoinRules.passFrom(view, "https://ai.forge-reserve.com/j/#$pass", fromHistory = false))
        // The web app's own form of the fragment.
        assertEquals(pass, JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#join=$pass", fromHistory = false))
        assertEquals(pass, JoinRules.passFrom(view, "HTTPS://AI.Forge-Reserve.com/j#$pass", fromHistory = false))
    }

    @Test
    fun takesWhatTheJPagesIntentLinkHandsOver() {
        // Intent.parseUri("intent://ai.forge-reserve.com/j#<pass>#Intent;scheme=https;package=...;end")
        // cuts at the last '#' and puts the scheme back: this is the data the app receives.
        val link = "intent://ai.forge-reserve.com/j#$pass#Intent;scheme=https;package=com.forgereserve.ai;end"
        val data = "https:" + link.substring("intent:".length, link.lastIndexOf('#'))
        assertEquals(pass, JoinRules.passFrom(view, data, fromHistory = false))
    }

    @Test
    fun ignoresAnythingElse() {
        assertNull(JoinRules.passFrom("android.intent.action.MAIN", null, fromHistory = false))
        assertNull(JoinRules.passFrom(view, null, fromHistory = false))
        // Recent apps hands back the old link: its pass was taken the first time.
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#$pass", fromHistory = true))
        // No pass, another page, another host, plain http, a pass that is not one.
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/j", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/download#$pass", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/jj#$pass", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://evil.example/j#$pass", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com.evil.example/j#$pass", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "http://ai.forge-reserve.com/j#$pass", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#short", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#pass-%3Cscript%3E", fromHistory = false))
        assertNull(JoinRules.passFrom(view, "https://ai.forge-reserve.com/j#" + "a".repeat(129), fromHistory = false))
        assertNull(JoinRules.passFrom(view, "not a uri at all", fromHistory = false))
    }
}
