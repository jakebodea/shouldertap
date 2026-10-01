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
swift build "${flags[@]}" --product Shouldertap >&2
bin="$(swift build "${flags[@]}" --show-bin-path)/Shouldertap"

app="build/$config/Shouldertap.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/Fonts"
cp "$bin" "$app/Contents/MacOS/Shouldertap"
cp Resources/Info.plist "$app/Contents/Info.plist"
cp Resources/Fonts/*.ttf Resources/Fonts/OFL.txt "$app/Contents/Resources/Fonts/"
iconutil -c icns Resources/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"

plist() { /usr/libexec/PlistBuddy -c "$1" "$app/Contents/Info.plist"; }
if [[ "$config" == "release" ]]; then
  strip -x "$app/Contents/MacOS/Shouldertap"
else
  # A separate identity, so a debug build never shares state with the installed app.
  plist "Set :CFBundleIdentifier app.shouldertap.mac.debug"
  plist "Set :CFBundleName Shouldertap Debug"
  plist "Add :NSAppTransportSecurity dict"
  plist "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true"
fi

codesign --force --sign - "$app" >&2
echo "$PWD/$app"
