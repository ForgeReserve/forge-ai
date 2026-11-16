#!/usr/bin/env bash
# Builds the Android app's native natural voice (docs/VOICE.md, Native voice in the Android app) from
# Gradium's Phonon runtime, github.com/gradium-ai/xn-ptts (MIT OR Apache-2.0), at one pinned commit:
#   libptts_ffi.so   the C interface (ptts-ffi), Rust, built with cargo-ndk as upstream's
#                    android/build.sh does
#   libforge_ptts.so the app's JNI glue (android/app/src/main/cpp/forge_ptts_jni.c), the NDK's clang
# for arm64-v8a only, into android/app/src/main/jniLibs/arm64-v8a/. And for the other ABIs a phone may
# have (armeabi-v7a, x86, x86_64), an empty placeholder, libforge_noabi.so: Android refuses to install
# an APK whose native libraries are all for ABIs the phone lacks (INSTALL_FAILED_NO_MATCHING_ABIS), and
# 32-bit Android Go phones are among the slow phones this app is for. There the app reads with the
# browser's build of the voice. Every file is committed, with its SHA-256 in scripts/ptts/lock.json,
# so the Gradle build (and CI) needs neither Rust nor the NDK.
# A test (test/unit/android.test.ts) checks the committed files against the lock.
#
# Pinned: tag v0.7.0, commit 32c1554a (2026-11-09; the same release as the vendored phonon-tts 0.7.0).
# v0.7.1 (2026-11-13) was too new on 2026-11-14. Crates come from upstream's Cargo.lock (--locked).
#
# CPU features: target-cpu generic plus +dotprod,+fp16 (ARMv8.2), as upstream's build.sh: xn picks its
# q8_0 kernels at compile time (NEON is the arm64 baseline; dotprod gives the fast int8 dot products).
# The library crashes on a phone without them, so the app checks /proc/cpuinfo before it loads it
# (VoiceRules.cpuOk) and otherwise uses the browser build. xn has no other ARM feature switch: its
# "kai" feature is SME2, which no phone this app targets has. Release, fat LTO, one codegen unit,
# symbols stripped, 16 KB page alignment (Android 15).
#
#   scripts/android-ptts.sh            build, copy into the app, check against the lock
#   scripts/android-ptts.sh --record   the same, then write the new checksums into the lock
# Needs: git, cargo with cargo-ndk and the aarch64-linux-android target, the Android NDK
# (ANDROID_NDK_HOME, else $ANDROID_HOME/ndk/27.1.12297006, else ~/Library/Android/sdk/ndk/27.1.12297006).
set -euo pipefail
REPO=https://github.com/gradium-ai/xn-ptts
COMMIT=32c1554a8ce442d672de90fc82700bbdcf08d918
NDK_VERSION=27.1.12297006
API=28
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${PTTS_BUILD_DIR:-$ROOT/.tmp/ptts-build}"
SRC="$BUILD/xn-ptts"
OUT="$ROOT/android/app/src/main/jniLibs/arm64-v8a"
LIBS_DIR="$ROOT/android/app/src/main/jniLibs"
LOCK="$ROOT/scripts/ptts/lock.json"
RECORD=0
[ "${1:-}" = "--record" ] && RECORD=1

NDK="${ANDROID_NDK_HOME:-}"
[ -z "$NDK" ] && [ -n "${ANDROID_HOME:-}" ] && NDK="$ANDROID_HOME/ndk/$NDK_VERSION"
[ -z "$NDK" ] && NDK="$HOME/Library/Android/sdk/ndk/$NDK_VERSION"
[ -d "$NDK" ] || { echo "no Android NDK at $NDK (set ANDROID_NDK_HOME)" >&2; exit 1; }
export ANDROID_NDK_HOME="$NDK"

mkdir -p "$BUILD"
if [ ! -d "$SRC/.git" ]; then git clone --quiet "$REPO" "$SRC"; fi
git -C "$SRC" fetch --quiet origin "$COMMIT" 2>/dev/null || git -C "$SRC" fetch --quiet origin
git -C "$SRC" checkout --quiet --detach "$COMMIT"
test "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT"
test -z "$(git -C "$SRC" status --porcelain)" || { echo "the xn-ptts checkout has local changes" >&2; exit 1; }

# Upstream's flags (android/build.sh), which replace .cargo/config.toml's target-cpu=native (the build
# machine's CPU). RUSTFLAGS would take precedence over them and drop them.
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C strip=symbols -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,--build-id=none -C target-cpu=generic -C target-feature=+dotprod,+fp16 --remap-path-prefix=$SRC=/xn-ptts --remap-path-prefix=$HOME/.cargo=/cargo"
export CARGO_PROFILE_RELEASE_LTO=fat
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_OPT_LEVEL=3
export CARGO_TARGET_DIR="$BUILD/target"
rm -rf "$BUILD/jniLibs"
(cd "$SRC" && cargo ndk --platform "$API" -t arm64-v8a -o "$BUILD/jniLibs" build --release --locked -p ptts-ffi)
FFI="$BUILD/jniLibs/arm64-v8a/libptts_ffi.so"
test -f "$FFI"

