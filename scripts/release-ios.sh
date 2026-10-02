#!/usr/bin/env bash
# Archive the iOS app (apps/ios) and upload it to App Store Connect, where it
# lands in TestFlight once processing finishes.
#
#   scripts/release-ios.sh              archive and upload
#   scripts/release-ios.sh --no-upload  archive and export an .ipa only
#
# Signing is automatic for team 6C46GY4Z38; xcodebuild creates the
# distribution certificate and profile as needed. It authenticates with the
# Apple ID signed in to Xcode (Settings > Accounts), or with an App Store
# Connect API key when all three are set:
#   ASC_KEY_PATH=~/.appstoreconnect/AuthKey_XXXX.p8 ASC_KEY_ID=XXXX ASC_ISSUER_ID=<uuid>
#
# The version is MARKETING_VERSION in the Xcode project. The build number is
# the commit count, which only goes up on main, so every upload from a newer
# commit beats the last (App Store Connect rejects repeats). Override with
# BUILD_NUMBER. .github/workflows/testflight.yml runs this when a PR labeled
# release:beta merges.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="$root/apps/ios/Shouldertap.xcodeproj"
out="$root/apps/ios/build/release"
build="${BUILD_NUMBER:-$(git -C "$root" rev-list --count HEAD)}"
destination=upload
[[ "${1:-}" == "--no-upload" ]] && destination=export
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

auth=(-allowProvisioningUpdates)
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  auth+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

echo "==> Testing ShouldertapCore"
(cd "$root/apps/macos" && swift test --quiet)

rm -rf "$out"
mkdir -p "$out"

# Archive unsigned: automatic signing would want a development profile,
# which needs a registered device. The export signs for distribution.
echo "==> Archiving (build $build)"
xcodebuild archive -quiet \
  -project "$project" -scheme ShouldertapIOS -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$out/Shouldertap.xcarchive" \
  CURRENT_PROJECT_VERSION="$build" \
  CODE_SIGNING_ALLOWED=NO

# An unsigned archive carries no entitlements, so the export wouldn't know
# the app needs push. Stamp them on with an ad-hoc signature (inside out);
# the export re-signs for distribution, keeping these capabilities and
# switching aps-environment to production.
app="$out/Shouldertap.xcarchive/Products/Applications/Shouldertap.app"
for extension in "$app"/PlugIns/*.appex; do
  codesign --force --sign - "$extension"
done
codesign --force --sign - --entitlements "$root/apps/ios/Shouldertap.entitlements" "$app"

cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>6C46GY4Z38</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict>
</plist>
PLIST

echo "==> Exporting ($destination)"
xcodebuild -exportArchive \
  -archivePath "$out/Shouldertap.xcarchive" \
  -exportOptionsPlist "$out/ExportOptions.plist" \
  -exportPath "$out/export" \
  "${auth[@]}"

if [[ "$destination" == upload ]]; then
  echo "==> Uploaded build $build; it appears in TestFlight after processing (usually 5-15 minutes)"
else
  ls -la "$out/export"
fi
