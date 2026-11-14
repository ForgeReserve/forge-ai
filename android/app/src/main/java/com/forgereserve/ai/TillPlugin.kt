package com.forgereserve.ai

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.KeyStore
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The till a Fedimint card pays through (slice A14; the page's side is public/v2/core/native.js
 * nativeTill and core/till.js). The till's address and its pay token are kept here, sealed with a key
 * in the Android Keystore, and the token is added to each request on this side: once paired, the page
 * never holds it. Only the pay routes are sent (TillRules.allowed), and the card link is opened with
 * the token as its bearer; each card command that comes down the link goes to the page, which asks
 * the card (ForgeNfc) and gives the answer back. Nothing here is logged.
 *
 * Every request runs on its own thread: POST /v1/pay waits up to 120 s at the till, and the card's
 * commands must keep flowing while it does.
 */
@CapacitorPlugin(name = "ForgeTill")
class TillPlugin : Plugin() {
    private val pool = Executors.newCachedThreadPool()
    private val links = ConcurrentHashMap<Int, TillLink>()

    private fun store() = TillStore(context)

    @PluginMethod
    fun status(call: PluginCall) {
        val p = store().pairing
        call.resolve(JSObject().put("paired", p != null).put("url", p?.url))
    }

    /** {text}: a scanned pay code. Resolves {url}; rejects with code pos, insecure or invalid. */
    @PluginMethod
    fun pair(call: PluginCall) {
        when (val r = TillRules.parsePairing(call.getString("text"))) {
            is TillRules.Parsed.Ok -> {
                closeLinks()
                store().pairing = r.pairing
                call.resolve(JSObject().put("url", r.pairing.url))
            }
            is TillRules.Parsed.No -> call.reject("This is not a till's pay code.", r.why.name.lowercase())
        }
    }

    /** Forgets the till: its address, its token and the key that sealed them. */
    @PluginMethod
    fun forget(call: PluginCall) {
        closeLinks()
        store().forget()
        call.resolve()
    }

    /** {method, path, link?, body?, timeoutMs} to {status, body}: one request to the paired till. */
    @PluginMethod
    fun request(call: PluginCall) {
        val method = call.getString("method")
        val path = call.getString("path")
        if (!TillRules.allowed(method, path)) return call.reject("Not a request this app sends to a till.", "not_allowed")
        val link = call.getString("link")
        if (link != null && !TillRules.linkId(link)) return call.reject("Not a card link.", "bad_link")
        val body = call.getString("body")
        val timeout = TillRules.timeout(call.getInt("timeoutMs"))
        val p = store().pairing ?: return call.reject("No till is set.", "not_paired")
        pool.execute {
            try {
                val c = URL(p.url + path).openConnection() as HttpURLConnection
                c.requestMethod = method
                c.connectTimeout = TillRules.CONNECT_MS
                c.readTimeout = timeout
                c.useCaches = false
                c.instanceFollowRedirects = false
                c.setRequestProperty("Authorization", "Bearer ${p.token}")
                c.setRequestProperty("Accept", "application/json")
                if (link != null) c.setRequestProperty("X-Card-Link", link)
                if (body != null) {
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", "application/json")
                    c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = c.responseCode
                val text = (if (status >= 400) c.errorStream else c.inputStream)?.use { readCapped(it) } ?: ""
                c.disconnect()
                call.resolve(JSObject().put("status", status).put("body", text))
            } catch (e: SocketTimeoutException) {
                call.reject("The till did not answer in time.", "timeout")
            } catch (e: IOException) {
                call.reject("The till could not be reached.", "unreachable")
            }
        }
    }

    /** {sock}: opens the card link. Resolves {sock, link}; then "apdu" {sock, id, apdu} and "closed" {sock}. */
    @PluginMethod
    fun linkOpen(call: PluginCall) {
        val sock = call.getInt("sock") ?: return call.reject("No link number.", "bad_link")
        val p = store().pairing ?: return call.reject("No till is set.", "not_paired")
        pool.execute {
            try {
                val link = TillLink.open(
                    p.url,
                    p.token,
                    onApdu = { id, apdu -> notifyListeners("apdu", JSObject().put("sock", sock).put("id", id).put("apdu", apdu)) },
                    onClosed = {
                        links.remove(sock)
                        notifyListeners("closed", JSObject().put("sock", sock))
                    },
                )
                links[sock] = link
                if (link.closed) links.remove(sock)
                call.resolve(JSObject().put("sock", sock).put("link", link.id))
            } catch (e: LinkRefused) {
                call.reject("The till refused this phone.", if (e.status == 401) "unauthorized" else if (e.status == 403) "forbidden" else "refused")
            } catch (e: IOException) {
                call.reject("The till could not be reached.", "unreachable")
            }
        }
    }

    /** {sock, type: rapdu or lost, id, rapdu?}: the page's answer to one card command. */
    @PluginMethod
    fun linkSend(call: PluginCall) {
        val link = call.getInt("sock")?.let { links[it] } ?: return call.reject("The link is closed.", "link_closed")
        val frame = TillRules.answerFrame(call.getString("type"), call.getLong("id"), call.getString("rapdu")) ?: return call.reject("Not an answer.", "bad_frame")
        pool.execute { link.answer(frame) }
        call.resolve()
    }

    @PluginMethod
    fun linkClose(call: PluginCall) {
        val link = call.getInt("sock")?.let { links.remove(it) }
        if (link != null) pool.execute { link.close() }
        call.resolve()
    }

    private fun closeLinks() {
        val all = links.values.toList()
        links.clear()
        pool.execute { all.forEach { it.close() } }
    }

    override fun handleOnDestroy() {
        closeLinks()
        super.handleOnDestroy()
    }

    private fun readCapped(input: InputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > TillRules.MAX_BODY) throw IOException("the till's answer is too large")
        }
        return out.toString(Charsets.UTF_8.name())
    }
}

/** The paired till, sealed with AES-GCM under a key in the Android Keystore that never leaves the phone. */
class TillStore(context: Context) {
    private val prefs = context.getSharedPreferences("forge-till", Context.MODE_PRIVATE)

    var pairing: TillRules.Pairing?
        get() {
            val blob = prefs.getString("pairing", null) ?: return null
            val plain = try { open(blob) } catch (e: Exception) { return null } ?: return null
            val i = plain.indexOf('\n')
            if (i < 0) return null
            return TillRules.Pairing(plain.substring(0, i), plain.substring(i + 1))
        }
        set(v) {
            if (v == null) prefs.edit().remove("pairing").apply()
            else prefs.edit().putString("pairing", seal("${v.url}\n${v.token}")).apply()
        }

    fun forget() {
        prefs.edit().remove("pairing").commit()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        } catch (_: Exception) {}
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return Base64.getEncoder().encodeToString(c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }

    private fun open(blob: String): String? {
        val b = Base64.getDecoder().decode(blob)
        if (b.size < 13) return null
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
        return String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)
    }

    private companion object {
        const val ALIAS = "forge-till-pairing"
    }
}
