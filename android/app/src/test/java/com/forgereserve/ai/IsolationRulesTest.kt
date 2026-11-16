package com.forgereserve.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IsolationRulesTest {
    @Test
    fun isolatesTheAppsOwnFiles() {
        val h = IsolationRules.headersFor("https", "localhost", "https", "localhost")
        assertEquals("same-origin", h["Cross-Origin-Opener-Policy"])
        assertEquals("require-corp", h["Cross-Origin-Embedder-Policy"])
        assertEquals("same-origin", h["Cross-Origin-Resource-Policy"])
        assertEquals(h, IsolationRules.headersFor("HTTPS", "LocalHost", "https", "localhost"))
    }

    @Test
    fun leavesEverythingElseAlone() {
        assertTrue(IsolationRules.headersFor("https", "ai.forge-reserve.com", "https", "localhost").isEmpty())
        assertTrue(IsolationRules.headersFor("http", "localhost", "https", "localhost").isEmpty())
        assertTrue(IsolationRules.headersFor(null, null, "https", "localhost").isEmpty())
    }

    @Test
    fun replacesHeadersOfTheSameNameAndKeepsTheRest() {
        val merged = IsolationRules.merge(
            mapOf("Content-Type" to "text/html", "cross-origin-embedder-policy" to "unsafe-none"),
            IsolationRules.HEADERS,
        )
        assertEquals("text/html", merged["Content-Type"])
        assertEquals("require-corp", merged["Cross-Origin-Embedder-Policy"])
        assertEquals(4, merged.size)
        assertEquals(IsolationRules.HEADERS, IsolationRules.merge(null, IsolationRules.HEADERS))
    }
}
