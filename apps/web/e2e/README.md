# Mobile frame regression checks

From `apps/web`:

```sh
bunx playwright install webkit chromium
bun run test:e2e
```

The suite builds the production site and tests iPhone-sized WebKit in light and
dark mode plus Android-sized Chromium. It checks all four scene colors and wrap,
automatic cycling, the middle of a wipe, rapid replies, reduced motion,
landscape, a smaller viewport, and navigation. It asserts that the solid fixed
frame, both document backgrounds, and both theme-color tags track the current
scene. The HTML report includes screenshots during and after transitions.

Playwright does not render Safari's native status bar or toolbar. Confirm these
on an actual iPhone against the changed build:

1. Reload the landing page. Let it cycle moss → cobalt → rose → ochre → moss
   twice. Both top and bottom areas should follow each color rather than retain
   moss. Watch the transitions as well as the settled colors.
2. Tap **On it** repeatedly, including twice before a wipe finishes. The bars
   should end on the same color as the current scene.
3. Scroll inside the paper page to show/collapse Safari's toolbar, then rotate
   to landscape and back. Check for old-colored or white gaps and confirm the
   header and paper stay clear of the notch and home indicator.
4. Repeat in light/dark appearance and with Reduce Motion enabled. Navigate to
   Download and back; the returning page should start with moss at both edges.

Safari may apply its own blur/tint, so compare the hue and look for stale color,
rather than requiring the browser UI's pixels to exactly equal the swatch.
