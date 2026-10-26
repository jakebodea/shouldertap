#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
capture_tmp="$(mktemp -d /tmp/shouldertap-pc-capture.XXXXXX)"
trap 'rm -rf "$capture_tmp"' EXIT
# The real Windows overlay (apps/windows, GPUI) rendered on this Mac by the dev build's snapshot
# mode: it opens one 1440 × 900 window for a few seconds, captures only that window, then quits.
xcrun swiftc "$root/brand/app-store/window-id.swift" -o "$capture_tmp/window-id"
cargo build --quiet --manifest-path "$root/apps/windows/Cargo.toml" -p shouldertap
# The tap the slides show on a PC (see messages.mjs).
SHOULDERTAP_RENDER_THEMES="$capture_tmp" SHOULDERTAP_WINDOW_ID_TOOL="$capture_tmp/window-id" \
  SHOULDERTAP_RENDER_TAP="Take out the trash" SHOULDERTAP_RENDER_SENDER=Rosa SHOULDERTAP_RENDER_COLOR=plum \
  "$root/apps/windows/target/debug/shouldertap"
mv "$capture_tmp/tap.png" "$root/brand/app-store/captures/pc-overlay-trash.png"
