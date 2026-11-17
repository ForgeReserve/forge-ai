import XCTest

// SpeechRules (App/SpeechRules.swift), compiled into this bundle on its own: the cases of
// android/app/src/test/.../SpeechRulesTest.kt, and what is Apple's own: the candidate locales, the
// on-device guard, the error codes Apple lists, the sound level.
// Run: xcodebuild test -workspace App.xcworkspace -scheme AppTests -destination 'name=<a simulator>'
final class SpeechRulesTests: XCTestCase {
    private typealias Act = SpeechSession.Act

    func testTidiesLanguageTags() {
        XCTAssertEqual(SpeechRules.tag("en_us"), "en-US")
        XCTAssertEqual(SpeechRules.tag("EN-gb"), "en-GB")
        XCTAssertEqual(SpeechRules.tag("en"), "en")
        XCTAssertEqual(SpeechRules.tag("zh-Hant-tw"), "zh-Hant-TW")
        XCTAssertEqual(SpeechRules.tag(""), "en-US")
        XCTAssertEqual(SpeechRules.tag(nil), "en-US")
        XCTAssertEqual(SpeechRules.tag("123"), "en-US")
    }

    func testMatchesTheSameTagFirstThenTheSameLanguage() {
        XCTAssertEqual(SpeechRules.match(["en-US", "en-GB"], "en_gb"), "en-GB")
        XCTAssertEqual(SpeechRules.match(["de-DE", "en-US"], "en-GB"), "en-US")
        XCTAssertEqual(SpeechRules.match(["en_US"], "en"), "en-US")
        XCTAssertNil(SpeechRules.match(["de-DE", "fr-FR"], "en-US"))
        XCTAssertNil(SpeechRules.match([], "en-US"))
    }

    func testTriesTheSameTagThenUsEnglishThenTheRestOfTheLanguageNeverAnother() {
        // iOS lists its locales as a set, in no order; the identifiers are kept as iOS gave them.
        let ids = ["fr-FR", "en_IN", "en-GB", "en-US", "en-AU", "de-DE"]
        XCTAssertEqual(SpeechRules.candidates(ids, "en-GB"), ["en-GB", "en-US", "en-AU", "en_IN"])
        XCTAssertEqual(SpeechRules.candidates(ids, "en-JM"), ["en-US", "en-AU", "en-GB", "en_IN"])
        XCTAssertEqual(SpeechRules.candidates(ids.shuffled(), "en-US").first, "en-US")
        XCTAssertEqual(SpeechRules.candidates(["de-DE", "fr-FR"], "en-US"), [])
    }

    func testOffersOnlyARecogniserThatHearsTheLanguageOnThePhone() {
        typealias R = SpeechRules.Recogniser
        typealias A = SpeechRules.Availability
        // The first that hears on the phone and can take a request now, in its own tag.
        XCTAssertEqual(SpeechRules.availability([R(locale: "en-GB", onDevice: false, ready: true), R(locale: "en_US", onDevice: true, ready: true)], "en-GB"), A(onDevice: true, reason: nil, locale: "en-US"))
        // Apple hears it only on its servers on this phone: not offered, the engine hears it.
        XCTAssertEqual(SpeechRules.availability([R(locale: "en-US", onDevice: false, ready: true)], "en-US"), A(onDevice: false, reason: "language-not-on-device", locale: "en-US"))
        // On the phone, but not able to take a request now.
        XCTAssertEqual(SpeechRules.availability([R(locale: "en-US", onDevice: true, ready: false)], "en-US"), A(onDevice: false, reason: "recognizer-unavailable", locale: "en-US"))
        XCTAssertEqual(SpeechRules.availability([], "en-us"), A(onDevice: false, reason: "language-not-supported", locale: "en-US"))
    }

    func testNoRequestRunsUnlessItStaysOnThePhone() {
        XCTAssertTrue(SpeechRules.onDeviceOnly(recogniserOnDevice: true, requestRequiresOnDevice: true))
        // Apple ignores requiresOnDeviceRecognition where the recogniser does not hear on the phone, so
        // such a request could go to its servers: never run.
        XCTAssertFalse(SpeechRules.onDeviceOnly(recogniserOnDevice: false, requestRequiresOnDevice: true))
        XCTAssertFalse(SpeechRules.onDeviceOnly(recogniserOnDevice: true, requestRequiresOnDevice: false))
        XCTAssertFalse(SpeechRules.onDeviceOnly(recogniserOnDevice: false, requestRequiresOnDevice: false))
    }

