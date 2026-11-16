import UIKit
import Capacitor

/// The status bar's text in the page's colour, as Safari keeps it for the theme-color: light on
/// Midnight and the first run, dark on the Light look. The page draws under the status bar and the home
/// indicator itself (viewport-fit=cover), so only the text changes. The app starts light (Info.plist
/// UIStatusBarStyle). The page's side is public/v2/core/native.js (followBars); the rule is
/// android/.../BarRules.kt's.
@objc(BarsPlugin)
public class BarsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BarsPlugin"
    public let jsName = "ForgeBars"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)]

    /// Sets the bar: {color: "#RRGGBB"}.
    @objc func set(_ call: CAPPluginCall) {
        guard let darkText = BarsPlugin.darkText(call.getString("color")) else {
            return call.reject("Not a colour.", "bad_color")
        }
        DispatchQueue.main.async {
            self.bridge?.statusBarStyle = darkText ? .darkContent : .lightContent
            call.resolve()
        }
    }

    /// Whether text reads better dark on this plain hex colour (#RGB or #RRGGBB), or nil for anything
    /// else: its contrast with black beats its contrast with white (WCAG relative luminance).
    static func darkText(_ hex: String?) -> Bool? {
        guard var h = hex?.trimmingCharacters(in: .whitespaces), h.hasPrefix("#") else { return nil }
        h.removeFirst()
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        guard h.count == 6, h.allSatisfy(\.isHexDigit), let rgb = Int(h, radix: 16) else { return nil }
        func ch(_ v: Int) -> Double {
            let c = Double(v) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        let lum = 0.2126 * ch((rgb >> 16) & 0xFF) + 0.7152 * ch((rgb >> 8) & 0xFF) + 0.0722 * ch(rgb & 0xFF)
        return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05)
    }
}
