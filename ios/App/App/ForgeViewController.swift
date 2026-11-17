import UIKit
import Capacitor

/// Capacitor's web view with the v2 app (docs/IOS.md), and the app's plugins: ForgeBars, ForgeNfc and ForgeSpeech.
class ForgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BarsPlugin())
        bridge?.registerPluginInstance(NfcPlugin())
        bridge?.registerPluginInstance(SpeechPlugin())
    }
}
