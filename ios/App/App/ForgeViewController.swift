import UIKit
import Capacitor

/// Capacitor's web view with the v2 app (docs/IOS.md), and the app's one plugin, ForgeBars.
class ForgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BarsPlugin())
    }
}
