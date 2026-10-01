"""Check native Safari bars against the landing frame in a portrait screenshot.

Requires Pillow. Supply a simulator screenshot or capture a booted simulator
while the landing demo runs. This checks browser UI absent from Playwright.
"""

import argparse
import os
from pathlib import Path
import subprocess
import time

from PIL import Image

PALETTE = {(31, 90, 61), (35, 64, 200), (242, 196, 189), (232, 176, 34)}


def check(path):
    image = Image.open(path).convert("RGB")
    width, height = image.size
    points = {"top": (0.03, 0.04), "frame": (0.015, 0.25), "bottom": (0.03, 0.95)}
    colors = {
        label: image.getpixel((int(width * x), int(height * y)))
        for label, (x, y) in points.items()
    }
    if colors["frame"] not in PALETTE:
        raise SystemExit(f"FAIL: expected a landing scene, got {colors['frame']}")
    # Safari blur can slightly shift the bottom tint. A stale scene differs
    # by far more than this per-channel tolerance.
    failures = [
        label for label in ("top", "bottom")
        if max(abs(a - b) for a, b in zip(colors[label], colors["frame"])) > 12
    ]
    print(f"{path.name}: {colors}", flush=True)
    return colors["frame"], failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--screenshot", type=Path)
    source.add_argument("--device", help="Booted iPhone Simulator UDID")
    parser.add_argument("--output", type=Path, default=Path("/tmp/safari-tint"))
    parser.add_argument("--samples", type=int, default=24)
    args = parser.parse_args()
    if args.screenshot:
        _, failures = check(args.screenshot)
        if failures:
            raise SystemExit(f"FAIL: stale native Safari tint at {', '.join(failures)}")
        return
    args.output.mkdir(parents=True, exist_ok=True)
    seen = set()
    previous_failures = set()
    for index in range(args.samples):
        path = args.output / f"frame-{index:02d}.png"
        subprocess.run(
            ["xcrun", "simctl", "io", args.device, "screenshot", str(path)],
            check=True, env=os.environ, capture_output=True,
        )
        color, failures = check(path)
        seen.add(color)
        # The document switches immediately while the visible wipe takes
        # 700ms. One mid-wipe screenshot may differ; two samples a second
        # apart expose a persistent stale tint rather than that transition.
        persistent = previous_failures.intersection(failures)
        if persistent:
            raise SystemExit(f"FAIL: stale native Safari tint at {', '.join(sorted(persistent))}")
        previous_failures = set(failures)
        time.sleep(1)
    if previous_failures:
        raise SystemExit("FAIL: capture ended mid-transition; extend the sample count")
    if seen != PALETTE:
        raise SystemExit(f"FAIL: capture missed scene colors {PALETTE - seen}")
    print("PASS: native Safari bars followed the frame throughout capture")


if __name__ == "__main__":
    main()
