import Foundation

/// The rules ForgeSpeech (SpeechPlugin) follows, apart from iOS so the unit tests (AppTests) cover them
/// without a phone: which language Apple's recogniser can hear on the phone itself, what each recogniser
/// error means to the page, the sound level for the level bars, the guard that keeps every request on
/// the phone, and how one press of Hold to talk turns the recogniser's results into one question
/// (SpeechSession). The same rules as android/.../SpeechRules.kt; what differs is said where it is.
enum SpeechRules {
    /// A safety stop well past the page's own 60 s limit (as Android's).
    static let safetyMs = 90_000

    /// After the release, how long the last result may take before what was heard is the question.
    static let finishMs = 4_000

    /// The level bars get a level at most this often.
    static let levelEveryMs = 80

    /// "en_us", "EN-us", "" or nil to a BCP 47 tag like "en-US". English when none is given.
    static func tag(_ raw: String?) -> String {
        let parts = (raw ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init).filter { !$0.isEmpty }
        guard let first = parts.first, first.allSatisfy(\.isLetter) else { return "en-US" }
        return ([first.lowercased()] + parts.dropFirst().map { $0.count == 2 ? $0.uppercased() : $0 }).joined(separator: "-")
    }

    private static func language(_ tag: String) -> String {
        String(tag.split(separator: "-").first ?? "").lowercased()
    }

    /// The tag from `languages` to listen with for `wanted`: the same tag, else the first with the same
    /// language (en-GB asked, en-US there: en-US), else nil. As Android's.
    static func match(_ languages: [String], _ wanted: String) -> String? {
        let w = tag(wanted)
        let tags = languages.map { tag($0) }
        return tags.first { $0.caseInsensitiveCompare(w) == .orderedSame } ?? tags.first { language($0) == language(w) }
    }

    /// The locales to try for `wanted`, from the recogniser's own list (SFSpeechRecognizer.supportedLocales
    /// identifiers, kept as they are): the same tag first, then US English, then the rest of the same
    /// language in order. iOS lists them as a set, so the order is made here. Another language never.
    static func candidates(_ identifiers: [String], _ wanted: String) -> [String] {
        let w = tag(wanted)
        let same = identifiers.filter { language(tag($0)) == language(w) }
        func rank(_ id: String) -> Int {
            let t = tag(id)
            if t.caseInsensitiveCompare(w) == .orderedSame { return 0 }
            return t == "en-US" ? 1 : 2
        }
        return same.sorted { (rank($0), tag($0)) < (rank($1), tag($1)) }
    }

    /// What the page is told: {onDevice, reason, locale}. reason is nil when it is ready.
    struct Availability: Equatable {
        let onDevice: Bool
        let reason: String?
        let locale: String
    }

    /// What the phone says of one candidate locale: whether its recogniser hears on the phone
    /// (supportsOnDeviceRecognition), and whether it can take a request now (isAvailable).
    struct Recogniser: Equatable {
        let locale: String
        let onDevice: Bool
        let ready: Bool
    }

    /// Ready only with a recogniser that hears on the phone and can take a request now; else why not.
    /// language-not-on-device is Android's language-not-downloaded: Apple hears the language only on its
    /// servers on this phone, which the plugin never uses, so the engine hears the question.
    static func availability(_ seen: [Recogniser], _ wanted: String) -> Availability {
        let w = tag(wanted)
        if seen.isEmpty { return Availability(onDevice: false, reason: "language-not-supported", locale: w) }
        if let r = seen.first(where: { $0.onDevice && $0.ready }) { return Availability(onDevice: true, reason: nil, locale: tag(r.locale)) }
        if seen.contains(where: { $0.onDevice }) { return Availability(onDevice: false, reason: "recognizer-unavailable", locale: w) }
        return Availability(onDevice: false, reason: "language-not-on-device", locale: w)
    }

