#!/usr/bin/env bash
# Builds battery-glance.apk without Gradle.
# Needs: aapt2, dx, zipalign, apksigner (Debian/Ubuntu android-sdk-build-tools) and an
# android.jar for API 33+ (e.g. Robolectric's android-all jar) passed as ANDROID_JAR for javac;
# resources link against the API 23 platform jar (old aapt2 cannot read newer resource tables).
set -euo pipefail
cd "$(dirname "$0")"
BT=${BUILD_TOOLS:-/usr/lib/android-sdk/build-tools/debian}
ANDROID_JAR=${ANDROID_JAR:?set ANDROID_JAR to an API 33+ android.jar}
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT"/{res,classes,dex}

"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "${RES_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 33 "$OUT/res.zip"

javac --release 8 -Xlint:-options -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find src -name '*.java')
"$BT/dx" --dex --min-sdk-version=26 --output="$OUT/dex/classes.dex" "$OUT/classes"
(cd "$OUT/dex" && zip -q ../unsigned.apk classes.dex)

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
KS=${KEYSTORE:-release.keystore}
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass battglance -keypass battglance -alias battglance \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Battery Glance" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:battglance --ks-key-alias battglance \
  --v4-signing-enabled false --out battery-glance.apk "$OUT/aligned.apk"
"$BT/apksigner" verify battery-glance.apk
echo "built $(pwd)/battery-glance.apk"
