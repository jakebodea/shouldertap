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
# a UTC timestamp, so every upload goes up; override with BUILD_NUMBER.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="$root/apps/ios/Shouldertap.xcodeproj"
out="$root/apps/ios/build/release"
build="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
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
