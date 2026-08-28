#!/usr/bin/env bash
set -euo pipefail

yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install \
  "platform-tools" \
  "platforms;android-37.0" \
  "build-tools;37.0.0" \
  "ndk;27.1.12297006"

if [ -d "$ANDROID_HOME/platforms/android-37.0" ] && [ ! -e "$ANDROID_HOME/platforms/android-37" ]; then
  ln -s android-37.0 "$ANDROID_HOME/platforms/android-37"
fi

uv sync
