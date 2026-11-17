import UIKit
import Capacitor

/// Capacitor's web view with the v2 app (docs/IOS.md), and the app's plugins: ForgeBars and ForgeNfc.
class ForgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BarsPlugin())
        bridge?.registerPluginInstance(NfcPlugin())
    }
}
