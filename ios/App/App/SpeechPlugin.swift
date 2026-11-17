import AVFoundation
import Capacitor
import Foundation
import Speech
import UIKit

/// ForgeSpeech: Hold to talk heard by Apple's speech recogniser on the iPhone itself (docs/IOS.md,
/// docs/VOICE.md), for public/v2/core/native.js nativeSpeech. The same plugin as
/// android/.../SpeechPlugin.kt: the same name, methods, answers, events and error codes.
///
/// The sound never leaves the phone. Every request is an SFSpeechAudioBufferRecognitionRequest with
/// requiresOnDeviceRecognition set, made only from a recogniser whose supportsOnDeviceRecognition is
/// true for the language, checked again before each request (SpeechRules.onDeviceOnly). Apple honours
/// requiresOnDeviceRecognition only when supportsOnDeviceRecognition is true, so where it is not, no
/// request is made at all and the page uses the engine. There is no fallback to Apple's servers here.
///
/// available({locale}) resolves {onDevice, reason, locale}. start({id, locale}) resolves once listening
/// starts, or rejects with code permission, busy or unavailable; then events "speech" {id, type}:
/// started, level {level 0..1}, partial {text}, final {text}, error {code: permission, unavailable,
/// no-speech, busy, audio, failure, interrupted}, and end, always last. stop({id}) ends listening and
/// the last result becomes final; cancel({id}) drops it. Two permissions: speech recognition, then the
/// microphone, each asked the first time. No sound and no words are written to storage or logged.
@objc(SpeechPlugin)
public class SpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechPlugin"
    public let jsName = "ForgeSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    /// The request the microphone's sound goes to, and when the level bars last got a level. Read on
    /// the audio thread (the tap), changed on the main thread.
    private final class Feed {
        private let lock = NSLock()
        private var request: SFSpeechAudioBufferRecognitionRequest?
        private var lastLevel: UInt64 = 0

        func set(_ r: SFSpeechAudioBufferRecognitionRequest?) {
            lock.lock()
            request = r
            lock.unlock()
        }

        /// Hands the sound to the request; returns a level when it is time for one.
        func take(_ buffer: AVAudioPCMBuffer) -> Double? {
            lock.lock()
            let r = request
            let now = DispatchTime.now().uptimeNanoseconds
            let due = now - lastLevel >= UInt64(SpeechRules.levelEveryMs) * 1_000_000
            if due { lastLevel = now }
            lock.unlock()
            r?.append(buffer)
            guard due, let ch = buffer.floatChannelData else { return nil }
            return SpeechRules.level(dbfs: SpeechRules.dbfs(UnsafeBufferPointer(start: ch[0], count: Int(buffer.frameLength))))
        }
    }

    /// The audio session as it was before a press, put back after it.
    private struct Saved {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    /// One press. Everything here is read and changed on the main thread.
    private final class Live {
        let id: String
        let recognizer: SFSpeechRecognizer
        let engine = AVAudioEngine()
        let rules = SpeechSession()
        let feed = Feed()
        var request: SFSpeechAudioBufferRecognitionRequest?
        var task: SFSpeechRecognitionTask?
        /// Each request is a round; a result from an earlier round is not this one's.
        var round = 0
        var capturing = false
        var deadline: DispatchWorkItem?
        var saved: Saved?
        var engineWatch: NSObjectProtocol?

        init(id: String, recognizer: SFSpeechRecognizer) {
            self.id = id
            self.recognizer = recognizer
        }
    }

    private var live: Live?

    override public func load() {
        let c = NotificationCenter.default
        // Leaving the app drops what was being heard: nothing is sent unseen (Android: handleOnPause).
        c.addObserver(self, selector: #selector(left), name: UIApplication.didEnterBackgroundNotification, object: nil)
        c.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        c.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    // MARK: availability

    @objc func available(_ call: CAPPluginCall) {
        let locale = SpeechRules.tag(call.getString("locale"))
        DispatchQueue.main.async {
            let a = SpeechPlugin.check(locale).availability
            // The only line logged: never sound or words.
            CAPLog.print("ForgeSpeech: available locale=\(locale) onDevice=\(a.onDevice) reason=\(a.reason ?? "none") listen=\(a.locale)")
            call.resolve(["onDevice": a.onDevice, "reason": a.reason ?? NSNull(), "locale": a.locale])
        }
    }

    /// Whether Apple's recogniser hears `locale` on this phone now, and the recogniser to listen with.
    private static func check(_ locale: String) -> (availability: SpeechRules.Availability, recognizer: SFSpeechRecognizer?) {
        var seen: [SpeechRules.Recogniser] = []
        var ready: SFSpeechRecognizer?
        let ids = SFSpeechRecognizer.supportedLocales().map(\.identifier)
        for id in SpeechRules.candidates(ids, locale) {
            // A recogniser that falls back to another language (the keyboard's) is not this one.
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: id)), SpeechRules.tag(r.locale.identifier) == SpeechRules.tag(id) else {
                seen.append(.init(locale: id, onDevice: false, ready: false))
                continue
            }
            let s = SpeechRules.Recogniser(locale: id, onDevice: r.supportsOnDeviceRecognition, ready: r.isAvailable)
            seen.append(s)
            if ready == nil, s.onDevice, s.ready { ready = r }
        }
        return (SpeechRules.availability(seen, locale), ready)
    }

    // MARK: a press

    @objc func start(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("No id.", "bad_call") }
        let locale = SpeechRules.tag(call.getString("locale"))
        SpeechPlugin.askSpeech { speechOk in
            guard speechOk else { return call.reject("Speech recognition is not allowed.", "permission") }
            SpeechPlugin.askMicrophone { micOk in
                guard micOk else { return call.reject("The microphone is not allowed.", "permission") }
                DispatchQueue.main.async { self.begin(call, id: id, locale: locale) }
            }
        }
    }

    /// Speech recognition: asked the first time (NSSpeechRecognitionUsageDescription).
    private static func askSpeech(_ done: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: done(true)
        case .notDetermined: SFSpeechRecognizer.requestAuthorization { s in DispatchQueue.main.async { done(s == .authorized) } }
        default: done(false)
        }
    }

    /// The microphone: asked the first time (NSMicrophoneUsageDescription), the permission the web view's
    /// microphone also uses.
    private static func askMicrophone(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: done(true)
            case .undetermined: AVAudioApplication.requestRecordPermission { ok in DispatchQueue.main.async { done(ok) } }
            default: done(false)
            }
        } else {
            let s = AVAudioSession.sharedInstance()
            switch s.recordPermission {
            case .granted: done(true)
            case .undetermined: s.requestRecordPermission { ok in DispatchQueue.main.async { done(ok) } }
            default: done(false)
            }
        }
    }

    private func begin(_ call: CAPPluginCall, id: String, locale: String) {
        if live != nil { return call.reject("Already listening.", "busy") }
        let (a, recognizer) = SpeechPlugin.check(locale)
        guard a.onDevice, let recognizer else { return call.reject(a.reason ?? "Not on this phone.", "unavailable") }
        let l = Live(id: id, recognizer: recognizer)
        live = l
        // Kept first, so a session that failed half way is still put back (release).
        l.saved = SpeechPlugin.currentAudio()
        do {
            try SpeechPlugin.openAudio()
        } catch {
            // As Android's recogniser reports a microphone it cannot open: listening ends with audio.
            call.resolve()
            return act(l, l.rules.onError("audio"))
        }
        // The input changed (headphones in or out): the engine has stopped (AVAudioEngineConfigurationChange).
        l.engineWatch = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: l.engine, queue: .main) { [weak self] _ in
            self?.reroute(l)
        }
        if let code = newRequest(l) {
            call.resolve()
            return act(l, l.rules.onError(code))
        }
        later(l, SpeechRules.safetyMs) { [weak self] in self?.stopLive(l) }
        call.resolve()
        emit(l.id, "started")
    }

    /// A new request for the same press: the first, and again after Apple ended one while the button is
    /// held. Returns an error code when it cannot listen.
    private func newRequest(_ l: Live) -> String? {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        // The guard: no request runs unless it stays on the phone. Checked before every request, as the
        // recogniser's answer can change (a language removed in Settings).
        guard SpeechRules.onDeviceOnly(recogniserOnDevice: l.recognizer.supportsOnDeviceRecognition, requestRequiresOnDevice: request.requiresOnDeviceRecognition), l.recognizer.isAvailable else {
            return "unavailable"
        }
        l.round += 1
        let round = l.round
        l.request?.endAudio()
        l.request = request
        l.feed.set(request)
        l.task = l.recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.heard(l, round, result, error) }
        }
        return l.capturing ? nil : capture(l)
    }

    /// Starts the microphone; its sound goes to the round's request (Feed), in memory only.
    private func capture(_ l: Live) -> String? {
        let input = l.engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return "audio" }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let level = l.feed.take(buffer) else { return }
            DispatchQueue.main.async {
                guard let self, self.live === l, l.rules.held else { return }
                self.emit(l.id, "level", ["level": level])
            }
        }
        l.engine.prepare()
        do {
            try l.engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return "audio"
        }
        l.capturing = true
        return nil
    }

    private func stopCapture(_ l: Live) {
        guard l.capturing else { return }
        l.capturing = false
        l.engine.stop()
        l.engine.inputNode.removeTap(onBus: 0)
    }

    private func heard(_ l: Live, _ round: Int, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
        guard live === l, round == l.round else { return }
        if let result {
            let text = result.bestTranscription.formattedString
            if result.isFinal { return act(l, l.rules.onResults(text)) }
            if error == nil { return act(l, l.rules.onPartial(text)) }
        }
        if let error {
            let e = error as NSError
            CAPLog.print("ForgeSpeech: the recogniser ended: \(e.domain) \(e.code)")
            act(l, l.rules.onError(SpeechRules.errorCode(domain: e.domain, code: e.code)))
        }
    }

    private func act(_ l: Live, _ acts: [SpeechSession.Act]) {
        guard live === l else { return }
        for a in acts {
            switch a {
            case let .words(type, text):
                emit(l.id, type, ["text": text])
            case let .fail(code):
                emit(l.id, "error", ["code": code])
            case .restart:
                DispatchQueue.main.async {
                    guard self.live === l else { return }
                    // Let go meanwhile: no new request (the microphone stays off); what was heard is the question.
                    guard l.rules.held else { return self.act(l, l.rules.onDeadline()) }
                    if let code = self.newRequest(l) { self.act(l, l.rules.onError(code)) }
                }
            case .end:
                release(l)
                emit(l.id, "end")
            }
        }
    }

    private func later(_ l: Live, _ ms: Int, _ fn: @escaping () -> Void) {
        l.deadline?.cancel()
        let w = DispatchWorkItem { [weak self] in if self?.live === l { fn() } }
        l.deadline = w
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: w)
    }

    private func stopLive(_ l: Live) {
        guard l.rules.held else { return act(l, l.rules.onDeadline()) }
        l.rules.onStop()
        // Nothing more is heard: the microphone stops now, and the request is told the sound has ended.
        stopCapture(l)
        l.request?.endAudio()
        // The last result usually comes within a second; if not, what was heard so far is the question.
        later(l, SpeechRules.finishMs) { [weak self] in self?.act(l, l.rules.onDeadline()) }
    }

    /// The input went away or changed while held: this request ends (its words are kept) and the next
    /// one listens on the new input, in its own format. After the release there is nothing to do.
    private func reroute(_ l: Live) {
        guard live === l, l.rules.held, l.capturing else { return }
        stopCapture(l)
        l.request?.endAudio()
    }

    @objc func stop(_ call: CAPPluginCall) {
        let id = call.getString("id")
        DispatchQueue.main.async {
            if let l = self.live, l.id == id { self.stopLive(l) }
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("id")
        DispatchQueue.main.async {
            if let l = self.live, l.id == id {
                self.release(l)
                self.emit(l.id, "end")
            }
            call.resolve()
        }
    }

    private func release(_ l: Live) {
        if live === l { live = nil }
        l.deadline?.cancel()
        l.task?.cancel()
        l.task = nil
        l.request?.endAudio()
        l.request = nil
        l.feed.set(nil)
        stopCapture(l)
        if let w = l.engineWatch { NotificationCenter.default.removeObserver(w) }
        l.engineWatch = nil
        if let s = l.saved { SpeechPlugin.closeAudio(s) }
        l.saved = nil
    }

    private func emit(_ id: String, _ type: String, _ data: [String: Any] = [:]) {
        var d = data
        d["id"] = id
        d["type"] = type
        notifyListeners("speech", data: d)
    }

    // MARK: the audio session

    /// For the press only: record and play, measurement mode (the least of the system's own processing
    /// on the sound, the primary microphone), other apps' sound ducked rather than stopped. duckOthers
    /// makes the session mixable, so the web view's own sound (Web Audio, the phone's voice) is not
    /// interrupted. What was set before is kept (currentAudio), to put back after.
    private static func openAudio() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try s.setActive(true)
    }

    private static func currentAudio() -> Saved {
        let s = AVAudioSession.sharedInstance()
        return Saved(category: s.category, mode: s.mode, options: s.categoryOptions)
    }

    /// After the press: the session is let go, telling other apps they may play again (that also ends
    /// the ducking), and the category and mode go back to what they were before it.
    private static func closeAudio(_ saved: Saved) {
        let s = AVAudioSession.sharedInstance()
        try? s.setActive(false, options: .notifyOthersOnDeactivation)
        try? s.setCategory(saved.category, mode: saved.mode, options: saved.options)
    }

    // MARK: leaving, calls, routes

    private func drop() {
        guard let l = live else { return }
        release(l)
        emit(l.id, "error", ["code": "interrupted"])
        emit(l.id, "end")
    }

    @objc private func left() {
        DispatchQueue.main.async { self.drop() }
    }

    /// A call or an alarm took the audio: what was being heard is dropped, as when the app is left.
    @objc private func interrupted(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        DispatchQueue.main.async { self.drop() }
    }

    /// Headphones in or out mid-press: listen on the new input, keeping the words heard.
    @objc private func routeChanged(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt, let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        guard reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else { return }
        DispatchQueue.main.async {
            if let l = self.live { self.reroute(l) }
        }
    }
}
