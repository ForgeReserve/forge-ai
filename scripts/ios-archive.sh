#!/usr/bin/env bash
# Builds the Forge iPhone app's Release archive and exports an App Store IPA from it, for TestFlight.
#
#   scripts/ios-archive.sh [--team <team id>] [--out <folder>]
#
# The team id (ten letters and digits, Certificates, Identifiers & Profiles, Membership) comes from
# --team or FORGE_IOS_TEAM. It is given to xcodebuild for this run only and is never written into the
# Xcode project: if xcodebuild changes project.pbxproj, the script puts it back as it was.
#
# Signing is Xcode's automatic signing, with -allowProvisioningUpdates: with the Apple account signed
# in to Xcode, xcodebuild may register the App ID and make or renew the certificates and profiles it
# needs. The script itself makes no certificate, profile or identifier.
#
# It uploads nothing. The export is to a folder (method app-store-connect, destination export); the
# owner uploads the IPA with Xcode's Organizer or Transporter (docs/IOS.md, TestFlight).
#
# Output, in --out (default dist/ios, outside git): Forge.xcarchive, the IPA in export/, and its
# size, version and build number.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEAM="${FORGE_IOS_TEAM:-}"
OUT="$ROOT/dist/ios"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TEAM" ]]; then
  echo "No team id given (--team or FORGE_IOS_TEAM). Nothing was built." >&2
  exit 1
fi
if [[ ! "$TEAM" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "The team id is ten capital letters and digits, not $TEAM. Nothing was built." >&2
  exit 1
fi
if [[ -z "$OUT" ]]; then
  echo "No output folder given. Nothing was built." >&2
  exit 1
fi
OUT="${OUT/#\~/$HOME}"
[[ -e "$OUT" ]] && NEW_OUT=0 || NEW_OUT=1
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# The archive's build settings name the team: inside the repository the output must stay in dist/, which git ignores.
case "$OUT/" in
  "$ROOT/dist/"*) ;;
  "$ROOT"/*)
    [[ "$NEW_OUT" == 1 ]] && rmdir "$OUT"
    echo "The output folder is inside the repository but not in dist/ ($OUT). Use dist/ or a folder outside it." >&2
    exit 1 ;;
esac

for tool in xcodebuild pod pnpm node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found. Nothing was built." >&2; exit 1; }
done

IOS="$ROOT/ios/App"
PROJECT="$IOS/App.xcodeproj/project.pbxproj"
ARCHIVE="$OUT/Forge.xcarchive"
EXPORT="$OUT/export"
WORK="$(mktemp -d)"
cp "$PROJECT" "$WORK/project.pbxproj"
restore() {
  if ! cmp -s "$WORK/project.pbxproj" "$PROJECT"; then
    cp "$WORK/project.pbxproj" "$PROJECT"
    echo "xcodebuild changed project.pbxproj; it was put back as it was." >&2
  fi
  rm -rf "$WORK"
}
trap restore EXIT

echo "Bundling the web app."
(cd "$ROOT" && pnpm -s ios:web)
echo "Installing the pods."
(cd "$IOS" && pod install)

rm -rf "$ARCHIVE" "$EXPORT"
echo "Archiving (Release, team $TEAM)."
xcodebuild -workspace "$IOS/App.xcworkspace" -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$OUT/DerivedData" \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" archive
[[ -d "$ARCHIVE" ]] || { echo "The archive was not made at $ARCHIVE." >&2; exit 1; }

APP="$ARCHIVE/Products/Applications/App.app"
[[ -f "$APP/PrivacyInfo.xcprivacy" ]] || { echo "The archived app has no PrivacyInfo.xcprivacy." >&2; exit 1; }

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>export</string>
	<key>teamID</key>
	<string>$TEAM</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
EOF

echo "Exporting the IPA (to a folder; nothing is uploaded)."
if ! xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -allowProvisioningUpdates; then
  echo "The export failed; the archive is at $ARCHIVE. \"No Accounts\" or \"No profiles\" means Xcode has no" >&2
  echo "Apple account of the team (Xcode, Settings, Accounts) to make the App Store profile with (docs/IOS.md, TestFlight)." >&2
  exit 1
fi
IPA="$(ls "$EXPORT"/*.ipa 2>/dev/null | head -n 1)"
[[ -n "$IPA" ]] || { echo "The export made no IPA in $EXPORT." >&2; exit 1; }

INFO="$WORK/Info.plist"
unzip -p "$IPA" 'Payload/App.app/Info.plist' > "$INFO"
VERSION="$(plutil -extract CFBundleShortVersionString raw "$INFO")"
BUILD="$(plutil -extract CFBundleVersion raw "$INFO")"
unzip -l "$IPA" 'Payload/App.app/PrivacyInfo.xcprivacy' >/dev/null || { echo "The IPA has no PrivacyInfo.xcprivacy." >&2; exit 1; }

echo
echo "Archive:  $ARCHIVE"
echo "IPA:      $IPA"
echo "Size:     $(wc -c < "$IPA" | tr -d ' ') bytes"
echo "Version:  $VERSION (build $BUILD)"
echo
echo "Nothing was uploaded. Upload the IPA with Transporter, or the archive with Xcode's Organizer."
echo "Before the next upload, raise CURRENT_PROJECT_VERSION in ios/App/App.xcodeproj/project.pbxproj."
