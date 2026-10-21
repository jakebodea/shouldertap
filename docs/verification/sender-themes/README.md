# Sender themes: archived local UI evidence (October 21, 2026)

Captured on branch `t3/eac91992` without a deployed server. Not a hosted or payment test.

- `style-broadsheet.png`: web `/style` (iPhone 14 Pro Max viewport, Playwright Chromium against `vite dev`), a nonpatron previewing Broadsheet with the sender's real draft; "Use Broadsheet" disabled, patron offer below. Fonts are the bundled theme fonts.
- `style-patron.png`: the same page with an active patron status (API answers stubbed in the Playwright run only).
- `composer.png`: the composer with a persisted draft and the "Style Broadsheet" row. The API was unreachable, so history is empty.
- `mac-appearance-window.png`, `mac-overlay-broadsheet.png`: `SHOULDERTAP_RENDER_THEMES` debug renders from the Mac app. The window shows the free receiver controls (disabled: no server).

The T3 preview snapshot tool timed out, so Playwright was used directly. Not verified: real devices, Safari on iOS, Windows hardware, a live checkout.

Current hosted API/UI and actual sender-payment evidence is in [hosted-sandbox.md](hosted-sandbox.md). These original screenshots remain unchanged and do not prove that flow.
