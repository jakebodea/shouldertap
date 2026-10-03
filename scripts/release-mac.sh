#!/usr/bin/env bash
# Test and build the native Mac app (apps/macos) as a universal binary,
# package it as a DMG, and upload it to the production download bucket.
#
#   scripts/release-mac.sh              build, package, upload
#   scripts/release-mac.sh --no-upload  build and package only
#
# Signing is optional; releases use the Developer ID:
#   SIGN_IDENTITY="Developer ID Application: Jake Bodea (6C46GY4Z38)"  signs with the hardened runtime
#   Notarizing (and stapling) uses either an App Store Connect API key
#     NOTARY_KEY=~/.appstoreconnect/AuthKey_XXXX.p8 NOTARY_KEY_ID=XXXX NOTARY_ISSUER=<uuid>
#   (the same key as ASC_KEY_* in Infisical; no keychain or Apple ID password), or
#     NOTARY_PROFILE=shouldertap  (xcrun notarytool store-credentials shouldertap)
# Without them the build is ad-hoc signed and Gatekeeper asks users to allow it
# in System Settings on first open.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/macos/build/dmg"
bucket="shouldertap-releases"
downloads="${DOWNLOADS_URL:-https://download.shouldertap.app}"
upload=true
[[ "${1:-}" == "--no-upload" ]] && upload=false

plist="$root/apps/macos/Resources/Info.plist"
version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist")"
build="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$plist")"
echo "==> Shouldertap $version"

echo "==> Testing"
(cd "$root/apps/macos" && DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" swift test --quiet)

echo "==> Building Release (arm64 + x86_64)"
app="$("$root/apps/macos/scripts/build.sh" release)"
lipo -info "$app/Contents/MacOS/Shouldertap"

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  echo "==> Signing with $SIGN_IDENTITY"
  # Inside out, as Sparkle documents for Developer ID apps: notarization
  # rejects any nested code that isn't signed with the hardened runtime.
  sign() { codesign --force --timestamp --options runtime --sign "$SIGN_IDENTITY" "$@"; }
  sparkle="$app/Contents/Frameworks/Sparkle.framework"
  sign "$sparkle/Versions/B/Autoupdate"
  sign "$sparkle/Versions/B/Updater.app"
  sign "$sparkle"
  sign "$app"
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
  notary=()
  if [[ -n "${NOTARY_KEY:-}" ]]; then
    notary=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  elif [[ -n "${NOTARY_PROFILE:-}" ]]; then
    notary=(--keychain-profile "$NOTARY_PROFILE")
  fi
  if (( ${#notary[@]} )); then
    echo "==> Notarizing"
    xcrun notarytool submit "$dmg" "${notary[@]}" --wait
    xcrun stapler staple "$dmg"
  fi
fi

shasum -a 256 "$dmg"
du -h "$dmg"

# The Sparkle feed: one item, the newest build, EdDSA-signed with the key in
# the login keychain (account app.shouldertap.mac; see the README).
echo "==> Signing the update feed"
sparkle_bin="$root/apps/macos/.build/artifacts/sparkle/Sparkle/bin"
signature="$("$sparkle_bin/sign_update" --account app.shouldertap.mac "$dmg")"
cat > "$out/appcast.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Shouldertap</title>
    <item>
      <title>Shouldertap $version</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$build</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure url="$downloads/Shouldertap-$version.dmg" type="application/octet-stream" $signature/>
    </item>
  </channel>
</rss>
XML

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
# Last, so the feed never points at a DMG that isn't up yet.
bunx wrangler r2 object put "$bucket/appcast.xml" --remote --file "$out/appcast.xml" \
  --content-type application/rss+xml --cache-control "public, max-age=300"

echo "==> Live at https://download.shouldertap.app/Shouldertap.dmg"
