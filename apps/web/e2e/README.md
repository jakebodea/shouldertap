# Mobile frame regression checks

From `apps/web`:

```sh
bun test src
bunx playwright install webkit
bun run test:e2e
```

`bun test` covers wipe geometry. That math does not need a browser. The browser
suite builds the production site and tests one iPhone-sized WebKit project. It
checks all four scene colors and wrap, automatic cycling, the middle of a wipe,
rapid replies, reduced motion, landscape, a smaller viewport, and navigation.
It asserts that the absolute frame, both document backgrounds, and both
theme-color tags track the current scene. The HTML report includes screenshots
during and after transitions.

The edge animation tests pause the actual wipe at 250ms, verify a blended top
color and an unchanged bottom color, then wait past the full duration to ensure
the tints stay paused. Resuming the wipe must finish both edges in the new color.

## Native Safari regression

On iOS 26.3, even a minimal fixed solid-color element retains its initial tint
in Safari's native bars when its background changes. Replacing the fixed element
also fails. Changing the shell to absolute positioning lets the document
background repaint those areas. Keep the shell absolute: CSS-only assertions
passed with the earlier fixed implementation despite this native failure.

With Pillow installed in your Python environment, open the landing page in
Safari on a booted iPhone simulator in portrait, keep it on screen, then run:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  python3 e2e/check-safari-tint.py --device <simulator-udid> --output /tmp/safari-tint
```

This captures native screenshots across all four colors and compares the status
and bottom toolbar areas with the frame. It rejects a blank page and persistent
stale colors, allowing a single sample within the 700ms wipe. It is a macOS
simulator check, separate from the Linux Playwright CI job. Single settled
screenshots can also be checked with `--screenshot <path>`.

Playwright does not render Safari's native status bar or toolbar. Confirm these
on an actual iPhone against the changed build:

1. Reload the landing page. Let it cycle moss → cobalt → rose → ochre → moss
   twice. Both top and bottom areas should follow each color rather than retain
   moss. During each wipe, the top should blend first; the bottom should hold
   the old color until the circle reaches it, then blend to the new color.
2. Tap **On it** repeatedly, including twice before a wipe finishes. The bars
   should end on the same color as the current scene.
3. Scroll inside the paper page to show/collapse Safari's toolbar, then rotate
   to landscape and back. Check for old-colored or white gaps and confirm the
   header and paper stay clear of the notch and home indicator.
4. Repeat in light/dark appearance and with Reduce Motion enabled. Navigate to
   Download and back; the returning page should start with moss at both edges.

Safari may apply its own blur/tint, so compare the hue and look for stale color,
rather than requiring the browser UI's pixels to exactly equal the swatch.
