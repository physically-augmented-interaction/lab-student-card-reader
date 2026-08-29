#!/usr/bin/env bash
set -euo pipefail

yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install \
  "platform-tools" \
  "build-tools;37.0.0" \
  "ndk;27.1.12297006"

if ! sdkmanager --install "platforms;android-37"; then
  sdkmanager --install "platforms;android-37.0"
fi

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -n "$sdk_root" ] && [ -d "$sdk_root/platforms/android-37.0" ] && [ ! -e "$sdk_root/platforms/android-37" ]; then
  ln -s android-37.0 "$sdk_root/platforms/android-37"
fi
