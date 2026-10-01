#!/usr/bin/env bash
# Build Shouldertap.app from the Swift package.
#
#   scripts/build.sh          debug build talking to localhost (bundle id app.shouldertap.mac.debug)
#   scripts/build.sh release  universal release build talking to production
#
# Prints the path of the built app.
set -euo pipefail

cd "$(dirname "$0")/.."
config="${1:-debug}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ "$config" == "release" ]]; then
  flags=(-c release --arch arm64 --arch x86_64)
else
  flags=(-c debug)
fi
swift build "${flags[@]}" --product Shouldertap 2>&1 | grep -v "not stripping binary because it is signed" >&2
products="$(swift build "${flags[@]}" --show-bin-path)"

app="build/$config/Shouldertap.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/Fonts" "$app/Contents/Frameworks"
cp "$products/Shouldertap" "$app/Contents/MacOS/Shouldertap"
sparkle="$app/Contents/Frameworks/Sparkle.framework"
ditto "$products/Sparkle.framework" "$sparkle"
# Not needed at runtime: headers, and the XPC services only sandboxed apps use.
rm -rf "$sparkle/Headers" "$sparkle/PrivateHeaders" "$sparkle/Modules" \
  "$sparkle/Versions/B/Headers" "$sparkle/Versions/B/PrivateHeaders" "$sparkle/Versions/B/Modules" \
  "$sparkle/XPCServices" "$sparkle/Versions/B/XPCServices"
codesign --force --sign - "$sparkle" >&2
cp Resources/Info.plist "$app/Contents/Info.plist"
cp Resources/Fonts/*.ttf Resources/Fonts/OFL.txt "$app/Contents/Resources/Fonts/"
if [[ "$config" == "release" ]]; then
  iconutil -c icns Resources/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"
else
  # Debug builds get an orange DEBUG band on their icon.
  iconset="$(mktemp -d)/AppIcon.iconset"
  cp -R Resources/AppIcon.iconset "$iconset"
  swift scripts/debug-icon.swift "$iconset" >&2
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$iconset")"
fi

plist() { /usr/libexec/PlistBuddy -c "$1" "$app/Contents/Info.plist"; }
if [[ "$config" == "release" ]]; then
  strip -x "$app/Contents/MacOS/Shouldertap" 2>/dev/null
else
  # A separate identity, so a debug build never shares state with the installed app.
  plist "Set :CFBundleIdentifier app.shouldertap.mac.debug"
  plist "Set :CFBundleName Shouldertap Debug"
  plist "Add :NSAppTransportSecurity dict"
  plist "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true"
fi

codesign --force --sign - "$app" >&2
echo "$PWD/$app"