    func testMapsAppleErrorsToThePlainCodes() {
        XCTAssertEqual(SpeechRules.errorCode(domain: "kAFAssistantErrorDomain", code: 1110), "no-speech")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kAFAssistantErrorDomain", code: 1700), "permission")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kAFAssistantErrorDomain", code: 1100), "busy")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kLSRErrorDomain", code: 102), "unavailable")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kLSRErrorDomain", code: 201), "unavailable")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kLSRErrorDomain", code: 300), "unavailable")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kLSRErrorDomain", code: 301), "interrupted")
        XCTAssertEqual(SpeechRules.errorCode(domain: "SFSpeechErrorDomain", code: 2), "audio")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kAFAssistantErrorDomain", code: 203), "failure")
        XCTAssertEqual(SpeechRules.errorCode(domain: "kAFAssistantErrorDomain", code: 1101), "failure")
        // The same number in another domain is not the same error.
        XCTAssertEqual(SpeechRules.errorCode(domain: "NSOSStatusErrorDomain", code: 1110), "failure")
    }

    func testGivesTheLevelOnAndroidsScale() {
        XCTAssertEqual([Float]().withUnsafeBufferPointer { SpeechRules.dbfs($0) }, -160)
        XCTAssertEqual([Float](repeating: 0, count: 256).withUnsafeBufferPointer { SpeechRules.dbfs($0) }, -160)
        XCTAssertEqual([Float](repeating: 1, count: 256).withUnsafeBufferPointer { SpeechRules.dbfs($0) }, 0, accuracy: 0.001)
        XCTAssertEqual([Float](repeating: 0.1, count: 256).withUnsafeBufferPointer { SpeechRules.dbfs($0) }, -20, accuracy: 0.01)
        XCTAssertEqual(SpeechRules.level(dbfs: -160), 0)
        XCTAssertEqual(SpeechRules.level(dbfs: -50), 0)
        XCTAssertEqual(SpeechRules.level(dbfs: -20), 0.5, accuracy: 0.001)
        // Never over 0.6, as Android's.
        XCTAssertEqual(SpeechRules.level(dbfs: 0), 0.6, accuracy: 0.001)
        XCTAssertEqual(SpeechRules.levelEveryMs, 80)
    }

    func testWaitsAsAndroidDoes() {
        XCTAssertEqual(SpeechRules.safetyMs, 90_000)
        XCTAssertEqual(SpeechRules.finishMs, 4_000)
    }

    func testAHeldQuestionWithPausesIsJoinedAndSentOnRelease() {
        let s = SpeechSession()
        XCTAssertEqual(s.onPartial("what should"), [.words("partial", "what should")])
        // Apple ends a request while the button is still held: it listens again.
        XCTAssertEqual(s.onResults("what should I bring"), [.words("partial", "what should I bring"), .restart])
        // Silence while held: again.
        XCTAssertEqual(s.onError("no-speech"), [.restart])
        XCTAssertEqual(s.onPartial("to the"), [.words("partial", "what should I bring to the")])
        s.onStop()
        XCTAssertFalse(s.held)
        XCTAssertEqual(s.onResults("to the beach"), [.words("final", "what should I bring to the beach"), .end])
        XCTAssertTrue(s.ended)
        XCTAssertEqual(s.onResults("late"), [])
    }

    func testNothingHeardEndsWithNoSpeech() {
        let s = SpeechSession()
        s.onStop()
        XCTAssertEqual(s.onError("no-speech"), [.fail("no-speech"), .end])
        // A last result with no words after the release (a silent hold): no question either.
        let e = SpeechSession()
        e.onStop()
        XCTAssertEqual(e.onResults(""), [.fail("no-speech"), .end])
        let d = SpeechSession()
        d.onStop()
        XCTAssertEqual(d.onDeadline(), [.fail("no-speech"), .end])
    }

    func testAfterTheReleaseWhatWasHeardIsTheQuestion() {
        let a = SpeechSession()
        _ = a.onPartial("hello there")
        a.onStop()
        XCTAssertEqual(a.onDeadline(), [.words("final", "hello there"), .end])
        let b = SpeechSession()
        _ = b.onPartial("hello")
        b.onStop()
        XCTAssertEqual(b.onError("failure"), [.words("final", "hello"), .end])
    }

    func testErrorsWhileHeldEndTheQuestion() {
        let s = SpeechSession()
        _ = s.onPartial("hello")
        XCTAssertEqual(s.onError("unavailable"), [.fail("unavailable"), .end])
        // A refused permission is never turned into a question, even after the release.
        let p = SpeechSession()
        _ = p.onPartial("hello")
        p.onStop()
        XCTAssertEqual(p.onError("permission"), [.fail("permission"), .end])
    }

    func testRestartsAreCapped() {
        let s = SpeechSession(maxRestarts: 2)
        XCTAssertEqual(s.onError("no-speech"), [.restart])
        XCTAssertEqual(s.onResults("one"), [.words("partial", "one"), .restart])
        XCTAssertEqual(s.onResults("two"), [.words("final", "one two"), .end])
    }
}
