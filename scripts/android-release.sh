#!/usr/bin/env bash
# Builds the Forge Android app's release APK and signs it with a keystore the owner supplies.
#
#   scripts/android-release.sh [--keystore <file>] [--alias <key alias>] [--flavour universal|privatevoice]
#
# --flavour picks the APK (docs/ANDROID.md, Two APKs): universal (the default) is Forge, for every phone;
# privatevoice is Forge Private Voice, the same app with its own speech to text, for GrapheneOS.
#
# It asks for the keystore file (unless --keystore is given) before it builds anything. apksigner then
# asks for the keystore's password itself, on this terminal: the password never passes through this
# script, its arguments, the environment or a log. No keystore is ever created here; make one once with
# keytool (docs/ANDROID.md) and keep it, and its password, outside this repository. Phones only accept an
# update signed with the same key as the app they have.
#
# Output: dist/forge-<version>.apk (or dist/forge-private-voice-<version>.apk), its SHA-256, and the signing
# certificate's SHA-256. Put the APK where FORGE_APK_PATH (or FORGE_APK_PRIVATE_VOICE_PATH) points on the
# server and /download offers it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE=""
ALIAS=""
FLAVOUR="universal"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keystore) KEYSTORE="${2:-}"; shift 2 ;;
    --alias) ALIAS="${2:-}"; shift 2 ;;
    --flavour) FLAVOUR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$FLAVOUR" in
  universal) NAME="forge"; TASK="assembleUniversalRelease"; ENV_NAME="FORGE_APK_PATH" ;;
  privatevoice) NAME="forge-private-voice"; TASK="assemblePrivatevoiceRelease"; ENV_NAME="FORGE_APK_PRIVATE_VOICE_PATH" ;;
  *) echo "Unknown flavour: $FLAVOUR (universal or privatevoice)" >&2; exit 2 ;;
esac

if [[ -z "$KEYSTORE" ]]; then
  read -r -p "Keystore file (.jks or .keystore): " KEYSTORE
fi
KEYSTORE="${KEYSTORE/#\~/$HOME}"
if [[ -z "$KEYSTORE" ]]; then
  echo "No keystore given. Nothing was built." >&2
  exit 1
fi
if [[ ! -f "$KEYSTORE" ]]; then
  echo "No keystore at $KEYSTORE. Nothing was built." >&2
  exit 1
fi
case "$(cd "$(dirname "$KEYSTORE")" && pwd)/" in
  "$ROOT"/*) echo "The keystore is inside the repository ($KEYSTORE). Move it out, so it can never be committed." >&2; exit 1 ;;
esac
if [[ -z "$ALIAS" ]]; then
  read -r -p "Key alias (Enter if the keystore holds one key): " ALIAS
fi

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)"
if [[ -z "$BT" || ! -x "$BT/apksigner" || ! -x "$BT/zipalign" ]]; then
  echo "apksigner and zipalign not found under $SDK/build-tools. Set ANDROID_HOME." >&2
  exit 1
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"
echo "Building the $FLAVOUR release APK (version $VERSION)."
(cd "$ROOT/android" && ./gradlew --console=plain -q clean "$TASK")
UNSIGNED="$ROOT/android/app/build/outputs/apk/$FLAVOUR/release/app-$FLAVOUR-release-unsigned.apk"
[[ -f "$UNSIGNED" ]] || { echo "The build made no APK at $UNSIGNED." >&2; exit 1; }

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$NAME-$VERSION.apk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Native libraries on 16 KB boundaries, so they load on phones with 16 KB pages (-p is only 4 KB).
"$BT/zipalign" -P 16 -f 4 "$UNSIGNED" "$WORK/aligned.apk"

SIGN=(--ks "$KEYSTORE")
[[ -n "$ALIAS" ]] && SIGN+=(--ks-key-alias "$ALIAS")
echo "apksigner asks for the keystore password next."
"$BT/apksigner" sign "${SIGN[@]}" --out "$OUT" "$WORK/aligned.apk"
rm -f "$OUT.idsig"

CERT="$("$BT/apksigner" verify --print-certs "$OUT" | sed -n 's/.*certificate SHA-256 digest: //p' | head -n 1)"
SUM="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
echo
echo "Signed:       $OUT"
echo "Size:         $(wc -c < "$OUT" | tr -d ' ') bytes"
echo "SHA-256:      $SUM"
echo "Certificate:  $CERT"
echo
echo "Put the APK where $ENV_NAME points on the server. /download shows the same SHA-256."
echo "Before the next release, raise versionCode in android/app/build.gradle."
