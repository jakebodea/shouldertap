# Mac client efficiency research

Checked September 30, 2026 against Apple SDK headers and documentation, Swift.org, project docs and source, GitHub releases, and one published benchmark. A throwaway native prototype was built and run on this Mac. It lived in a scratch directory outside the repo. No repo code was changed, and the running Shouldertap app and `~/Library/Application Support/Shouldertap` were not touched (the running app was only observed read-only with `footprint`, `ps` and `top`). Numbers marked **measured** come from this machine. Every other number is cited or labelled as an estimate.

## Scope

The receiver is `apps/macos`: React Native macOS 0.83 on Hermes. It has about 1,700 lines of TS/TSX (`store.ts`, `menu-bar.tsx`, `overlay.tsx`, `ui.tsx`, `icons.tsx`, `native.ts`, `theme.ts`) plus about 700 lines of Swift (`OverlayController`, `AppDelegate`, `ShouldertapNative`, `ShouldertapMark`). It also compiles `packages/domain` (Effect Schema) and `packages/client` (the `HttpApiClient` facade and the live socket) from source. The question: which way of building it gives the smallest download and install, the lowest idle memory and CPU, and good energy use, without losing any function or the design in [design.md](../design.md)? Jake is open to a rewrite, including in Rust. Mac comes first. The [Windows plan](windows-client.md) (Electron, TypeScript) is separate and does not depend on this choice.

## Recommendation

**Rewrite the Mac receiver as a native Swift app: an AppKit shell with SwiftUI views, Swift 6, and macOS 14 as the minimum.** Keep AppKit for the parts that need exact control:

- an `NSStatusItem` with an `NSPopover`;
- one borderless `NSPanel` per `NSScreen`, at `.screenSaver` level, with `[.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]`;
- display-change and wake notifications.

Draw everything inside those windows with SwiftUI through `NSHostingView` or `NSHostingController`.

Other choices:

- Port the store, the live connection and the wire contracts to Swift (`@Observable` plus `Codable`).
- Store the credential in the Keychain.
- Use `SMAppService` for launch at login and Sparkle for updates.
- Keep the protocol in sync with shared JSON fixtures, captured from the real server by the existing integration suite, plus a Swift contract test against a local stack.

Why:

- **Size and memory drop by more than an order of magnitude** (measured, table below). The React Native runtime and Hermes make up almost all of today's 40 MB. Trimming cannot remove them.
- **Every hard requirement is AppKit anyway.** The overlay level, Spaces and full-screen behavior, per-screen windows, key focus, the status item, login item, Keychain, QR code (Core Image) and device name are all Apple APIs. Today they cross a JS bridge. Natively, the bridge disappears.
- **The design ports cleanly.** Bricolage Grotesque loads by PostScript name exactly as it does now (`ATSApplicationFontsPath`). Tracking, tabular figures, the colors in `packages/domain/src/colors.ts` and the popover's native vibrancy are all first-class in SwiftUI and AppKit.
- **Cost:** about 2 to 3 weeks of focused work (see Port estimate). The Mac client also leaves the TypeScript/Effect code-sharing story. The [architecture plan](../architecture.md) chose React Native macOS to maximize TypeScript reuse, so this reverses a recorded decision. The contract-test plan below is what makes that safe.

## Measured: native prototype vs the current app

Setup:

- **Machine:** Apple M4, 24 GB, macOS 15.7.4 (24G517), Xcode 26.3 (Swift 6.2.4, macOS SDK 26.2).
- **Displays:** two, a 4K external and the built-in Retina.

The prototype is one Swift file of about 420 lines in Swift 6 language mode:

- **Menu bar:** a status item with a SwiftUI popover showing a header, status, invite button, recent list and footer.
- **Overlay:** a borderless overlay panel on every screen with the real window configuration. It shows a sender-colored frame, a paper page, a 140 pt Bricolage ExtraBold message, three pills, 1/2/3/Escape keys, and a reply `TextField` with `@FocusState`.
- **Contracts and state:** `Codable` twins of `Tap`, `TapResponse`, `PersonColor` and `ServerEvent`, plus an `@Observable` store.
- **Socket:** a `URLSessionWebSocketTask` connected to `wss://echo.websocket.org`, with a receive loop, a 25 s ping and backoff.

Build: `swiftc -O -wmo`, arm64 and x86_64 sliced with `lipo`, `strip -x`, ad-hoc signed. A demo tap was sent through the echo server, decoded as a real `ServerEvent`, and raised the overlays.