    /// The guard before every request: it may run only when the recogniser hears this language on the
    /// phone and the request requires it to (requiresOnDeviceRecognition). Apple honours that setting
    /// only when supportsOnDeviceRecognition is true (both headers say so), so both must hold, every time.
    static func onDeviceOnly(recogniserOnDevice: Bool, requestRequiresOnDevice: Bool) -> Bool {
        recogniserOnDevice && requestRequiresOnDevice
    }

    /// The plain codes the page gets, from the errors Apple lists for a recognition task
    /// (SFSpeechRecognitionTask.error) and the Speech framework's own (SFSpeechErrorCode, iOS 17).
    static func errorCode(domain: String, code: Int) -> String {
        switch (domain, code) {
        case ("kAFAssistantErrorDomain", 1110): return "no-speech" // Failed to recognize any speech.
        case ("kAFAssistantErrorDomain", 1700): return "permission" // Request is not authorized.
        case ("kAFAssistantErrorDomain", 1100): return "busy" // An earlier instance is still active.
        // Assets are not installed; Siri or Dictation is disabled; failed to initialize the recogniser.
        case ("kLSRErrorDomain", 102), ("kLSRErrorDomain", 201), ("kLSRErrorDomain", 300): return "unavailable"
        case ("kLSRErrorDomain", 301): return "interrupted" // Request was canceled.
        case ("SFSpeechErrorDomain", 2): return "audio" // The audio could not be read.
        default: return "failure"
        }
    }

    /// The sound's level in dB below full scale (dBFS) from samples of -1 to 1; -160 for silence.
    static func dbfs(_ samples: UnsafeBufferPointer<Float>) -> Float {
        guard !samples.isEmpty else { return -160 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        let rms = (sum / Float(samples.count)).squareRoot()
        return rms > 0 ? max(20 * log10(rms), -160) : -160
    }

    /// The level bars' 0 to 0.6, as Android gives them: about -50 dBFS in a quiet room to -14 when speaking.
    static func level(dbfs: Float) -> Double {
        Double(min(max((dbfs + 50) / 60, 0), 0.6))
    }
}

/// One press of Hold to talk, as android/.../SpeechRules.kt SpeechSession. Apple's recogniser ends a
/// request on its own (a long pause, its limit on one request's length, the route changing); while the
/// button is still held a new request starts and the words are joined, so nothing heard is lost. Pure:
/// each event returns what the plugin does next.
final class SpeechSession {
    enum Act: Equatable {
        /// Send the words so far (partial) or the question (final) to the page.
        case words(String, String)
        case fail(String)
        case restart
        case end
    }

    private(set) var held = true
    private(set) var ended = false
    private var parts: [String] = []
    private var partial = ""
    private var restarts = 0
    private let maxRestarts: Int

    init(maxRestarts: Int = 20) {
        self.maxRestarts = maxRestarts
    }

    private func join(_ more: [String] = []) -> String {
        (parts + more).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    func text() -> String { join([partial]) }

    func onPartial(_ text: String) -> [Act] {
        if ended { return [] }
        partial = text
        return [.words("partial", join([partial]))]
    }

    func onResults(_ text: String) -> [Act] {
        if ended { return [] }
        partial = ""
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(text) }
        if held && restarts < maxRestarts {
            restarts += 1
            return [.words("partial", join()), .restart]
        }
        return finish()
    }

    func onError(_ code: String) -> [Act] {
        if ended { return [] }
        // Silence while held: listen again.
        if code == "no-speech" && held && restarts < maxRestarts {
            restarts += 1
            return [.restart]
        }
        if code == "no-speech" { return finish() }
        // After the release, an error instead of a last result: what was heard is the question.
        if !held && code != "permission" && !text().isEmpty { return finish() }
        ended = true
        return [.fail(code), .end]
    }

    /// The button was let go: the recogniser is told the sound has ended, and its last result ends the question.
    func onStop() {
        held = false
    }

    /// No result came in time after the stop: what was heard so far is the question.
    func onDeadline() -> [Act] {
        ended ? [] : finish()
    }

    private func finish() -> [Act] {
        ended = true
        let t = text()
        return t.isEmpty ? [.fail("no-speech"), .end] : [.words("final", t), .end]
    }
}
