import UIKit
import Capacitor

/// Capacitor's web view with the v2 app (docs/IOS.md), and the app's plugins: ForgeBars, ForgeNfc, ForgeSpeech and ForgeShare (Save to Photos).
class ForgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BarsPlugin())
        bridge?.registerPluginInstance(NfcPlugin())
        bridge?.registerPluginInstance(SpeechPlugin())
        bridge?.registerPluginInstance(SharePlugin())
    }
}