| | Current RN app (Release, universal) | Native prototype (Release, universal) |
| --- | --- | --- |
| Installed size | 40 MB (27 MB binary, 9.3 MB `hermesvm.framework`, 3.9 MB Hermes bytecode) | **792 KB** (measured): 504 KB binary, 270 KB of fonts |
| Per-arch binary | arm64 13.7 MB + 4.9 MB Hermes; x86_64 14.1 MB + 4.9 MB (measured, `lipo -detailed_info`) | arm64 248 KB, x86_64 224 KB (measured) |
| Download | 14.0 MB `Shouldertap-0.1.0.dmg` (UDZO, measured) | **354 KB** UDZO DMG, 318 KB zip (measured) |
| Idle footprint (menu bar only, socket open) | 40 MB (measured, same machine, running instance) | **13 MB** (measured) |
| With popover open | – | 23 MB (measured) |
| Peak, popover and then overlays on 2 displays | 86 MB `phys_footprint_peak` (measured) | **25–31 MB** peak over three runs; 23 MB after the overlays close (measured) |
| Threads at idle | 10 | 3–6 (measured) |
| Idle CPU | 0.0%; about 0.04 s of CPU over 7 min | 0.0%; about 0.01 s of CPU over 3 min (measured) |

Notes on the measurements:

- **The Mac was locked during the runs** (`NSWorkspace.frontmostApplication` was `loginwindow`). The overlays were created and ordered front on both displays (`overlays=2 screens=2`), but no app can take key focus over the lock screen. So **keyboard focus was not verified** (see Risks). Rendering while locked may also understate the peak. Re-run the prototype while unlocked to confirm it.
- **Fonts are a third of the native bundle.** Subsetting Bricolage to Latin would cut about 150 KB. It is not worth it.
- **Adding Sparkle** (below) takes the native app to about 3.6 MB installed. That is still about 11× smaller than today.
- **Rust core floor (measured):** linking a dependency-free Rust `staticlib` (Rust 1.93.1, `opt-level="z"`, LTO, `panic="abort"`) into the same app grew the arm64 binary from 237 KB to 473 KB. That is **+235 KB per architecture just for Rust `std`**, before any HTTP, TLS, WebSocket or JSON crates. A universal build doubles it.
- **Tauri, Slint, iced and egui were not built.** None of their crates were in the local cargo cache, so measuring them meant fetching hundreds of crates. Their numbers below are cited.

## Options compared

