package com.forgereserve.ai

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.Base64

class ShareIntakeTest {
    private val send = ShareIntake.ACTION_SEND

    @Test
    fun takesAPhotoSharedIn() {
        assertEquals(ShareIntake.Decision.TAKE, ShareIntake.decide(send, "image/jpeg", hasStream = true, fromHistory = false))
        assertEquals(ShareIntake.Decision.TAKE, ShareIntake.decide(send, "IMAGE/PNG", hasStream = true, fromHistory = false))
    }

    @Test
    fun ignoresAnOrdinaryOpenAndAReopenFromRecentApps() {
        assertEquals(ShareIntake.Decision.IGNORE, ShareIntake.decide("android.intent.action.MAIN", null, hasStream = false, fromHistory = false))
        assertEquals(ShareIntake.Decision.IGNORE, ShareIntake.decide(null, null, hasStream = false, fromHistory = false))
        // Recent apps hands back the old share: the photo was taken the first time.
        assertEquals(ShareIntake.Decision.IGNORE, ShareIntake.decide(send, "image/jpeg", hasStream = true, fromHistory = true))
    }

    @Test
    fun saysNoPhotoForTextOrOtherFiles() {
        assertEquals(ShareIntake.Decision.NO_PHOTO, ShareIntake.decide(send, "text/plain", hasStream = false, fromHistory = false))
        assertEquals(ShareIntake.Decision.NO_PHOTO, ShareIntake.decide(send, "application/pdf", hasStream = true, fromHistory = false))
        assertEquals(ShareIntake.Decision.NO_PHOTO, ShareIntake.decide(send, "image/jpeg", hasStream = false, fromHistory = false))
        assertEquals(ShareIntake.Decision.NO_PHOTO, ShareIntake.decide(send, null, hasStream = true, fromHistory = false))
    }

    @Test
    fun readsUpToTheLimitAndRefusesMore() {
        val ten = ByteArray(10) { it.toByte() }
        assertArrayEquals(ten, ShareIntake.readBounded(ByteArrayInputStream(ten), max = 10))
        assertNull(ShareIntake.readBounded(ByteArrayInputStream(ByteArray(11)), max = 10))
        assertEquals(0, ShareIntake.readBounded(ByteArrayInputStream(ByteArray(0)), max = 10)!!.size)
    }

    @Test
    fun stopsReadingAnEndlessStream() {
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int = 0

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                served += len
                return len
            }
        }
        assertNull(ShareIntake.readBounded(endless, max = 1_000_000))
        assertTrue("read $served bytes", served < 1_200_000)
    }

    @Test
    fun knowsAnImageByItsBytesNotItsName() {
        fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
        assertEquals("image/jpeg", ShareIntake.sniff(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)))
        assertEquals("image/png", ShareIntake.sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)))
        assertEquals("image/webp", ShareIntake.sniff("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)))
        assertEquals("image/gif", ShareIntake.sniff("GIF89a".toByteArray()))
        assertNull(ShareIntake.sniff("RIFF\u0000\u0000\u0000\u0000WAVE".toByteArray(Charsets.ISO_8859_1)))
        assertNull(ShareIntake.sniff("%PDF-1.7".toByteArray()))
        assertNull(ShareIntake.sniff(bytes(0xff, 0xd8)))
        assertNull(ShareIntake.sniff(ByteArray(0)))
    }

    @Test
    fun encodesForThePage() {
        val b = byteArrayOf(1, 2, 3, -1)
        assertArrayEquals(b, Base64.getDecoder().decode(ShareIntake.encode(b)))
    }
}

class ShareOutTest {
    @Test
    fun sharesOnlyPhotoTypes() {
        assertEquals("image/jpeg", ShareOut.mime("image/jpeg"))
        assertEquals("image/png", ShareOut.mime(" Image/PNG "))
        assertNull(ShareOut.mime("text/html"))
        assertNull(ShareOut.mime("application/vnd.android.package-archive"))
        assertNull(ShareOut.mime(null))
    }

    @Test
    fun makesASafeFileName() {
        assertEquals("forge-photo.jpg", ShareOut.safeName("forge-photo.jpg", "image/jpeg"))
        assertEquals("passwd.jpg", ShareOut.safeName("../../etc/passwd", "image/jpeg"))
        assertEquals("evil.png", ShareOut.safeName("C:\\x\\evil.exe", "image/png"))
        assertEquals("c.jpg", ShareOut.safeName("a b/../c", "image/jpeg"))
        assertEquals("forge-photo.jpg", ShareOut.safeName("", "image/jpeg"))
        assertEquals("forge-photo.jpg", ShareOut.safeName(null, "image/jpeg"))
        assertEquals("forge-photo.webp", ShareOut.safeName("...", "image/webp"))
        assertEquals(60 + ".jpg".length, ShareOut.safeName("x".repeat(500), "image/jpeg").length)
        assertEquals("photo-2026.jpg", ShareOut.safeName("photo 2026!.png", "image/jpeg"))
    }

    @Test
    fun decodesTheFileAndRefusesBadOrHugeOnes() {
        val b = ByteArray(300) { it.toByte() }
        assertArrayEquals(b, ShareOut.decode(Base64.getEncoder().encodeToString(b)))
        assertNull(ShareOut.decode("not base64 !!"))
        assertNull(ShareOut.decode(""))
        assertNull(ShareOut.decode(null))
        assertNull(ShareOut.decode(Base64.getEncoder().encodeToString(ByteArray(101)), max = 100))
        assertArrayEquals(ByteArray(99), ShareOut.decode(Base64.getEncoder().encodeToString(ByteArray(99)), max = 100))
        // A string far longer than any allowed file is refused before it is decoded.
        assertNull(ShareOut.decode("A".repeat(1000), max = 100))
    }
}

class BackRuleTest {
    @Test
    fun goesBackThroughTheScreensThenLeaves() {
        assertEquals(BackRule.Step.WEB_BACK, BackRule.step(canGoBack = true))
        assertEquals(BackRule.Step.LEAVE, BackRule.step(canGoBack = false))
    }
}
