#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
capture_tmp="$(mktemp -d /tmp/shouldertap-mac-capture.XXXXXX)"
trap 'rm -rf "$capture_tmp"' EXIT
# Same production views; compiling into one temporary module gives the harness access to internal models.
for source in "$root"/apps/macos/Sources/ShouldertapCore/*.swift "$root"/apps/macos/Sources/Shouldertap/{Overlay,Theme,Icons}.swift; do
  sed '/^import ShouldertapCore$/d' "$source" > "$capture_tmp/$(basename "$source")"
done
cp "$root/brand/app-store/capture-mac.swift" "$capture_tmp/CaptureMac.swift"
xcrun swiftc -swift-version 5 -parse-as-library "$capture_tmp"/*.swift -o "$capture_tmp/capture"
"$capture_tmp/capture" "$root" "$root/brand/app-store/captures/mac-overlay.png"
