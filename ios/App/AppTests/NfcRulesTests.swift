import CoreNFC
import XCTest

// NfcRules (App/NfcRules.swift), compiled into this bundle on its own: the same cases as
// android/app/src/test/.../NfcRulesTest.kt, and the CoreNFC error codes the plugin maps.
// Run: xcodebuild test -workspace App.xcworkspace -scheme AppTests -destination 'name=<a simulator>'
final class NfcRulesTests: XCTestCase {
    private func bytes(_ v: UInt8...) -> Data { Data(v) }

    func testGivesEachCommandFiveSecondsOnTheCard() {
        XCTAssertEqual(NfcRules.timeoutMs, 5000)
    }

    func testReadsAndWritesHexBothWays() {
        XCTAssertEqual(NfcRules.fromHex("00a4FF"), bytes(0x00, 0xa4, 0xff))
        XCTAssertEqual(NfcRules.toHex(bytes(0x00, 0xa4, 0xff)), "00a4ff")
        XCTAssertNil(NfcRules.fromHex("abc"))
        XCTAssertNil(NfcRules.fromHex("zz"))
        XCTAssertNil(NfcRules.fromHex(nil))
        XCTAssertEqual(NfcRules.fromHex("")?.count, 0)
    }

    func testTakesTheCommandsThePageSendsAsTheAppletsTranscriptHasThem() {
        // SELECT by the applet AID with Le (case 4), as public/v2/core/card/apdu.js builds it.
        XCTAssertEqual(NfcRules.apdu("00a404000bf04341534855434152440100"), NfcRules.fromHex("00a404000bf04341534855434152440100"))
        // GET_INFO (case 2), SPEND_ALL_BEGIN (case 4), SPEND_ALL_OUTPUTS (case 3), from the transcript.
        XCTAssertEqual(NfcRules.apdu("b001000000")?.count, 5)
        XCTAssertEqual(NfcRules.apdu("b0220000010004")?.count, 7)
        let outputs = "b023000025" + "0000005a" + "03" + String(repeating: "11", count: 32)
        XCTAssertEqual(NfcRules.apdu(outputs)?.count, 5 + 37)
        // A header alone (case 1).
        XCTAssertEqual(NfcRules.apdu("b0250000")?.count, 4)
        // The largest short APDU: 255 data bytes and Le.
        XCTAssertEqual(NfcRules.apdu("b03000ff" + "ff" + String(repeating: "00", count: 255) + "00")?.count, NfcRules.maxApdu)
        // CoreNFC takes each of them as one command.
        for hex in ["00a404000bf04341534855434152440100", "b001000000", "b0220000010004", outputs, "b0250000"] {
            XCTAssertNotNil(NFCISO7816APDU(data: NfcRules.apdu(hex)!), hex)
        }
    }

    func testRefusesWhatIsNotOneShortApdu() {
        XCTAssertNil(NfcRules.apdu("b001"))
        XCTAssertNil(NfcRules.apdu("not hex"))
        XCTAssertNil(NfcRules.apdu(nil))
        // Lc says 2 bytes, 3 follow (and not 2 plus Le): misframed.
        XCTAssertNil(NfcRules.apdu("b0300000020102030405"))
        // Lc says 4, only 2 follow.
        XCTAssertNil(NfcRules.apdu("b030000004aabb"))
        // An extended length (Lc 00 then two bytes) is not sent.
        XCTAssertNil(NfcRules.apdu("b0300000000003aabbcc"))
        // Longer than any short APDU.
        XCTAssertNil(NfcRules.apdu("b0300000ff" + String(repeating: "00", count: 300)))
    }

    func testHandsBackTheWholeAnswerWithItsStatusWord() {
        XCTAssertEqual(NfcRules.answer(bytes(0x02, 0x01), 0x90, 0x00), "02019000")
        XCTAssertEqual(NfcRules.answer(Data(), 0x6a, 0x82), "6a82")
    }

    func testRefusesACommandIosWillNotSendAndCountsEverythingElseAsALostCard() {
        XCTAssertEqual(NFCReaderError.Code.readerErrorSecurityViolation.rawValue, 2)
        XCTAssertEqual(NFCReaderError.Code.readerErrorInvalidParameter.rawValue, 3)
        XCTAssertEqual(NFCReaderError.Code.readerErrorParameterOutOfBound.rawValue, 5)
        XCTAssertEqual(NFCReaderError.Code.readerTransceiveErrorPacketTooLong.rawValue, 105)
        for c: NFCReaderError.Code in [.readerErrorSecurityViolation, .readerErrorInvalidParameter, .readerErrorInvalidParameterLength, .readerErrorParameterOutOfBound, .readerTransceiveErrorPacketTooLong] {
            XCTAssertEqual(NfcRules.failure(code: c.rawValue), .refused, "\(c.rawValue)")
        }
        for c: NFCReaderError.Code in [.readerTransceiveErrorTagConnectionLost, .readerTransceiveErrorRetryExceeded, .readerTransceiveErrorTagResponseError, .readerTransceiveErrorSessionInvalidated, .readerTransceiveErrorTagNotConnected, .readerSessionInvalidationErrorUserCanceled, .readerSessionInvalidationErrorSessionTimeout, .readerSessionInvalidationErrorSessionTerminatedUnexpectedly] {
            XCTAssertEqual(NfcRules.failure(code: c.rawValue), .lost, "\(c.rawValue)")
        }
    }

    func testNamesWhyASheetEnded() {
        XCTAssertEqual(NfcRules.ending(code: NFCReaderError.Code.readerSessionInvalidationErrorUserCanceled.rawValue), "cancelled")
        XCTAssertEqual(NfcRules.ending(code: NFCReaderError.Code.readerSessionInvalidationErrorSessionTimeout.rawValue), "timed out")
        XCTAssertEqual(NfcRules.ending(code: NFCReaderError.Code.readerSessionInvalidationErrorSessionTerminatedUnexpectedly.rawValue), "ended by the system")
        XCTAssertEqual(NfcRules.ending(code: NFCReaderError.Code.readerSessionInvalidationErrorSystemIsBusy.rawValue), "the system is busy")
        XCTAssertEqual(NfcRules.ending(code: NFCReaderError.Code.readerErrorRadioDisabled.rawValue), "the NFC radio is off")
        XCTAssertEqual(NfcRules.ending(code: 999), "code 999")
    }

    func testTakesTheSheetWordsFromThePageAndKeepsItsOwnForAnyItLeftOut() {
        let w = NfcRules.Words(["hold": "Hold it here.", "keep": "", "done": 3, "lost": String(repeating: "x", count: 201)])
        XCTAssertEqual(w.hold, "Hold it here.")
        XCTAssertEqual(w.keep, NfcRules.Words().keep)
        XCTAssertEqual(w.done, NfcRules.Words().done)
        XCTAssertEqual(w.lost, NfcRules.Words().lost)
        XCTAssertEqual(NfcRules.Words(nil), NfcRules.Words())
        for s in [w.keep, w.done, w.lost, w.notCard, w.one, NfcRules.Words().hold] { XCTAssertFalse(s.contains("\u{2014}"), s) }
    }
}
