import Foundation

/// The rules for the bytes that pass between the page and a card (NfcPlugin), as
/// android/.../NfcRules.kt has them. Plain Swift with Foundation only, so the unit tests (AppTests)
/// cover it without a phone. The page builds every APDU itself (public/v2/core/card/apdu.js); this side
/// only checks that what it is asked to send is one well formed short APDU, and hands back the card's
/// whole answer, status word included.
enum NfcRules {
    /// How long one command may take on the card before the tap counts as lost (Android: IsoDep.setTimeout).
    static let timeoutMs = 5000

    /// The largest short APDU: header (4), Lc (1), 255 data bytes, Le (1).
    static let maxApdu = 4 + 1 + 255 + 1

    /// Bytes from lowercase or uppercase hex, or nil when it is not hex of whole bytes.
    static func fromHex(_ hex: String?) -> Data? {
        guard let hex, hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var hi: UInt8?
        for c in hex.utf8 {
            let v: UInt8
            switch c {
            case 0x30...0x39: v = c - 0x30
            case 0x61...0x66: v = c - 0x61 + 10
            case 0x41...0x46: v = c - 0x41 + 10
            default: return nil
            }
            if let h = hi {
                out.append(h << 4 | v)
                hi = nil
            } else {
                hi = v
            }
        }
        return out
    }

    static func toHex(_ bytes: Data) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// The APDU to send, or nil when it is not one well formed ISO 7816 short APDU: case 1 (header
    /// only), case 2 (header and Le), case 3 (header, Lc and that many bytes) or case 4 (case 3 and Le).
    /// An extended length or a length byte that does not match is refused before it reaches the card.
    static func apdu(_ hex: String?) -> Data? {
        guard let b = fromHex(hex), b.count >= 4, b.count <= maxApdu else { return nil }
        if b.count == 4 || b.count == 5 { return b }
        let lc = Int(b[b.startIndex + 4])
        if lc == 0 { return nil }
        return b.count == 5 + lc || b.count == 6 + lc ? b : nil
    }

    /// The card's answer as the page takes it: the data, then SW1 and SW2. CoreNFC hands the status word
    /// apart from the data, so the answer always carries one (Android refuses an answer shorter than 2).
    static func answer(_ data: Data, _ sw1: UInt8, _ sw2: UInt8) -> String {
        toHex(data + Data([sw1, sw2]))
    }

    /// What a failed command means for the page: refused before it reached the card (the page is told
    /// bad_apdu and the card stays), or the card is lost (tag_lost, and the sheet ends).
    enum Failure: Equatable {
        case refused
        case lost
    }

    /// The failure for an NFCReaderError code (CoreNFC NFCError.h). A SELECT of an application iOS was
    /// not told about (com.apple.developer.nfc.readersession.iso7816.select-identifiers) is a security
    /// violation (2); a command iOS cannot frame is an invalid parameter (3 to 5) or too long (105).
    /// Anything else (the connection lost, 100; the sheet ended, 103 and 200 up) means the card is gone.
    static func failure(code: Int) -> Failure {
        switch code {
        case 2, 3, 4, 5, 105: return .refused
        default: return .lost
        }
    }

    /// Why a sheet ended, for the log (never anything from the card): NFCReaderError codes.
    static func ending(code: Int) -> String {
        switch code {
        case 200: return "cancelled"
        case 201: return "timed out"
        case 202: return "ended by the system"
        case 203: return "the system is busy"
        case 2: return "not allowed (the NFC entitlement or the AID list)"
        case 6: return "the NFC radio is off"
        default: return "code \(code)"
        }
    }

    /// The words on the NFC sheet, from the page's string table (fund.card.sheet*), with these when the
    /// page sends none. Android has no sheet and ignores them.
    struct Words: Equatable {
        var hold = "Hold the card to the top of the back of your iPhone."
        var keep = "Keep the card there."
        var done = "Done. You can take the card away."
        var lost = "The card moved away. Scan it again in Forge."
        var notCard = "Not an eCash card."
        var one = "Hold one card at a time."

        init() {}

        /// The words in start's options; a missing, empty or over-long one keeps its default.
        init(_ options: [String: Any]?) {
            func pick(_ key: String, _ fallback: String) -> String {
                guard let s = options?[key] as? String, !s.isEmpty, s.count <= 200 else { return fallback }
                return s
            }
            let d = Words()
            hold = pick("hold", d.hold)
            keep = pick("keep", d.keep)
            done = pick("done", d.done)
            lost = pick("lost", d.lost)
            notCard = pick("notCard", d.notCard)
            one = pick("one", d.one)
        }
    }
}
