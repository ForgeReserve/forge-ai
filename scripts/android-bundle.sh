#!/usr/bin/env bash
# Builds Forge's Google Play app bundle (the universal flavour only) and signs it with the upload key.
#
#   scripts/android-bundle.sh [--keystore <file>] [--alias <key alias>]
#
# The upload key is named by the environment, as android/app/build.gradle reads it: FORGE_UPLOAD_KEYSTORE
# and FORGE_UPLOAD_KEY_ALIAS (or --keystore and --alias, or asked here), FORGE_UPLOAD_STORE_PASSWORD and,
# when the key has a password of its own, FORGE_UPLOAD_KEY_PASSWORD. A password that is not set is asked
# for on this terminal without showing it, and goes to Gradle only through its environment: never in an
# argument, never printed. No keystore is ever created here, and one inside this repository is refused.
# Make the upload key once with keytool (docs/ANDROID.md, Google Play) and keep it outside the repository.
#
# Output: dist/forge-<version>.aab, its size, versionCode and SHA-256, and the upload certificate's
# SHA-256. Upload the .aab in the Play Console. Forge Private Voice stays an APK (scripts/android-release.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="${FORGE_UPLOAD_KEYSTORE:-}"
ALIAS="${FORGE_UPLOAD_KEY_ALIAS:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keystore) KEYSTORE="${2:-}"; shift 2 ;;
    --alias) ALIAS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$KEYSTORE" ]]; then
  read -r -p "Upload keystore file (.jks or .keystore): " KEYSTORE
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
KEYSTORE="$(cd "$(dirname "$KEYSTORE")" && pwd)/$(basename "$KEYSTORE")"
case "$KEYSTORE" in
  "$ROOT"/*) echo "The keystore is inside the repository ($KEYSTORE). Move it out, so it can never be committed." >&2; exit 1 ;;
esac
if [[ -z "$ALIAS" ]]; then
  read -r -p "Upload key alias: " ALIAS
fi
if [[ -z "$ALIAS" ]]; then
  echo "No key alias given. Nothing was built." >&2
  exit 1
fi
if [[ -z "${FORGE_UPLOAD_STORE_PASSWORD:-}" ]]; then
  read -r -s -p "Keystore password (not shown): " FORGE_UPLOAD_STORE_PASSWORD
  echo
fi
if [[ -z "$FORGE_UPLOAD_STORE_PASSWORD" ]]; then
  echo "No keystore password given. Nothing was built." >&2
  exit 1
fi
export FORGE_UPLOAD_KEYSTORE="$KEYSTORE" FORGE_UPLOAD_KEY_ALIAS="$ALIAS" FORGE_UPLOAD_STORE_PASSWORD
[[ -n "${FORGE_UPLOAD_KEY_PASSWORD:-}" ]] && export FORGE_UPLOAD_KEY_PASSWORD

VERSION="$(node -p "require('$ROOT/package.json').version")"
CODE="$(sed -n 's/^ *versionCode \([0-9][0-9]*\).*/\1/p' "$ROOT/android/app/build.gradle" | head -n 1)"
echo "Building the Play bundle (version $VERSION, versionCode $CODE)."
(cd "$ROOT/android" && ./gradlew --console=plain -q clean bundleUniversalRelease)
AAB="$ROOT/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
[[ -f "$AAB" ]] || { echo "The build made no bundle at $AAB." >&2; exit 1; }

JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}"
# jarsigner -verify exits 0 on an unsigned file too; only "jar verified." means it is signed.
VERIFY="$("${JAVA_BIN}jarsigner" -verify "$AAB" 2>&1 || true)"
grep -q '^jar verified\.' <<< "$VERIFY" || { echo "The bundle at $AAB is not signed. Nothing was written to dist/." >&2; exit 1; }
mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/forge-$VERSION.aab"
cp "$AAB" "$OUT"

CERT="$("${JAVA_BIN}keytool" -printcert -jarfile "$OUT" | sed -n 's/^[[:space:]]*SHA256: //p' | head -n 1)"
SUM="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
echo
echo "Signed:       $OUT"
echo "Size:         $(wc -c < "$OUT" | tr -d ' ') bytes"
echo "versionCode:  $CODE"
echo "SHA-256:      $SUM"
echo "Upload cert:  $CERT"
echo
echo "Upload the bundle in the Play Console. Play signs what phones get with its app signing key."
echo "Before the next upload, raise versionCode in android/app/build.gradle."