HOST="$(ls "$NDK/toolchains/llvm/prebuilt" | head -1)"
CC="$NDK/toolchains/llvm/prebuilt/$HOST/bin/aarch64-linux-android$API-clang"
STRIP="$NDK/toolchains/llvm/prebuilt/$HOST/bin/llvm-strip"
JNI="$BUILD/jniLibs/arm64-v8a/libforge_ptts.so"
"$CC" -shared -fPIC -O2 -Wall -Werror -ffile-prefix-map="$ROOT"=/forge -ffile-prefix-map="$SRC"=/xn-ptts \
  -I "$SRC/ptts-ffi/include" -o "$JNI" "$ROOT/android/app/src/main/cpp/forge_ptts_jni.c" \
  -L "$BUILD/jniLibs/arm64-v8a" -lptts_ffi \
  -Wl,-z,max-page-size=16384 -Wl,--build-id=none -Wl,-soname,libforge_ptts.so
"$STRIP" --strip-unneeded "$JNI"

mkdir -p "$OUT"
cp "$FFI" "$JNI" "$OUT/"
LIBS="$ROOT/android/app/src/main/jniLibs"
STUB_C="$BUILD/noabi.c"
printf '/* Placeholder: this ABI has no native voice (scripts/android-ptts.sh). */\nint forge_noabi;\n' > "$STUB_C"
for pair in armeabi-v7a:armv7a-linux-androideabi x86:i686-linux-android x86_64:x86_64-linux-android; do
  abi="${pair%%:*}"; triple="${pair#*:}"
  mkdir -p "$LIBS/$abi"
  "$NDK/toolchains/llvm/prebuilt/$HOST/bin/$triple$API-clang" -shared -fPIC -O2 -ffile-prefix-map="$BUILD"=/build -o "$LIBS/$abi/libforge_noabi.so" "$STUB_C" \
    -Wl,-z,max-page-size=16384 -Wl,--build-id=none -Wl,-soname,libforge_noabi.so
  "$STRIP" --strip-unneeded "$LIBS/$abi/libforge_noabi.so"
done
# Licences: xn-ptts's own (MIT OR Apache-2.0), and those of every crate linked into the library.
LIC="$ROOT/public/vendor/licenses"
{ echo "xn-ptts (github.com/gradium-ai/xn-ptts, tag v0.7.0, commit $COMMIT), Gradium: the native runtime"
  echo "of the Android app's natural voice (android/app/src/main/jniLibs/arm64-v8a/libptts_ffi.so)."
  echo "Licensed MIT OR Apache-2.0, at your option. Both texts follow."; echo
  echo "================================ MIT ================================"; cat "$SRC/LICENSE-MIT"; echo
  echo "============================= Apache-2.0 ============================"; cat "$SRC/LICENSE-APACHE"; } > "$LIC/xn-ptts.txt"
node "$ROOT/scripts/ptts/licenses.ts" "$SRC" "$LIC/xn-ptts-THIRD_PARTY_LICENSES.md"
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { wc -c < "$1" | tr -d ' '; }
for f in arm64-v8a/libptts_ffi.so arm64-v8a/libforge_ptts.so armeabi-v7a/libforge_noabi.so x86/libforge_noabi.so x86_64/libforge_noabi.so; do echo "$f $(size "$LIBS/$f") bytes sha256 $(sum "$LIBS/$f")"; done

if [ "$RECORD" = 1 ]; then
  node -e '
    const fs = require("fs");
    const [lock, out, commit, ndk] = process.argv.slice(1);
    const l = JSON.parse(fs.readFileSync(lock, "utf8"));
    l.commit = commit;
    l.ndk = ndk;
    for (const f of l.files) {
      const b = fs.readFileSync(`${out}/${f.name}`);
      f.size = b.length;
      f.sha256 = require("crypto").createHash("sha256").update(b).digest("hex");
    }
    fs.writeFileSync(lock, JSON.stringify(l, null, 2) + "\n");
  ' "$LOCK" "$LIBS_DIR" "$COMMIT" "$NDK_VERSION"
  echo "recorded in $LOCK"
else
  node -e '
    const fs = require("fs");
    const [lock, out] = process.argv.slice(1);
    const l = JSON.parse(fs.readFileSync(lock, "utf8"));
    let bad = 0;
    for (const f of l.files) {
      const b = fs.readFileSync(`${out}/${f.name}`);
      const h = require("crypto").createHash("sha256").update(b).digest("hex");
      if (h !== f.sha256) { console.error(`${f.name}: sha256 ${h}, the lock says ${f.sha256}`); bad++; }
    }
    if (bad) { console.error("the build differs from the lock: run with --record to accept it"); process.exit(1); }
    console.log("matches the lock");
  ' "$LOCK" "$LIBS_DIR"
fi
