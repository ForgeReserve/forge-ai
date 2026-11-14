package com.forgereserve.ai

import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.IOException

/**
 * Card taps (slice A13): IsoDep on the phone's NFC reader, for the page's card protocol
 * (public/v2/core/card/apdu.js and core/native.js). connect, transceive and close, nothing more. The
 * page builds every command; this side checks each is one well formed short APDU (NfcRules) and hands
 * back the card's whole answer. Each command has 5 seconds on the card.
 *
 * Reading is on only while the page asks for it (start, stop): the card screen. Each card that comes
 * into the field gets a number; a command for a card that has gone, or for an earlier card, is refused,
 * so it can never reach a different card. Nothing is stored and nothing goes anywhere but the page.
 */
@CapacitorPlugin(name = "ForgeNfc")
class NfcPlugin : Plugin() {
    private var current: IsoDep? = null
    private var currentId = 0
    private var reading = false

    @PluginMethod
    fun status(call: PluginCall) {
        val adapter = NfcAdapter.getDefaultAdapter(context)
        call.resolve(JSObject().put("available", adapter != null).put("enabled", adapter?.isEnabled == true))
    }

    /** Turns reading on. Each card that comes into the field is connected and announced as "card" {id}. */
    @PluginMethod
    fun start(call: PluginCall) {
        val adapter = NfcAdapter.getDefaultAdapter(context) ?: return call.reject("This phone cannot read cards.", "no_nfc")
        if (!adapter.isEnabled) return call.reject("NFC is off.", "nfc_off")
        reading = true
        activity.runOnUiThread {
            adapter.enableReaderMode(
                activity,
                { tag -> found(tag) },
                NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                    NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
                null,
            )
            call.resolve()
        }
    }

    private fun found(tag: Tag) {
        val iso = IsoDep.get(tag) ?: return notifyListeners("card", JSObject().put("id", 0).put("isoDep", false))
        synchronized(this) {
            closeCurrent()
            try {
                iso.connect()
                iso.timeout = NfcRules.TIMEOUT_MS
            } catch (e: IOException) {
                return
            }
            current = iso
            currentId += 1
        }
        notifyListeners("card", JSObject().put("id", currentId).put("isoDep", true))
    }

    /** {id, apdu (hex)} to {data (hex)}: the card's answer, status word included. */
    @PluginMethod
    fun transceive(call: PluginCall) {
        val apdu = NfcRules.apdu(call.getString("apdu")) ?: return call.reject("Not a command a card can take.", "bad_apdu")
        val id = call.getInt("id") ?: 0
        val iso = synchronized(this) { if (id == currentId) current else null } ?: return call.reject("The card is gone.", "tag_gone")
        try {
            val answer = NfcRules.answer(iso.transceive(apdu)) ?: return call.reject("The card gave no answer.", "short_answer")
            call.resolve(JSObject().put("data", answer))
        } catch (e: IOException) {
            // TagLostException is an IOException: the card left the field, or took over 5 seconds.
            synchronized(this) { if (id == currentId) closeCurrent() }
            call.reject("The card left the phone.", "tag_lost")
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        synchronized(this) { closeCurrent() }
        call.resolve()
    }

    /** Turns reading off and lets go of the card. */
    @PluginMethod
    fun stop(call: PluginCall) {
        synchronized(this) { closeCurrent() }
        reading = false
        val adapter = NfcAdapter.getDefaultAdapter(context)
        activity.runOnUiThread {
            adapter?.disableReaderMode(activity)
            call.resolve()
        }
    }

    private fun closeCurrent() {
        try {
            current?.close()
        } catch (e: IOException) {
            // Already gone.
        }
        current = null
    }

    override fun handleOnPause() {
        // Reader mode belongs to the screen in front; Android drops it when the app leaves the front.
        NfcAdapter.getDefaultAdapter(context)?.disableReaderMode(activity)
        super.handleOnPause()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        if (!reading) return
        NfcAdapter.getDefaultAdapter(context)?.takeIf { it.isEnabled }?.enableReaderMode(
            activity,
            { tag -> found(tag) },
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
            null,
        )
    }
}
