package com.forgereserve.ai

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRulesTest {
    // /proc/cpuinfo on the Galaxy A16 5G (Dimensity 6300: 6 Cortex-A55, 2 Cortex-A76), one core shown per kind.
    private val a16 = """
        processor	: 0
        Features	: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp
        processor	: 6
        Features	: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp
    """.trimIndent()

    @Test
    fun runsOnlyWhereEveryCoreHasTheDotProductAndHalfFloats() {
        assertTrue(VoiceRules.cpuOk(a16))
        // Cortex-A53 (ARMv8.0): no dotprod, no fp16. The library would crash there.
        assertFalse(VoiceRules.cpuOk("processor\t: 0\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid"))
        // One core of another kind without them is enough to refuse.
        assertFalse(VoiceRules.cpuOk(a16 + "\nprocessor\t: 7\nFeatures\t: fp asimd asimddp"))
        assertFalse(VoiceRules.cpuOk(""))
    }

    @Test
    fun findsTheFastCores() {
        val freqs = listOf(2002000L, 2002000L, 2002000L, 2002000L, 2002000L, 2002000L, 2400000L, 2400000L)
        assertEquals(listOf(6, 7), VoiceRules.bigCores(freqs))
        assertEquals(emptyList<Int>(), VoiceRules.bigCores(List(8) { 1800000L }))
        assertEquals(emptyList<Int>(), VoiceRules.bigCores(listOf(2400000L, null)))
        assertEquals(emptyList<Int>(), VoiceRules.bigCores(emptyList()))
    }

    @Test
    fun choosesThreadsAndPinsThemToTheFastCoresWhenTheyFit() {
        val big = listOf(6, 7)
        assertEquals(VoiceRules.defaultThreads(8, big), VoiceRules.threads(0, 8, big))
        assertEquals(VoiceRules.defaultThreads(8, big), VoiceRules.threads(null, 8, big))
        assertEquals(6, VoiceRules.threads(6, 8, big))
        assertEquals(8, VoiceRules.threads(12, 8, big))
        assertArrayEquals(intArrayOf(6, 7), VoiceRules.pinFor(2, big))
        assertNull(VoiceRules.pinFor(4, big))
        assertNull(VoiceRules.pinFor(2, emptyList()))
        // A phone of one kind of core: 4 threads, never more than it has.
        assertEquals(4, VoiceRules.defaultThreads(8, emptyList()))
        assertEquals(2, VoiceRules.defaultThreads(2, emptyList()))
    }

    @Test
    fun laysTheBundledModelOutAsACheckpointFolder() {
        val copies = VoiceRules.modelCopies(
            "public/v2/voice/phonon",
            "31m-en-92741c5/model.q8.gguf",
            "31m-en-92741c5/tokenizer.json",
            "31m-en-92741c5/config.json",
            listOf(VoiceRules.Voice("Maeve", "voices-0ee1720/6PWnV0Nq4wu7RVBT.safetensors", 256136), VoiceRules.Voice("Maëlys", "voices-0ee1720/s048cR1l2Jmu4k3B.safetensors", 256136)),
            mapOf("31m-en-92741c5/model.q8.gguf" to 60_000_000L, "31m-en-92741c5/config.json" to 900L),
        )
        assertEquals(listOf("config.json", "tokenizer.json", "model.q8.gguf", "voices/Maeve.safetensors", "voices/Maëlys.safetensors"), copies.map { it.path })
        assertEquals("public/v2/voice/phonon/31m-en-92741c5/model.q8.gguf", copies[2].asset)
        assertEquals(listOf(900L, -1L, 60_000_000L, 256136L, 256136L), copies.map { it.size })
    }

    @Test
    fun refusesAPathOrNameThatCouldLeaveTheFolder() {
        val v = { name: String, file: String -> listOf(VoiceRules.Voice(name, file, 1)) }
        val ok = "voices-0ee1720/a.safetensors"
        assertThrows(IllegalArgumentException::class.java) { VoiceRules.modelCopies("b", "../model.q8.gguf", "a/t.json", "a/c.json", emptyList(), emptyMap()) }
        assertThrows(IllegalArgumentException::class.java) { VoiceRules.modelCopies("b", "a/m.gguf", "a/t.json", "a/c.json", v("../../x", ok), emptyMap()) }
        assertThrows(IllegalArgumentException::class.java) { VoiceRules.modelCopies("b", "a/m.gguf", "a/t.json", "a/c.json", v("a/b", ok), emptyMap()) }
        assertThrows(IllegalArgumentException::class.java) { VoiceRules.modelCopies("b", "a/m.gguf", "a/t.json", "a/c.json", v("Maeve", ok) + v("maeve", ok), emptyMap()) }
        assertThrows(IllegalArgumentException::class.java) { VoiceRules.modelCopies("b", "a/m.gguf", "a/t.json", "a/c.json", v("Maeve", "voices/../../x"), emptyMap()) }
        assertEquals("phonon-92741c5b07d0", VoiceRules.folderFor("92741c5b07d085ff840e26fea8ce43110b87852f"))
        assertThrows(IllegalArgumentException::class.java) { VoiceRules.folderFor("../x") }
    }

    @Test
    fun readsTextAsUtf8WithNoNul() {
        assertEquals("Thanh Hương 🎉", VoiceRules.textBytes("Thanh Hương 🎉").decodeToString())
        assertEquals("a b", VoiceRules.textBytes("a\u0000b").decodeToString())
    }

    @Test
    fun knowsWhichLibrariesTheAppWasInstalledWith() {
        assertTrue(VoiceRules.arm64Libs("/data/app/~~x/com.forgereserve.ai-y/lib/arm64"))
        assertFalse(VoiceRules.arm64Libs("/data/app/~~x/com.forgereserve.ai-y/lib/x86_64"))
        assertFalse(VoiceRules.arm64Libs("/data/app/~~x/com.forgereserve.ai-y/lib/arm"))
        assertFalse(VoiceRules.arm64Libs(null))
    }

    @Test
    fun keepsOnlyLabResultsByTheLabsOwnNames() {
        assertTrue(VoiceRules.labName("forge-voice-lab-2026-11-14T18-00-00-000Z.json"))
        assertFalse(VoiceRules.labName("../forge-voice-lab-1.json"))
        assertFalse(VoiceRules.labName("forge-voice-lab-1.json/x"))
        assertFalse(VoiceRules.labName("notes.json"))
    }

    @Test
    fun startsALabRunFromAdbOnlyInTheFormItTakes() {
        val js = LabAuto.script("native:10")!!
        assertTrue(js.startsWith("window.__forgeLabAuto={candidates:'native',lines:10,play:false};"))
        assertTrue(LabAuto.script("native:3:play")!!.startsWith("window.__forgeLabAuto={candidates:'native',lines:3,play:true};"))
        assertTrue(js.contains("location.hash='#/voice-lab'"))
        assertTrue(LabAuto.script("native-2,native-4:3")!!.startsWith("window.__forgeLabAuto={candidates:['native-2','native-4'],lines:3,play:false};"))
        assertNull(LabAuto.script(null))
        assertNull(LabAuto.script("native"))
        assertNull(LabAuto.script("native:10');alert(1)//"))
        assertNull(LabAuto.script("NATIVE:10"))
    }
}
