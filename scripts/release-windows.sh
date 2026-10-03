#!/usr/bin/env bash
# Test and build the Windows app (apps/windows), and upload it to the
# production download bucket with the feed its self-updater reads.
#
#   scripts/release-windows.sh              build, upload
#   scripts/release-windows.sh --no-upload  build only
#   EXE=path/to/Shouldertap.exe scripts/release-windows.sh
#                                           release an exe built elsewhere (CI)
#
# Signing is optional until Azure Artifact Signing is set up. SIGN_COMMAND is
# run with the exe's path appended, e.g. with jsign:
#   SIGN_COMMAND="jsign --storetype TRUSTEDSIGNING --keystore eus.codesigning.azure.net --storepass \$AZURE_TOKEN --alias <account>/<profile>"
# Unsigned builds work, but SmartScreen warns on first run. Once a release is
# signed, the app refuses unsigned updates.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/windows/build"
bucket="shouldertap-releases"
downloads="${DOWNLOADS_URL:-https://download.shouldertap.app}"
upload=true
[[ "${1:-}" == "--no-upload" ]] && upload=false

version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/apps/windows/Cargo.toml" | head -1)"
echo "==> Shouldertap for Windows $version"

if [[ -z "${EXE:-}" ]]; then
  echo "==> Testing"
  (cd "$root/apps/windows" && cargo test -p shouldertap-core --quiet)
  echo "==> Building"
  EXE="$("$root/apps/windows/scripts/build.sh" release)"
fi

mkdir -p "$out"
exe="$out/Shouldertap-Setup-$version.exe"
cp "$EXE" "$exe"

if [[ -n "${SIGN_COMMAND:-}" ]]; then
  echo "==> Signing"
  eval "$SIGN_COMMAND \"\$exe\""
else
  echo "==> No SIGN_COMMAND: unsigned (SmartScreen will warn)"
fi

if command -v sha256sum >/dev/null; then
  sha="$(sha256sum "$exe" | cut -d' ' -f1)"
else
  sha="$(shasum -a 256 "$exe" | cut -d' ' -f1)"
fi
du -h "$exe"
cat > "$out/latest.json" <<JSON
{"version":"$version","url":"$downloads/windows/Shouldertap-Setup-$version.exe","sha256":"$sha"}
JSON
cat "$out/latest.json"

if ! $upload; then
  echo "==> Built $exe (not uploaded)"
  exit 0
fi

echo "==> Uploading to r2://$bucket/windows"
put() {
  bunx wrangler r2 object put "$bucket/windows/$1" --remote --file "$exe" \
    --content-type application/vnd.microsoft.portable-executable \
    --content-disposition 'attachment; filename="Shouldertap-Setup.exe"' \
    --cache-control "$2"
}
# Versioned copy is immutable (winget and the updater point at it); the
# stable name always points at the newest build.
put "Shouldertap-Setup-$version.exe" "public, max-age=31536000, immutable"
put "Shouldertap-Setup.exe" "public, max-age=300"
# Last, so the feed never points at an exe that isn't up yet.
bunx wrangler r2 object put "$bucket/windows/latest.json" --remote --file "$out/latest.json" \
  --content-type application/json --cache-control "public, max-age=60"

echo "==> Live at $downloads/windows/Shouldertap-Setup.exe"
