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
# The version and sequential build number live in apps/ios/Version.xcconfig.
# Increment CURRENT_PROJECT_VERSION before each upload, or override it with
# BUILD_NUMBER. .github/workflows/testflight.yml runs this when a PR labeled
# release:beta merges.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="$root/apps/ios/Shouldertap.xcodeproj"
out="$root/apps/ios/build/release"
build="${BUILD_NUMBER:-$(awk '$1 == "CURRENT_PROJECT_VERSION" && $2 == "=" {print $3}' "$root/apps/ios/Version.xcconfig")}"
if [[ ! "$build" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUILD_NUMBER must be a positive integer" >&2
  exit 1
fi
destination=upload
[[ "${1:-}" == "--no-upload" ]] && destination=export
source_revision="$(git -C "$root" rev-parse HEAD)"
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=normal)" ]]; then
  if [[ "$destination" == upload ]]; then
    echo "Refusing upload from uncommitted source. Commit the candidate first." >&2
    exit 1
  fi
  source_revision="$source_revision-dirty"
fi
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
  SHOULDERTAP_SOURCE_REVISION="$source_revision" \
  CODE_SIGNING_ALLOWED=NO

# An unsigned archive carries no entitlements, so the export wouldn't know
# the app needs push. Stamp them on with an ad-hoc signature (inside out);
# the export re-signs for distribution, keeping these capabilities and
# switching aps-environment to production.
app="$out/Shouldertap.xcarchive/Products/Applications/Shouldertap.app"
bundle=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
if [[ "$bundle" != app.shouldertap.iphone ]]; then
  echo "Refusing export for unexpected app identity: $bundle" >&2
  exit 1
fi
archived_revision=$(/usr/libexec/PlistBuddy -c 'Print ShouldertapSourceRevision' "$app/Info.plist")
if [[ "$archived_revision" != "$source_revision" ]]; then
  echo "Refusing export: archive source revision does not match the candidate." >&2
  exit 1
fi
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
