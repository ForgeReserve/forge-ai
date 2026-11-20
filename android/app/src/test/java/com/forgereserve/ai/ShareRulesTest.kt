package com.forgereserve.ai

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
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

class ShareStageTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val b64 = Base64.getEncoder()

    private fun dir() = File(tmp.root, ShareStage.DIR)

    private fun code(f: () -> Unit): String? = try {
        f()
        null
    } catch (e: StageError) {
        e.code
    }

    @Test
    fun stagesAFileInPiecesAndHandsBackAllOfIt() {
        val stage = ShareStage(dir())
        val photo = ByteArray(ShareStage.CHUNK_BYTES * 2 + 1000) { (it * 7).toByte() }
        val token = stage.start(photo.size.toLong())
        assertTrue(token, Regex("^[0-9a-f]{32}$").matches(token))
        var at = 0
        while (at < photo.size) {
            val end = minOf(at + ShareStage.CHUNK_BYTES, photo.size)
            assertEquals(end.toLong(), stage.append(token, b64.encodeToString(photo.copyOfRange(at, end))))
            at = end
        }
        val file = stage.take(token)
        assertArrayEquals(photo, file.readBytes())
        // Once taken it takes no more pieces, and stays for the save until dropped.
        assertEquals("no_file", code { stage.append(token, b64.encodeToString(byteArrayOf(1))) })
        assertEquals(file, stage.taken(token))
        stage.drop(token)
        assertNull(stage.taken(token))
        assertFalse(file.exists())
    }

    @Test
    fun aPieceIsWholeBase64OfAQuarterMegabyte() {
        assertEquals(0, ShareStage.CHUNK_BYTES % 3)
        val piece = b64.encodeToString(ByteArray(ShareStage.CHUNK_BYTES))
        assertEquals(256 * 1024, piece.length)
        assertFalse(piece.endsWith("="))
        assertEquals(ShareStage.CHUNK_BYTES, ShareOut.decode(piece, ShareStage.CHUNK_BYTES)!!.size)
    }

    @Test
    fun refusesAnEmptyOrTooLargeFile() {
        val stage = ShareStage(dir())
        assertEquals("bad_file", code { stage.start(0) })
        assertEquals("too_big", code { stage.start(ShareOut.MAX_BYTES + 1L) })
        stage.start(ShareOut.MAX_BYTES.toLong())
    }

    @Test
    fun refusesABadOrOversizedPieceAndDropsTheFile() {
        val stage = ShareStage(dir())
        val a = stage.start(10)
        assertEquals("bad_file", code { stage.append(a, "not base64 !!") })
        assertNull(stage.taken(a))
        assertEquals("no_file", code { stage.append(a, b64.encodeToString(byteArrayOf(1))) })
        val big = stage.start(ShareOut.MAX_BYTES.toLong())
        assertEquals("bad_file", code { stage.append(big, b64.encodeToString(ByteArray(ShareStage.CHUNK_BYTES + 3))) })
        assertNull(stage.taken(big))
    }

    @Test
    fun refusesMoreOrLessThanTheFileSaidItHas() {
        val stage = ShareStage(dir())
        val long = stage.start(4)
        stage.append(long, b64.encodeToString(byteArrayOf(1, 2, 3)))
        assertEquals("bad_file", code { stage.append(long, b64.encodeToString(byteArrayOf(4, 5))) })
        assertNull(stage.taken(long))
        val short = stage.start(4)
        stage.append(short, b64.encodeToString(byteArrayOf(1, 2, 3)))
        assertEquals("bad_file", code { stage.take(short) })
        assertNull(stage.taken(short))
    }

    @Test
    fun knowsOnlyItsOwnTokens() {
        val stage = ShareStage(dir())
        stage.start(1)
        for (t in listOf(null, "", "../../shared-out/x", "ABCDEF0123456789ABCDEF0123456789", "0".repeat(31), "0".repeat(33))) {
            assertNull(ShareStage.token(t))
            assertEquals("no_file", code { stage.append(t, b64.encodeToString(byteArrayOf(1))) })
            assertEquals("no_file", code { stage.take(t) })
            assertNull(stage.taken(t))
        }
        // A well formed token this stage never made.
        assertEquals("no_file", code { stage.take("0".repeat(32)) })
        assertEquals("0".repeat(32), ShareStage.token("0".repeat(32)))
    }

    @Test
    fun startingAnotherClearsOldFilesButKeepsTheOneBeingSaved() {
        val stage = ShareStage(dir())
        val saving = stage.start(1)
        stage.append(saving, b64.encodeToString(byteArrayOf(9)))
        stage.take(saving)
        // A file left half staged (the page went away), and a stray one.
        val abandoned = stage.start(5, keep = saving)
        File(dir(), "stray").writeText("x")
        val next = stage.start(1, keep = saving)
        assertEquals(setOf(saving, next), dir().list()!!.toSet())
        assertNull(stage.taken(abandoned))
        assertArrayEquals(byteArrayOf(9), stage.taken(saving)!!.readBytes())
        // Without keep, the file being saved goes too.
        stage.start(1)
        assertNull(stage.taken(saving))
    }

    @Test
    fun theNextStartOfTheAppClearsAllButTheFileOfASaveStillOpen() {
        // A new run of the app knows only the token it got back from the saved state.
        dir().mkdirs()
        val saving = "a".repeat(32)
        File(dir(), saving).writeBytes(byteArrayOf(9))
        File(dir(), "b".repeat(32)).writeBytes(byteArrayOf(1))
        val again = ShareStage(dir())
        again.sweep(keep = saving)
        assertEquals(setOf(saving), dir().list()!!.toSet())
        assertArrayEquals(byteArrayOf(9), again.taken(saving)!!.readBytes())
        again.sweep()
        assertEquals(0, dir().list()!!.size)
    }

    @Test
    fun keepsStagedFilesOutOfWhatTheShareSheetMayHandOut() {
        // The FileProvider's cache folders (unit tests run in android/app): none of them holds the staged files.
        val paths = File("src/main/res/xml/file_paths.xml").readText()
        val cache = Regex("""<cache-path[^>]*path="([^"]*)"""").findAll(paths).map { it.groupValues[1] }.toList()
        assertEquals(listOf("${ShareOut.DIR}/"), cache)
        assertFalse("${ShareStage.DIR}/".startsWith(cache.single()))
    }
}

class BackRuleTest {
    @Test
    fun goesBackThroughTheScreensThenLeaves() {
        assertEquals(BackRule.Step.WEB_BACK, BackRule.step(canGoBack = true))
        assertEquals(BackRule.Step.LEAVE, BackRule.step(canGoBack = false))
    }
}
