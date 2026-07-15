#!/usr/bin/env bash
# Runs inside the CI emulator session: installs the APK, drives a real
# YouTube download through the app's test_url hook, and succeeds only
# when an actual MP3 lands in Download/yt-mp3.
set -uo pipefail

APK="${1:-app-debug.apk}"

adb install "$APK"
adb shell am start -n dev.aero.ytmp3/.MainActivity -e test_url "https://www.youtube.com/watch?v=jNQXAC9IVRw"

for i in $(seq 1 48); do
  sleep 10
  if adb shell "ls /sdcard/Download/yt-mp3/*.mp3" 2>/dev/null | grep -q '\.mp3'; then
    echo "DOWNLOAD TEST PASSED — MP3 produced:"
    adb shell ls -la /sdcard/Download/yt-mp3/
    exit 0
  fi
done

echo "DOWNLOAD TEST FAILED — app state follows"
adb shell uiautomator dump /sdcard/ui.xml || true
adb shell cat /sdcard/ui.xml | grep -o 'text="[^"]*"' | tail -50 || true
adb shell ls -la /sdcard/Download/yt-mp3/ || true
adb logcat -d | grep -iE "ytmp3|youtubedl|python" | tail -60 || true
exit 1
