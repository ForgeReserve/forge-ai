import Foundation
import Capacitor
import CoreNFC

/// Card taps: ISO 7816 over the iPhone's NFC reader, for the page's card protocol
/// (public/v2/core/card/apdu.js and core/native.js). The same plugin as android/.../NfcPlugin.kt:
/// ForgeNfc with status, start, transceive, close and stop, the "card" event, the same answers and the
/// same error codes. The page builds every command; this side checks each is one well formed short APDU
/// (NfcRules) and hands back the card's whole answer. Each command has 5 seconds on the card.
///
/// What iOS changes: the phone reads only while its own NFC sheet is up, iOS opens the sheet only
/// when the app asks (start, after a press on the page), one sheet holds one card, and iOS ends a sheet
/// after about a minute. So start opens the sheet, and close (the page is done with the card) or stop
/// ends it; the sheet's words come from the page (start's hold, keep, done, lost, notCard, one).
///
/// Each card that is connected gets a number; a command for a card that has gone, or for an earlier
/// card, is refused, so it can never reach a different card. Nothing is stored, nothing from a card is
/// logged (only why a sheet ended), and nothing goes anywhere but the page.
@objc(NfcPlugin)
public class NfcPlugin: CAPPlugin, CAPBridgedPlugin, NFCTagReaderSessionDelegate {
    public let identifier = "NfcPlugin"
    public let jsName = "ForgeNfc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transceive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    /// Everything below is read and changed only on this queue, which is also the sheet's.
    private let queue = DispatchQueue(label: "com.forgereserve.ai.nfc")
    private var session: NFCTagReaderSession?
    private var current: NFCISO7816Tag?
    private var currentId = 0
    private var words = NfcRules.Words()

    /// {available, enabled}: both false on an iPhone that cannot read tags (and in the Simulator).
    /// An iPhone has no switch for NFC alone, so enabled is available.
    @objc func status(_ call: CAPPluginCall) {
        let on = NFCTagReaderSession.readingAvailable
        call.resolve(["available": on, "enabled": on])
    }

    /// Opens the NFC sheet. The card that is held to it is connected and announced as "card" {id}.
    /// A second start while the sheet is up keeps that sheet (iOS shows one at a time).
    @objc func start(_ call: CAPPluginCall) {
        guard NFCTagReaderSession.readingAvailable else { return call.reject("This phone cannot read cards.", "no_nfc") }
        let w = NfcRules.Words(call.jsObjectRepresentation)
        queue.async {
            self.words = w
            if let open = self.session {
                if self.current == nil { open.alertMessage = w.hold }
                return call.resolve()
            }
            guard let s = NFCTagReaderSession(pollingOption: .iso14443, delegate: self, queue: self.queue) else {
                return call.reject("This phone cannot read cards.", "no_nfc")
            }
            s.alertMessage = w.hold
            self.session = s
            s.begin()
            call.resolve()
        }
    }

    /// The sheet is up and the reader looks for a card. Nothing to do: start already said so.
    public func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    public func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard session === self.session else { return }
        guard tags.count == 1, let tag = tags.first else {
            session.alertMessage = words.one
            queue.asyncAfter(deadline: .now() + .milliseconds(500)) { if session === self.session { session.restartPolling() } }
            return
        }
        guard case let .iso7816(card) = tag else {
            // A tag with none of the card's applets (Info.plist select-identifiers): not an eCash card.
            notifyListeners("card", data: ["id": 0, "isoDep": false])
            return end(error: words.notCard)
        }
        session.connect(to: tag) { error in
            self.queue.async {
                guard session === self.session else { return }
                // A card that could not be connected is left, as on Android: the next one counts.
                if error != nil { return session.restartPolling() }
                self.current = card
                self.currentId += 1
                session.alertMessage = self.words.keep
                self.notifyListeners("card", data: ["id": self.currentId, "isoDep": true])
            }
        }
    }

    /// {id, apdu (hex)} to {data (hex)}: the card's answer, status word included.
    @objc func transceive(_ call: CAPPluginCall) {
        guard let bytes = NfcRules.apdu(call.getString("apdu")), let apdu = NFCISO7816APDU(data: bytes) else {
            return call.reject("Not a command a card can take.", "bad_apdu")
        }
        let id = call.getInt("id") ?? 0
        queue.async {
            guard id == self.currentId, let card = self.current, self.session != nil else { return call.reject("The card is gone.", "tag_gone") }
            let once = Once()
            let lost = {
                // The card left the field, or took over 5 seconds: the sheet ends, saying so.
                if id == self.currentId, self.current != nil { self.end(error: self.words.lost) }
                call.reject("The card left the phone.", "tag_lost")
            }
            self.queue.asyncAfter(deadline: .now() + .milliseconds(NfcRules.timeoutMs)) {
                if once.take() { lost() }
            }
            card.sendCommand(apdu: apdu) { data, sw1, sw2, error in
                self.queue.async {
                    guard once.take() else { return }
                    if let error {
                        if NfcRules.failure(code: (error as NSError).code) == .refused { return call.reject("Not a command a card can take.", "bad_apdu") }
                        return lost()
                    }
                    call.resolve(["data": NfcRules.answer(data, sw1, sw2)])
                }
            }
        }
    }

    /// Lets go of the card: on iOS that ends its sheet, with the done words. A close for an earlier
    /// card does nothing, so it never ends a sheet that waits for the next one.
    @objc func close(_ call: CAPPluginCall) {
        let id = call.getInt("id")
        queue.async {
            if self.current != nil, id == nil || id == self.currentId { self.end(error: nil) }
            call.resolve()
        }
    }

    /// Turns reading off: the sheet, if one is up, ends.
    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            self.end(error: nil)
            call.resolve()
        }
    }

    /// Ends the sheet: with the done words, or with an error the sheet shows. On the queue.
    private func end(error: String?) {
        current = nil
        guard let s = session else { return }
        session = nil
        if let error {
            s.invalidate(errorMessage: error)
        } else {
            s.alertMessage = words.done
            s.invalidate()
        }
    }

    public func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        let code = (error as NSError).code
        CAPLog.print("ForgeNfc: the card sheet closed: \(NfcRules.ending(code: code))")
        guard session === self.session else { return }
        self.session = nil
        current = nil
    }

    /// True the first time only: a command's answer and its 5 second limit race, and one of them wins.
    private final class Once {
        private var done = false
        func take() -> Bool {
            if done { return false }
            done = true
            return true
        }
    }
}
