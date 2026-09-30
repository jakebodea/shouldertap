#!/usr/bin/env bash
# Build the Release Mac app as a universal binary, package it as a DMG, and
# upload it to the production download bucket.
#
#   scripts/release-mac.sh              build, package, upload
#   scripts/release-mac.sh --no-upload  build and package only
#
# Signing is optional until there's an Apple Developer ID:
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"  signs with the hardened runtime
#   NOTARY_PROFILE=shouldertap  notarizes and staples (xcrun notarytool store-credentials shouldertap)
# Without them the build is ad-hoc signed and Gatekeeper asks users to allow it
# in System Settings on first open.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
macos="$root/apps/macos/macos"
out="$macos/build/release"
bucket="shouldertap-releases"
upload=true
[[ "${1:-}" == "--no-upload" ]] && upload=false

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

version="$(sed -n 's/.*MARKETING_VERSION = \(.*\);/\1/p' "$macos/Shouldertap.xcodeproj/project.pbxproj" | head -1)"
echo "==> Shouldertap $version"

echo "==> Syncing dependencies"
(cd "$root/apps/macos" && npm install --no-audit --no-fund --silent && npm run --silent pods >/dev/null)

echo "==> Building Release (arm64 + x86_64)"
xcodebuild \
  -workspace "$macos/Shouldertap.xcworkspace" \
  -scheme Shouldertap-macOS \
  -configuration Release \
  -derivedDataPath "$macos/build" \
  -destination 'generic/platform=macOS' \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  -quiet build

app="$macos/build/Build/Products/Release/Shouldertap.app"
lipo -info "$app/Contents/MacOS/Shouldertap"

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  echo "==> Signing with $SIGN_IDENTITY"
  # Inside out: nested code first, then the app.
  find "$app/Contents" \( -name '*.framework' -o -name '*.dylib' \) -prune -print0 |
    xargs -0 -I{} codesign --force --timestamp --options runtime --sign "$SIGN_IDENTITY" {}
  codesign --force --timestamp --options runtime --sign "$SIGN_IDENTITY" "$app"
else
  echo "==> No SIGN_IDENTITY: ad-hoc signing (not notarized)"
  codesign --force --deep --sign - "$app"
fi
codesign --verify --deep --strict "$app"

echo "==> Packaging DMG"
rm -rf "$out"
mkdir -p "$out/stage"
ditto "$app" "$out/stage/Shouldertap.app"
ln -s /Applications "$out/stage/Applications"
dmg="$out/Shouldertap-$version.dmg"
hdiutil create -quiet -volname Shouldertap -srcfolder "$out/stage" -fs HFS+ -format UDZO -ov "$dmg"
rm -rf "$out/stage"

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$dmg"
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    echo "==> Notarizing"
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
  fi
fi

shasum -a 256 "$dmg"
du -h "$dmg"

if ! $upload; then
  echo "==> Built $dmg (not uploaded)"
  exit 0
fi

echo "==> Uploading to r2://$bucket"
put() {
  bunx wrangler r2 object put "$bucket/$1" --remote --file "$dmg" \
    --content-type application/x-apple-diskimage \
    --content-disposition 'attachment; filename="Shouldertap.dmg"' \
    --cache-control "$2"
}
# Versioned copy is immutable; the stable name always points at the newest build.
put "Shouldertap-$version.dmg" "public, max-age=31536000, immutable"
put "Shouldertap.dmg" "public, max-age=300"

echo "==> Live at https://download.shouldertap.app/Shouldertap.dmg"
