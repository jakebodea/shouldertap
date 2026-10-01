#!/usr/bin/env bash
# Test and build the native Mac app (apps/macos) as a universal binary,
# package it as a DMG, and upload it to the production download bucket.
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
out="$root/apps/macos/build/dmg"
bucket="shouldertap-releases"
upload=true
[[ "${1:-}" == "--no-upload" ]] && upload=false

version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$root/apps/macos/Resources/Info.plist")"
echo "==> Shouldertap $version"

echo "==> Testing"
(cd "$root/apps/macos" && DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" swift test --quiet)

echo "==> Building Release (arm64 + x86_64)"
app="$("$root/apps/macos/scripts/build.sh" release)"
lipo -info "$app/Contents/MacOS/Shouldertap"

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  echo "==> Signing with $SIGN_IDENTITY"
  codesign --force --timestamp --options runtime --sign "$SIGN_IDENTITY" "$app"
else
  echo "==> No SIGN_IDENTITY: ad-hoc signed (not notarized)"
fi
codesign --verify --deep --strict "$app"
du -sh "$app"

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