| | (a) RN, trimmed | (b) Native Swift | (c) Rust core + Swift UI (UniFFI) | (d) Tauri 2 | (e) Slint / iced / egui |
| --- | --- | --- | --- | --- | --- |
| Install size (universal) | Estimate ≥ 34 MB; about 20 MB if arm64-only | **0.8 MB; about 3.6 MB with Sparkle** (measured) | Native plus Rust: +0.47 MB floor (measured), realistically several MB with tokio, TLS, WebSocket and serde (estimate; no primary figure found) | About 5 MB on macOS arm64 ([Elanis benchmark](https://github.com/Elanis/web-to-desktop-framework-comparison), Sep 2026); "can be less than 600KB" ([Tauri](https://v2.tauri.app/start/)) | Not published; expect several MB (own renderer and text stack) |
| Idle memory | Estimate 30–35 MB (Hermes heap and RN runtime stay) | **13 MB** (measured) | About native + 1–5 MB (estimate) | About 95 MB (Elanis, main-process tree; WebKit's WebContent and Networking are separate XPC processes, [WebKit architecture](https://docs.webkit.org/Deep%20Dive/Architecture/WebKit2.html), probably not counted) | Unmeasured |
| Idle CPU / energy | 0% when idle; JS timers throttle under App Nap | 0% measured; timers and Observation are event-driven | Same as native if the Rust side is event-driven | Web content processes plus IPC; webview timers | egui repaints only on input or animation ([README](https://github.com/emilk/egui)); iced 0.14 added reactive rendering |
| Overlay: level, Spaces, full screen, every screen | Yes, via existing Swift | **Yes, direct** | Yes (the UI is Swift) | Partial. tao's `always_on_top` is `NSFloatingWindowLevel`, and all-workspaces sets only `CanJoinAllSpaces`, never `FullScreenAuxiliary` ([tao source](https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/macos/window.rs)); needs raw `ns_window()` or [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel); [#11488](https://github.com/tauri-apps/tauri/issues/11488) closed as not planned | No. winit `WindowLevel::AlwaysOnTop` is floating level, with no collection-behavior API ([winit 0.30.13](https://docs.rs/winit/0.30.13/)); needs objc2 calls |
| Key focus for reply field | Same AppKit calls | Same AppKit calls; `NSPanel` with `.nonactivatingPanel` available | Same as native | Webview-in-panel via plugin | Via raw handles |
| Design fidelity | Current | Custom font, tracking, `monospacedDigit`, colors, vibrancy popover: all native | Same as native | CSS, full fidelity; popover is a webview, not native vibrancy | Own text stacks. No OpenType features in iced `Font` ([docs](https://docs.rs/iced/0.14.0/iced/struct.Font.html)) or Slint `Text` ([docs](https://docs.slint.dev/latest/docs/slint/reference/elements/text/)); no native popover |
| Code sharing | TS domain and client, as today | None with TS: contracts duplicated as `Codable`, guarded by fixtures | Rust core shareable, but Windows is Electron/TS and web is TS, so nothing else would consume it | UI in TS/React; socket and secrets in Rust ([no official keychain plugin](https://v2.tauri.app/plugin/)) | Rust only |
| Maintenance | RN macOS tracks upstream with a lag (0.83.0 released 2026-09-30); Hermes polyfills; Metro outside the workspace | One language, Xcode only, no package manager needed except Sparkle | Two toolchains, FFI, universal Rust builds | Rust + TS + WebKit quirks | Rust UI toolkit churn; Slint needs a license choice ([pricing](https://slint.dev/pricing)) |
| Verdict | Reject: the floor stays about 20× native | **Recommended** | Not worth it for one consumer | Reject: larger memory, worse overlay story | Reject |

### (a) Keep React Native, trimmed

Size breakdown (measured):

- Main binary: 13.7 MB (arm64) + 14.1 MB (x86_64).
- `hermesvm`: 4.9 MB + 4.9 MB.
- `main.jsbundle`: 3.9 MB of Hermes bytecode (v96). The icons are already deep-imported (`icons.tsx`), so the bundle is mostly React, React Native and Effect.

Trimming options and what each saves:

- **Ship arm64-only:** about −19 MB. This drops Intel Macs, which macOS 26 still supports ([Tahoe is the last Intel release](https://www.macrumors.com/2026/04/18/macos-27-compatibility-change/)).
- **Remove `react-native-svg`:** draw icons natively.
- **Replace the Effect `HttpApiClient` with plain `fetch`:** perhaps 1–2 MB of bundle.

None of these touch the fixed cost of the RN core and Hermes. Hermes V1 is the default from RN 0.84, with qualitative "reduced memory" claims only ([RN 0.84](https://reactnative.dev/blog/2026/02/11/react-native-0.84)). It is not Static Hermes, so it does not remove the VM. The best realistic trimmed result is about 20–34 MB installed and about 30–35 MB idle (estimate), against 0.8 MB and 13 MB natively.

### (b) Native Swift

This is what was measured. It uses no third-party runtime: SwiftUI, AppKit, Foundation and the Swift runtime all ship with macOS, which is why the binary is under 300 KB per architecture. See Best practices below.

### (c) Rust core with a Swift UI via UniFFI

UniFFI 0.32.2 is mature and used in production:

- Firefox's [application-services](https://github.com/mozilla/application-services).
- The [matrix-rust-sdk bindings](https://github.com/matrix-org/matrix-rust-sdk/tree/main/bindings).
- Bitwarden's [sdk-internal](https://github.com/bitwarden/sdk-internal).

It maps Rust `async` functions to Swift `async` ([futures](https://mozilla.github.io/uniffi-rs/latest/futures.html)), but cancellation does not propagate.

Here the core would be about 1,000 lines of merge rules, retry and socket code. On a Mac, Foundation already provides every piece: `URLSession` or Network, `Codable` and Keychain. A Rust version would add tokio, a TLS stack and a WebSocket crate, plus universal Rust builds and generated bindings. That buys nothing unless a second native client consumes the same core. The Windows plan is TypeScript and the web sender is TypeScript, so nothing would. Revisit only if Windows moves off Electron to a Rust-native client.

### (d) Tauri 2

Tauri 2.12.1 uses the system `WKWebView`. That keeps the download small (about 5 MB), but memory is not small. WebKit runs each web view's content in separate WebContent and Networking processes ([WebKit](https://docs.webkit.org/Deep%20Dive/Architecture/WebKit2.html)), so real footprint is the main process plus those helpers.

- **Memory evidence:** the Elanis CI benchmark reports about 95 MB for Tauri on macOS, and probably misses the XPC helpers. No primary source measures a minimal Tauri 2 app's full process tree.
- **Overlays multiply the cost:** each display's overlay would be another web view.
- **Overlays do not work out of the box:** window level and `fullScreenAuxiliary` need AppKit escape hatches anyway. Tauri's default activation policy is Regular ([`app.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/app.rs)); switching to Accessory is the workaround the maintainers gave for overlays over full-screen apps ([#11488](https://github.com/tauri-apps/tauri/issues/11488)).

### (e) Pure Rust UI (Slint 1.18.1, iced 0.14.0, egui 0.36.2)

These avoid a web view, but each loses on this product's two hardest requirements:

- **The overlay window.** All three sit on winit (or a winit-like layer) with no collection-behavior API and only the floating window level.
- **Typography.** Tabular figures and the `opsz` axis are not exposed in iced or Slint text. egui 0.34 added a font-variations API but no OpenType features API.

They also have no native vibrancy popover. Tray support comes from the separate `tray-icon` crate. Slint is GPLv3 unless you take its royalty-free or commercial license. These are good toolkits for cross-platform tools, but they are the wrong fit for a Mac-first app whose selling points are native feel and a precise overlay.

## Best practices for the native path

### Windows: overlay, popover, focus

- **Overlay window.** Use the same configuration as `OverlayController.swift` today: borderless, `level = .screenSaver`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]`, one window per `NSScreen.screens`, rebuilt on `NSApplication.didChangeScreenParametersNotification`.
  - The SDK header describes `.fullScreenAuxiliary` as windows that "can be shown with the fullscreen window".
  - It describes `.canJoinAllApplications` as for "floating windows and system overlays". Consider it as an addition; it can be combined with the Spaces flags (`NSWindow.h`, SDK 26.2).
  - Make the window an `NSPanel` subclass and override `canBecomeKey` to return `true`, so the SwiftUI `TextField` can take focus.
- **Focus under cooperative activation.** `activateIgnoringOtherApps:` is marked `API_TO_BE_DEPRECATED`. The header says the new `-activate` does not "guarantee that the app will be activated at all" (NSApplication.h, SDK 26.2; `yieldActivation(to:)` is macOS 14+). The current app relies on `NSApp.activate(ignoringOtherApps: true)`, so this applies to the React Native app just as much.
  - The robust pattern is a panel with `.nonactivatingPanel` style: it becomes the key window without activating the app. That is the Spotlight-style approach.
  - The prototype builds both variants. Test on an unlocked Mac against Safari, Xcode, a full-screen video and Keynote in play mode.
- **Popover.** Keep `NSStatusItem` + `NSPopover` + `NSHostingController`. SwiftUI's `MenuBarExtra` (macOS 13) is simpler, but it has no public API to open it programmatically. The app does that on first run (`native.openPopover()` in `store.ts`).
- **Keys.** SwiftUI `onKeyPress` (macOS 14) handles 1/2/3 and Escape inside the overlay. That removes the `NSEvent` local monitor that React Native needed.

### Credential: Keychain vs file

With Developer ID signing, move the credential into the Keychain using `SecItem`. Apple's [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) says to prefer the data protection keychain, but on macOS its access groups come from entitlements that "must be authorized by a provisioning profile". There are two workable routes:

1. **Recommended:** create a Developer ID provisioning profile for the App ID in the developer portal and embed it; Xcode automatic signing does this. Then use `kSecUseDataProtectionKeychain: true` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Without the profile, calls fail with `-34018` ([forum](https://developer.apple.com/forums/thread/114456)).
2. **Fallback:** the file-based login keychain. Its ACL trusts the app's designated requirement, which stays stable across Developer ID-signed updates. It only prompts for ad-hoc rebuilds, which is the reason the README gives for today's file.

Keep an owner-only-file backend for Debug builds. On first launch of the native release, read the old `credential.secret` file, write it to the Keychain, then delete the file. Pending acks are not secret and can stay in `UserDefaults`, as today.

### Launch at login

Use `SMAppService.mainApp.register()` / `unregister()` (macOS 13+), as the app already does. Also handle `.requiresApproval` by offering `SMAppService.openSystemSettingsLoginItems()` ([SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)). Don't register automatically; keep the "Open at login" switch.

### Networking: URLSessionWebSocketTask vs Network.framework, and sleep/wake

Both work. The prototype used `URLSessionWebSocketTask` (macOS 10.15+; async `receive()`, `sendPing`) and it was trivial.

Apple's [TN3151](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api) says: "Unless you have a specific reason to use URLSession, use Network framework for new WebSocket code." The Network framework gives two things the socket needs:

- **Connection-state updates.** A connection moves through ready, waiting and preparing, and NWConnection adds viability and better-path handlers. Those map directly onto the `connecting`/`live`/`offline` status.
- **A structured-concurrency API.** `NetworkConnection` (macOS 26, [WWDC25 session 250](https://developer.apple.com/videos/play/wwdc2025/250/)) waits for ready instead of failing.

Recommendation:

- Put the socket behind a small `LiveTransport` protocol and implement it with `NWConnection` + `NWProtocolWebSocket` on macOS 14. Swap in `NetworkConnection` when the minimum reaches 26.
- Keep the HTTPS commands on `URLSession`.
- Keep the protocol identical to `packages/client/src/live.ts`:
  - exchange the credential for a one-time ticket, then connect with `?ticket=`;
  - back off 1/2/5/10/30 s;
  - resync (`GET /v1/me`) after every open and on `credentials` events;
  - stop and forget on `revoked` or on a 401;
  - resync on an unknown event instead of failing.
- Send the text `"ping"`, not a protocol ping frame. The Durable Object's auto-response pair is the text `"ping"`→`"pong"` (`apps/server/src/Inbox.ts`), which answers without waking the object.
- **Sleep/wake:** on `NSWorkspace.willSleepNotification`, close the socket cleanly. On `didWakeNotification` and `screensDidWakeNotification`, and when `NWPathMonitor` reports a new satisfied path, call `nudge()`: reset the backoff and reconnect or resync. This mirrors `nudge()` in `live.ts`. Pending acks are persisted and retried as today, so an answer given while offline survives sleep.

### Updates: Sparkle

Use Sparkle 2.10.0 (released 2026-09-13; requires macOS 12).

- **Size.** The maintainer puts the embedded framework at about 2.8 MB, or about 1.5 MB with optional parts removed ([discussion #2706](https://github.com/sparkle-project/Sparkle/discussions/2706)). The release archives are 16.3 MB (`tar.xz`) and 10.2 MB (SwiftPM zip), because they include tools and symbols ([release](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.0)).
- **Setup.** It needs EdDSA keys (`generate_keys`, `SUPublicEDKey`) and an appcast at `SUFeedURL` ([docs](https://sparkle-project.org/documentation/)). Host the appcast and DMGs in the existing `shouldertap-releases` R2 bucket behind `download.shouldertap.app`, next to `Shouldertap.dmg`. The XPC services are only for sandboxed apps ([sandboxing](https://sparkle-project.org/documentation/sandboxing/)), so leave them out.
- **Alternative.** Sparkle will be about 3/4 of the installed app. The smaller option is a roughly 100-line "new version available" check that opens the download page. It adds about 0 MB but gives no silent install. Sparkle's secure, signed, delta-capable updates are worth 2.8 MB.

### Swift 6 concurrency

Use Swift 6 language mode with the Swift 6.2 "approachable concurrency" defaults: default main-actor isolation, nonisolated async functions running in the caller's context, and `@concurrent` for explicit parallel work ([Swift 6.2 released](https://www.swift.org/blog/swift-6.2-released/)). The whole app is UI plus one socket, so main-actor-by-default fits.

- Make `Store` `@MainActor @Observable`.
- The socket's receive loop is an `async` task.
- JSON decoding of these small payloads can stay on the main actor. Mark a decoder `@concurrent` only if profiling says so.

Friction found in the prototype (measured):

- `NSAnimationContext`'s `completionHandler` is `@Sendable`, so mutating windows inside it is an error. Wrap the body in `MainActor.assumeIsolated`.
- `NotificationCenter` block observers need `MainActor.assumeIsolated` even with `queue: .main`.
- The prototype compiled warning-free after those two fixes.

### Minimum macOS version

Keep **14**, as today. It provides:

- `@Observable` (Observation);
- SwiftUI `onKeyPress`;
- `yieldActivation` / cooperative activation APIs;
- `SMAppService` (13).

It also covers every Intel Mac that runs 14–26.

Raising the minimum would bring:

- **15:** the `Synchronization` module (`Mutex`) and newer SwiftUI window modifiers, none of which this app needs.
- **26:** `NetworkConnection` and Liquid Glass. But 26 is also the last Intel release ([MacRumors](https://www.macrumors.com/2026/04/18/macos-27-compatibility-change/)), and a 26 minimum would cut off everyone on 14–15.

Revisit when the analytics show 14–15 below about 10%.

### Energy

- **App Nap is the friend here.** A menu-bar-only app with no visible window qualifies. App Nap lowers priority and "reduces the frequency with which the app's timers are fired" ([App Nap](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html)). Network data still arrives. Do not take a `ProcessInfo.beginActivity` assertion while idle. While overlays are visible the app is not napped anyway.
- **Give every timer a tolerance of at least 10%** ([Timers](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)):
  - 25 s ping ± 5 s, as in the prototype (`Task.sleep(for:tolerance:)`);
  - 10 s ack retry ± 2 s.
  - Stop them when nothing is pending.
- **Fix the knock animation.** Today `AppDelegate.setPending` runs a **60 Hz timer for as long as any tap is pending**. It re-renders the status item image every frame, even in the 3.1 s of each 4 s cycle when nothing moves. That is the largest avoidable energy cost in the current app, and it is worth fixing even if nothing else changes. Natively, run a Core Animation or 0.9 s frame burst, then schedule the next knock with a tolerant one-shot timer.
- **Update "N minutes ago" labels once a minute.** Use `TimelineView(.periodic(from:by: 60))`. Avoid `Text(date, style: .relative)`, which redraws every second while an overlay is up.
- **Don't poll.** Observation drives the overlay. The prototype re-arms `withObservationTracking` on `store.active`, where today every `set()` calls `reconcileOverlay()`. Displays, wake and network changes all arrive as notifications.

## Port estimate

What moves, and roughly how big it gets in Swift:

| From | To | Swift lines (estimate) |
| --- | --- | --- |
| `packages/domain` contracts, colors, responses, errors (about 290 TS lines) | `Codable` structs and enums (`Tap`, `TapResponse`, `Credential`, `CredentialGrant`, `Invite`, `ConnectTicket`, `ReceiverSnapshot`, `ServerEvent` with a `v`/`type` switch, `PersonColor` with swatches, `ApiError` from status and `_tag`) and limits (40, 280) | 250 |
| `packages/client/src/api.ts` (170) | `ShouldertapAPI`: async `URLSession` calls for the 9 endpoints, bearer header, error mapping, `isRetryable` | 150 |
| `packages/client/src/live.ts` (207) | `LiveConnection` actor or main-actor class: ticket, connect, backoff, ping, resync, revoke, nudge, `mergeTap`, `mergeSnapshot` | 200 |
| `apps/macos/src/store.ts` (327) | `@Observable Store`: boot, setup, connect, resync, forget, pending acks and retry, active tap, `reportDisplayed`, invites, revoke | 280 |
| `overlay.tsx` (388) | `OverlayView` + `Pill`: `fitMessage`, fade and swap motion with Reduce Motion, reply mode, keys | 300 |
| `menu-bar.tsx` + `ui.tsx` + `icons.tsx` (845) | `MenuView` (setup, invite with QR, add Mac, pairings, recent, footer) plus 10 Hugeicons as SwiftUI `Shape`s or asset-catalog SVGs (MIT) | 650 |
| Existing Swift (about 700) | Keep `ShouldertapMark`; keep and adapt `OverlayController` to `NSHostingView`; `AppDelegate` without React; `ShouldertapNative` becomes plain services (`Secrets`, `LoginItem`, `QRCode`, `DeviceName`) | about 450 kept |

**Total: about 2,300 new Swift lines plus about 450 kept.** That replaces about 1,700 lines of TS/TSX, about 700 Swift/ObjC bridge lines, the polyfills, Metro and CocoaPods.

Milestones for one engineer working with an agent:

| # | Milestone | Effort | Exit criteria |
| --- | --- | --- | --- |
| 0 | Focus and overlay spike (extend the prototype) | 0.5–1 d | On an unlocked Mac with 2 displays: overlay above a full-screen app, on every Space, after hot-plug; reply field takes keys without a click (`NSPanel` vs `.nonactivatingPanel`); footprint re-measured |
| 1 | `ShouldertapKit` Swift package: contracts, API, fixtures tests | 1.5–2 d | Decodes every fixture; round-trips encode; contract test passes against `alchemy dev` |
| 2 | Live connection + store | 2–3 d | Pairs, receives live taps, answers, second Mac dismisses, offline ack retried, wake and network change reconnect |
| 3 | Overlay UI | 2 d | Matches `design.md` "Overlay" side by side with the RN build: sizes, tracking, pills, reply mode, motion, Reduce Motion |
| 4 | Popover UI | 2–3 d | Every current popover state (setup, create/join, invite with QR, add Mac code, pairings with revoke, recent, open at login, quit, knock animation) |
| 5 | Keychain migration, Developer ID signing, notarization, Sparkle, `release-mac.sh` | 1.5–2 d | Upgrade from the RN build keeps the pairing; Sparkle updates 0.2.0 → 0.2.1 from R2 |

**Total: about 10–13 working days (2–3 weeks).** Milestone 0 is the only one whose outcome could change the plan. Run the RN and native apps side by side on two Macs during milestones 2–4 to be sure the protocol behaves identically.

## Keeping the protocol in sync with `packages/domain`

The Effect schemas stay the source of truth, because the server and the web app use them. The Swift side is guarded three ways:

1. **Golden fixtures captured from the real server.** Add a capture mode to `apps/server/test/integ.test.ts` (for example `CAPTURE_FIXTURES=1`). While the suite runs its existing scenarios, it writes each raw response and socket event to `packages/domain/fixtures/*.json`: `createInbox`/`redeemInvite` grants, `me` snapshots (device and sender), `createInvite`, `connectTicket`, `markDisplayed`/`acknowledge` taps, `tap`/`credentials`/`revoked` events, and one error body per `_tag`.
   - Also add a Bun test that decodes every fixture with the matching Effect schema. That catches fixtures going stale on the TS side.
   - The Swift package's tests (Swift Testing) decode the same files, re-encode them and compare them as JSON.
2. **A generated contract snapshot.** effect 4.0.0-rc.115 ships `OpenApi.fromApi` (`effect/unstable/httpapi/OpenApi`) and `Schema.toJsonSchemaDocument`. Commit `packages/domain/openapi.json` and fail CI when it changes without a matching change under the Swift contracts directory. It can also feed `swift-openapi-generator` later if hand-written `Codable` starts to drift. For 9 endpoints, hand-written is smaller and has no dependencies.
3. **A live Swift contract test.** `swift test --filter Contract` against a local stack (`bun run dev`, then `STACK_URL=http://localhost:3000`). The integration suite already honors `STACK_URL`. It pairs a Mac, a second Mac and a sender, delivers a tap over the socket, acknowledges from Swift, and checks that the second connection sees the acknowledged tap. That mirrors "delivers a tap live, first acknowledgement wins" in the TS suite. Run it in CI next to `test:local`.

Decoding policy:

- Unknown `ServerEvent` types or versions trigger a resync, exactly as `live.ts` does.
- Decode `PersonColor` tolerantly: an unknown color becomes the `fallbackColor(id)` hash, ported with the same 31-multiplier loop. That way a new server-side color doesn't break the whole snapshot. This is more lenient than the TS client, where a new literal fails the decode.

## Risks

1. **Keyboard focus** (medium likelihood, high impact; applies to the current app too). Cooperative activation means `activate` may not activate. That risk was confirmed by the headers, but the behavior was not observed, because the test Mac was locked. Mitigation: a `.nonactivatingPanel` overlay that becomes key without app activation, with click-to-focus as the floor. Verify in milestone 0.
2. **Leaving TypeScript on the Mac** (certain, medium). Protocol changes now touch Swift as well as TS. Mitigated by server-captured fixtures, the OpenAPI snapshot check and the Swift contract test. It reverses the architecture plan's "broad TypeScript/Effect reuse" preference; record that decision in `docs/architecture.md`.
3. **Design drift** (medium, low). SwiftUI text layout differs from React Native's: line height of about 0.95 needs an `AttributedString` paragraph style or a small `NSTextView`, because `lineSpacing` can't go below the font's natural leading. Do a side-by-side screenshot review in milestones 3–4. The prototype's rendering was not visually inspected (screen locked).
4. **Keychain entitlement setup** (low, medium). Without the Developer ID provisioning profile, data-protection keychain calls fail with `-34018`. The fallback is the file-based login keychain. Test the upgrade path from the file-based credential before the first release.
5. **Sparkle** (low). It adds about 2.8 MB and an EdDSA key to guard. Store the private key like the notary credentials, outside the repo.
6. **Measurement conditions** (low). One machine, a locked session, ad-hoc signing, `swiftc` rather than an Xcode project. A real Xcode Release build with asset catalogs, the icon and Sparkle will be larger; expect about 4 MB. Re-measure at milestone 5.

## Decisions for Jake

1. **Go native (Swift, AppKit + SwiftUI)** and accept duplicating the contracts in Swift. Alternative: keep React Native and just fix the knock timer, accepting about 40 MB and 40 MB.
2. **Updater:** Sparkle (+2.8 MB, silent signed updates) or a tiny "new version" check (+0 MB, manual reinstall).
3. **Socket transport:** `NWConnection` (TN3151's advice, path events) or `URLSessionWebSocketTask` (what the prototype measured; simpler).
4. **Keychain route:** create a Developer ID provisioning profile (data protection keychain) or use the login keychain.
5. **Minimum macOS:** stay on 14 (recommended) or raise to 15.

## Sources

Apple:

- SDK 26.2 headers `AppKit/NSWindow.h` (collection behaviors, `NSWindowStyleMaskNonactivatingPanel`) and `AppKit/NSApplication.h` (`activateIgnoringOtherApps:` `API_TO_BE_DEPRECATED`, `activate`, `yieldActivation`).
- [TN3137 On Mac keychain APIs](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains), [TN3151 Choosing the right networking API](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api), [WWDC25 Use structured concurrency with Network framework](https://developer.apple.com/videos/play/wwdc2025/250/).
- [URLSessionWebSocketTask](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask), [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice), [App Nap](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html), [Timers](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html), [forum: -34018](https://developer.apple.com/forums/thread/114456).

Swift: [Swift 6.2 released](https://www.swift.org/blog/swift-6.2-released/).

Sparkle: [2.10.0 release](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.0), [documentation](https://sparkle-project.org/documentation/), [sandboxing](https://sparkle-project.org/documentation/sandboxing/), [framework size discussion #2706](https://github.com/sparkle-project/Sparkle/discussions/2706).

Tauri and WebKit: [Tauri start](https://v2.tauri.app/start/), [size](https://v2.tauri.app/concept/size/), [plugins](https://v2.tauri.app/plugin/), [tao macOS window source](https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/macos/window.rs), [#11488](https://github.com/tauri-apps/tauri/issues/11488), [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel), [Stronghold deprecation discussion](https://github.com/orgs/tauri-apps/discussions/7846), [WebKit process architecture](https://docs.webkit.org/Deep%20Dive/Architecture/WebKit2.html), [Elanis web-to-desktop benchmark](https://github.com/Elanis/web-to-desktop-framework-comparison) (refreshed 2026-09-04).

Rust UI: [Slint pricing and licenses](https://slint.dev/pricing), [Slint Text](https://docs.slint.dev/latest/docs/slint/reference/elements/text/), [Slint 1.17 tray](https://slint.dev/blog/slint-1.17-released), [iced 0.14.0](https://github.com/iced-rs/iced/releases/tag/0.14.0), [iced Font](https://docs.rs/iced/0.14.0/iced/struct.Font.html), [egui README](https://github.com/emilk/egui), [egui changelog](https://github.com/emilk/egui/blob/main/CHANGELOG.md), [winit 0.30.13](https://docs.rs/winit/0.30.13/), [tray-icon](https://github.com/tauri-apps/tray-icon).

UniFFI: [futures](https://mozilla.github.io/uniffi-rs/latest/futures.html), [foreign traits](https://mozilla.github.io/uniffi-rs/latest/foreign_traits.html), [application-services](https://github.com/mozilla/application-services), [matrix-rust-sdk bindings](https://github.com/matrix-org/matrix-rust-sdk/tree/main/bindings), [Bitwarden sdk-internal](https://github.com/bitwarden/sdk-internal).

React Native: [react-native-macos on npm](https://registry.npmjs.org/react-native-macos/latest) (0.83.0), [React Native 0.84 / Hermes V1](https://reactnative.dev/blog/2026/02/11/react-native-0.84).

Platform: [macOS 27 drops Intel (MacRumors)](https://www.macrumors.com/2026/04/18/macos-27-compatibility-change/).

Repo: `apps/macos/macos/Shouldertap-macOS/*.swift`, `apps/macos/src/store.ts`, `packages/client/src/live.ts`, `packages/domain/src/contracts.ts`, `apps/server/src/Inbox.ts` (ping auto-response), `apps/server/test/integ.test.ts` (`STACK_URL`), `scripts/release-mac.sh` (UDZO DMG).
