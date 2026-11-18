import Capacitor
import Foundation
import Photos

/// ForgeShare on the iPhone: Save in Share unseen puts the cleaned photo into the Photos library
/// (docs/IOS.md), for public/v2/core/native.js. Android's ForgeShare (SharePlugin.kt) also opens the
/// share sheet and removes the files it wrote; on the iPhone the share sheet is the web view's own
/// (navigator.share) and nothing is written, so this plugin has save only.
///
/// save({name, mime, data}) resolves {saved: true} once Photos has the photo, or rejects with code
/// bad_type (not a JPEG or PNG), bad_file (the data is not base64), denied (the person did not allow
/// adding to Photos, or it is restricted) or save_failed. Access is add-only
/// (PHPhotoLibrary.requestAuthorization(for: .addOnly)): Forge can add a photo and never sees the
/// library. The file goes in as its exact bytes (PHAssetCreationRequest addResource with data): the app
/// does not decode it, encode it again or add anything to it. Nothing is written anywhere else or logged.
@objc(SharePlugin)
public class SharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharePlugin"
    public let jsName = "ForgeShare"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)]

    /// The types Save takes, with the name Photos keeps for the file (the page's own plain name).
    static let names = ["image/jpeg": "photo.jpg", "image/png": "photo.png"]

    /// Saves a photo to Photos: {name, mime, data (base64)}.
    @objc func save(_ call: CAPPluginCall) {
        guard let name = SharePlugin.names[call.getString("mime")?.lowercased().trimmingCharacters(in: .whitespaces) ?? ""] else {
            return call.reject("This kind of file cannot be saved.", "bad_type")
        }
        guard let data = Data(base64Encoded: call.getString("data") ?? ""), !data.isEmpty else {
            return call.reject("The file could not be read.", "bad_file")
        }
        // Asks the first time only; afterwards answers at once with what the person chose.
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                return call.reject("Forge may not add to Photos.", "denied")
            }
            PHPhotoLibrary.shared().performChanges({
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = name
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: options)
            }) { ok, _ in
                if ok {
                    call.resolve(["saved": true])
                } else {
                    call.reject("The photo could not be saved.", "save_failed")
                }
            }
        }
    }
}
