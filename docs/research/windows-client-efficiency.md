# Windows client: the efficient option

> **Decision (October 2, 2026):** built in Rust with [GPUI](https://gpui.rs) 0.2.2 (Zed's UI framework) on windows-rs for the platform parts, rather than hand-drawn Direct2D. GPUI is cross-platform, so the overlay and menu run and are checked on a Mac during development, and it saves most of the hand-drawn UI work (M2–M3 below). The cost: a 5.9 MB exe instead of about 2 MB (measured, cross-built, imports only in-box DLLs), higher RAM (a GPUI window on macOS measured 86 MB footprint; Windows unmeasured), and no screen reader support. The core is the standalone crate recommended in §4 (`apps/windows/core`); it isn't shared with the Mac via UniFFI. Everything below about Windows itself (z-order, focus, SmartScreen, signing, R2 layout) still applies; see the README for what's been verified.

Checked September 30, 2026. This is research and a plan only. No repo code was changed and nothing was deployed. Windows behavior has not been observed on hardware, because none was available. Numbers marked **(measured)** come from executables I cross-compiled on this Mac (details in [Measurements](#measurements)). All other numbers are cited.

This replaces the Electron recommendation in [windows-client.md](windows-client.md). That document is still right about the parts Windows decides for every framework: z-order, exclusive full-screen games, focus stealing, Focus Assist, SmartScreen and Artifact Signing, and R2 layout. Those sections are summarized here, not repeated.

## Answer in brief

- **Web/PWA: no.** No web API can cover every monitor above other apps, take keyboard focus, or stay up until answered. The web's best mechanism is a toast. Windows hides toasts during full-screen apps and games, and that is the moment Shouldertap exists for. A "lite" tier (an installed PWA with persistent toasts and On it / In 10 min buttons) is possible, but it is a different, weaker product. It needs Web Push on the backend. Don't build it now (see [PWA](#1-can-a-web-app-or-pwa-do-it)).
- **Recommendation:** a native **Rust** app on **windows-rs**: Win32 windows, Direct2D + DirectWrite for drawing, DirectComposition for the overlay's fades. Text fields are real Win32 EDIT controls, so IME and screen readers work without extra code. Custom-drawn controls get UI Automation through AccessKit. It ships as **one signed per-user exe of about 1.5–2.5 MB** that installs itself and updates itself from R2. Idle memory is **an expected 5–12 MB** with 0% CPU. It depends only on DLLs built into Windows 10 and 11.
  - A skeleton with the overlay drawing, tray icon, HTTPS client and WebSocket (TLS through Windows' built-in SChannel) is **872 KB (measured)**, or 402 KB xz-compressed.
  - For scale: the Electron plan was about 100 MB and 100+ MB of RAM. Today's Mac DMG is 14 MB.
- **Runner-up:** Rust + **Slint**, for about a week less UI work. The cost is a 7.7–8.2 MB exe (measured), roughly 20–30 MB of RAM, a "Made with Slint" attribution, and open Windows IME bugs.
- **Shared Rust core with the Mac via UniFFI: not now.** Write the Windows core as a standalone crate with no UI dependencies, so this stays possible later. The Mac should use native Swift for its protocol code. Keep the two in step with shared JSON fixtures and the existing Alchemy integration suite.
- **Effort:** about 21–29 working days (4.5–6 weeks) for one engineer working with an agent, plus Artifact Signing's 1–20 business-day identity check, which runs in parallel.

## 1. Can a web app or PWA do it?

**Verdict: it cannot do the core job on an ordinary PC.** Here is what each web capability can and cannot do on Windows 10/11 in Edge and Chrome:

| Need | Best web mechanism | What actually happens |
| --- | --- | --- |
| Arrive when no window is open | Web Push to a service worker | **Chrome:** the service worker only runs "if the browser is running" ([Chromium dev](https://groups.google.com/a/chromium.org/g/chromium-dev/c/jqrtJCPMb-k), [web.dev FAQ](https://web.dev/push-notifications-faq/)). Close the last Chrome window and pushes stop. The background-mode-for-push flag has been off by default since 2015 ([review](https://codereview.chromium.org/1124263002)). **Edge:** receives with the browser closed on Windows 10 20H1+ ([Edge blog](https://blogs.windows.com/msedgedev/2020/11/16/improving-notifications-badging-microsoft-edge/)). After a reboot that depends on Startup Boost or background mode, and their defaults vary ([StartupBoostEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/startupboostenabled), [BackgroundModeEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/backgroundmodeenabled)). |
| Stay until answered | `requireInteraction: true` | Chromium maps it to the Windows toast `scenario="reminder"`. It adds a button, because Windows ignores the flag on toasts without one (Chromium's `EnsureReminderHasButton`, quoted in [Mozilla bug 1794475](https://bugzilla.mozilla.org/show_bug.cgi?id=1794475)). Reminder toasts "stay on screen until the user dismisses it or takes action" ([toast content](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-content)). This is the closest the web gets. |
| On it / In 10 min | Notification `actions` | Windows allows two actions. `notificationclick` can `fetch()` the acknowledgement without opening a window ([Edge docs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/notifications-badges)). |
| Typed reply | Inline reply (`type: "text"`) | Chrome-only and non-standard ([chromestatus](https://chromestatus.com/feature/5743740178137088)); it never entered the spec. Current Windows 11 and Edge behavior is unconfirmed. Plan on clicking into the PWA window instead. |
| Dismiss on the other PCs | `registration.getNotifications({tag})` then `.close()` | Works ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/getNotifications)). But every push must show _some_ notification (`userVisibleOnly`), so the "dismiss" push has to replace the toast with a brief "Answered on another PC". |
| Above full-screen apps | none | Windows turns Do Not Disturb on automatically for full-screen apps and games, and suppressed toasts go to the notification center ([Focus](https://support.microsoft.com/en-us/windows/experience/focus-stay-on-task-without-distractions-in-windows)). Native apps can use `scenario="urgent"` to break through ([toast schema](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-toast)). The web cannot. |
| Cover every monitor | Fullscreen API + Window Management API | Both need a user gesture. Fullscreen without a gesture exists only for Isolated Web Apps, which are ChromeOS-only ([IWA allowlist](https://developer.chrome.com/docs/iwa/allowlist)), or for origins an admin lists in `AutomaticFullscreenAllowedForUrls` ([Edge policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/automaticfullscreenallowedforurls)). |
| Draw over other apps | Document Picture-in-Picture | It is always on top, but it needs a user gesture, it is size-clamped, the site can't position it, and it dies with its opener ([Chrome docs](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)). It cannot be opened from a push. |
| Title bar, badge | Window Controls Overlay, Badging API | WCO only lets a PWA draw in its own title bar ([Edge](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/window-controls-overlay)). The badge shows on the taskbar icon. Neither is an overlay. |
| Tray, launch at login | `run_on_os_login` | This is a user toggle, or an admin policy ([WebAppSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/webappsettings)). It opens a window; it is "not … a task running in the system tray" ([explainer](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/RunOnLogin/Explainer.md)). No tray API exists for PWAs. |
| Keyboard focus | none | A notification click gives `clients.openWindow()`/`focus()` a user activation. Nothing takes focus by itself. |
| Store packaging | PWABuilder MSIX | Changes none of the above: the app still runs in Edge ([Edge docs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store)). |

**A possible lite tier** ("notifications only, no install"): an installed PWA, Edge recommended. Web Push delivers a reminder toast per tap: the sender's name and message, On it and In 10 min buttons, and a click that opens the PWA to type a reply. Each tap uses its own `tag`, so answering elsewhere closes it, plus a taskbar badge. Its gaps:

- It is a toast, not a takeover.
- It is hidden during full-screen apps, games and Do Not Disturb, unless the user adds the browser to priority notifications (unconfirmed that this works).
- It has no focus.
- It needs a live browser process.
- It depends on FCM (Chrome) or WNS (Edge).

The backend would also need work, about 2–4 days:

- a VAPID key pair ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292));
- stored push subscriptions per device;
- RFC 8291 aes128gcm encryption in the Worker, which Workers' Web Crypto supports ([docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/));
- a "dismissed" fan-out push;
- an acknowledgement endpoint reachable from the service worker.

It is acceptable as a clearly labelled fallback for locked-down work PCs, or for Linux and ChromeOS later. It should not be the Windows product. **Recommendation: defer it.**

## 2. Native options compared

### Size, memory, dependencies

| Option | Exe / installer | Idle RAM | Runtime deps on Win 10/11 |
| --- | --- | --- | --- |
| **(a) Rust + windows-rs** (Win32, D2D, DWrite, DComp) | **312 KB** for the overlay + tray skeleton; **872 KB** with HTTPS + WebSocket over SChannel + JSON; **2.04 MB** with tokio + rustls/ring + reqwest instead **(all measured)**. Projected full app: 1.5–2.5 MB. | Expected 5–12 MB working set. This is an estimate and must be measured in M0. A trivial Win32 window is commonly cited at 1–3 MB (unconfirmed). | None beyond in-box DLLs (user32, d2d1, dwrite, dcomp, shell32; the UCRT has been in-box since Windows 10). **Measured** import table: only system DLLs. |
| **(b) Rust + Slint 1.18.1** | **7.7–8.2 MB (measured)** for a styled overlay with a TextInput, with LTO, opt-level z and strip; 3.4 MB xz. The maintainer quotes about 3.5 MB for an empty app ([discussion #9570](https://github.com/slint-ui/slint/discussions/9570)). The build includes the harfrust/skrifa/parley text stack. | About 30 MB RSS with the software renderer (Linux, [blog](https://trystan-sarrade.com/article/rust-gui-135mb-to-30mb-egui-to-slint/)). On Windows: 19.5 MB with skia on 1.17, but **155 MB with skia on 1.18**, because of wgpu D3D init ([#13470](https://github.com/slint-ui/slint/issues/13470)). Use femtovg or software. | None |
| **(c1) Rust + egui/eframe** | **3.3 MB (measured**, eframe 0.33.3, glow); 5.6 MB glow and 11.3 MB wgpu on 0.34 with LTO ([#7761](https://github.com/emilk/egui/issues/7761)) | glow: 31 MB Task Manager, 54 MB working set. wgpu DX12: 142 MB / 176 MB (same issue) | None (uses the OpenGL driver) |
| **(c2) Rust + iced 0.14** | No Windows measurement found | wgpu by default; tiny-skia is optional | None. **No accessibility** ([#552](https://github.com/iced-rs/iced/issues/552), open) |
| **(d) Tauri 2.12 on WebView2** | About 3 MB NSIS ([comparison](https://github.com/Elanis/web-to-desktop-framework-comparison)) | About 120 MB while a webview is alive: 5 MB Rust plus about 115 MB of WebView2 processes ([maintainer](https://github.com/orgs/tauri-apps/discussions/3162)). The tree is browser, GPU, utility and one renderer per view ([process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)). `MemoryUsageTargetLevel=Low` / `TrySuspendAsync` trim it, but not to native levels ([performance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)). | WebView2 Evergreen: in-box on Windows 11. On Windows 10 it is on "the vast majority" of devices, with a 2 MB bootstrapper otherwise ([distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)) |
| **(e1) C# WPF on .NET Framework 4.8** | Exe well under 1 MB (unconfirmed) | 26–48 MB for an empty WPF app on modern .NET ([Q&A](https://learn.microsoft.com/en-us/answers/questions/1285803/)). No Framework measurement found. | 4.8 is in-box on Windows 10 1903+ and Windows 11. 4.8.1 is in-box only on Windows 11 22H2+ ([versions](https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies)), so target 4.8. |
| **(e2) C# WinForms/WPF, .NET 9/10 NativeAOT** | Not supported: "trimming support for Windows Forms apps is disabled" ([docs](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities)). Without AOT you need the Desktop Runtime or a large self-contained build. | 6–7 MB for WinForms (Task Manager, [wpf#9017](https://github.com/dotnet/wpf/discussions/9017)) | Modern .NET is not in-box |
| **(e3) WinUI 3 / Windows App SDK 2.5** | The runtime redistributable is 56.8 MiB. Hello world: about 33 MiB framework-dependent (under 5 MiB LZMA) to about 200 MiB self-contained ([discussion](https://github.com/microsoft/microsoft-ui-xaml/discussions/7683)). NativeAOT has been supported since 1.6. | No trustworthy number found | Windows App Runtime (not in-box). **No tray API** ([WindowsAppSDK #713](https://github.com/microsoft/WindowsAppSDK/issues/713), backlog) |
| **(f) C++ Win32** | Tens to hundreds of KB | Same as (a) | None with `/MT` |
| _Reference: Electron 44_ | _About 100 MB installer, 158 MB runtime zip_ | _100+ MB_ | _None_ |

### Capability scorecard

✅ = first-party or trivial. ◐ = works, with noted effort. ✗ = missing or hard.

| Capability | (a) windows-rs | (b) Slint | (c) egui / iced | (d) Tauri | (e1) WPF 4.8 | (e3) WinUI 3 | (f) C++ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Topmost window per monitor, Per-Monitor DPI v2 | ✅ direct | ◐ via `with_winit_window` + raw HWND | ◐ same (winit) | ◐ `always_on_top`; open mixed-DPI and z-order issues ([#6843](https://github.com/tauri-apps/tauri/issues/6843), [#11176](https://github.com/tauri-apps/tauri/issues/11176)) | ◐ Topmost; WPF DPI v2 needs a manifest + 4.6.2+ | ◐ | ✅ |
| Keyboard focus for the reply (SetForegroundWindow limits) | ◐ same OS limit for all; direct control of the Alt-key fallback | ◐ raw HWND | ◐ raw HWND | ◐ tao already does the Alt trick | ◐ P/Invoke | ◐ | ◐ |
| Text input: IME + UI Automation | ✅ native EDIT child; ◐ AccessKit for custom controls | ◐ IME works, with open Windows bugs ([#10861](https://github.com/slint-ui/slint/issues/10861), [#5206](https://github.com/slint-ui/slint/issues/5206)); TextInput only partly exposed to UIA ([#2895](https://github.com/slint-ui/slint/issues/2895)) | ◐ egui: AccessKit, IME. ✗ iced: no a11y | ✅ Chromium | ✅ built in | ✅ | ✅ EDIT |
| Custom font, AA text, rounded shapes | ✅ best: DirectWrite in-memory fonts (1703+), **variable axes wght/opsz** (1709+, [IDWriteTextFormat3](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_3/nn-dwrite_3-idwritetextformat3)), character spacing, D2D SVG for Hugeicons | ✅ bundled fonts, letter-spacing, radius; ◐ static instances | ◐ egui has limited type control; animation is manual | ✅ **reuses the web CSS exactly** | ◐ no variable axes; static instances | ✅ | ✅ |
| Tray icon + popup | ✅ Shell_NotifyIcon v4 + `CalculatePopupWindowPosition`; the popup is custom-drawn (the main cost) | ✅ `SystemTrayIcon` since 1.17 ([blog](https://slint.dev/blog/slint-1.17-released)) | ◐ tray-icon crate | ✅ | ◐ WinForms NotifyIcon | ✗ | ✅ |
| Launch at login | ✅ HKCU Run key | ✅ | ✅ | ✅ plugin | ✅ | ◐ StartupTask if packaged | ✅ |
| Credential storage | ✅ CredWriteW / DPAPI | ✅ via windows crate | ✅ | ◐ no official keyring plugin | ✅ `ProtectedData` | ✅ | ✅ |
| WebSocket | ✅ tungstenite + SChannel (measured), or WinHTTP WebSocket, zero-dep ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpwebsocketcompleteupgrade)) | ✅ | ✅ | ✅ | ✅ ClientWebSocket | ✅ | ◐ WinHTTP by hand |
| Auto-update | ◐ ~250-line self-updater, or Velopack | ◐ same | ◐ same | ✅ updater plugin | ◐ ClickOnce / custom | ◐ App Installer | ◐ custom |
| Signing, Smart App Control | ✅ one exe to sign | ✅ one exe | ✅ one exe | ◐ exe + installer | ✅ | ◐ MSIX | ✅ |
| Installer: single exe, winget, Store | ✅ all three | ✅ | ✅ | ◐ NSIS/MSI | ✅ | ◐ MSIX | ✅ |

What every option shares: Windows alone decides z-order against exclusive full-screen games, whether `SetForegroundWindow` succeeds, Do Not Disturb, and the tray overflow. The earlier document's analysis of those still holds, and no framework changes them.

## 3. How the recommended build handles each requirement

- **Overlay on every monitor.**
  - Declare `PerMonitorV2` in the manifest (Windows 10 1703+, [DPI guide](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)).
  - For each `EnumDisplayMonitors` → `GetMonitorInfo(rcMonitor)`, create a `WS_POPUP` window with `WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOREDIRECTIONBITMAP`. Draw it with Direct2D into a DirectComposition visual, which gives GPU fades and scale. Composition also offers a Gaussian blur effect for the exit animation.
  - Handle `WM_DPICHANGED` and rebuild on `WM_DISPLAYCHANGE`.
  - Create fresh windows for each tap, so they land on the active virtual desktop ([IVirtualDesktopManager](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ivirtualdesktopmanager)).
  - Paint opaque in the sender's color first (per the earlier document's "rude window" warning), and set `NonRudeHWND` so the taskbar doesn't reorder.
  - Use `SHQueryUserNotificationState` to detect exclusive-D3D games so the copy can say so ([docs](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state)).
- **Focus.**
  - Call `SetForegroundWindow` on the overlay under the cursor. If it is refused, which is likely because the tap is not user input ([rules](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)), use the documented Alt enable: pressing Alt re-enables `SetForegroundWindow` ([LockSetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-locksetforegroundwindow)). That means `SendInput` Alt-down, `SetForegroundWindow`, then Alt-up, which now lands on our window instead of opening the other app's menu. tao does a version of this ([tray-icon/tao note](https://github.com/tauri-apps/plugins-workspace/issues/3548)).
  - Clicks always reach a topmost window, so clicking an answer works even without focus.
  - M0 measures how often focus succeeds.
- **Text input.** The reply field and setup fields are Win32 EDIT controls: styled with `WM_CTLCOLOREDIT`, given the Bricolage/Segoe font, and sitting inside a D2D-drawn pill. IME (IMM32/TSF) and UIA come from Windows. Custom-drawn pills, lists and avatars expose UIA through `accesskit_windows`. Writing TSF and UIA text providers by hand is avoided.
- **Design fidelity.**
  - DirectWrite loads Bricolage from memory (`IDWriteFactory5::CreateInMemoryFontFileLoader`, 1703+, [docs](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_3/nf-dwrite_3-idwritefactory5-createinmemoryfontfileloader)) and sets wght 800 / opsz 96 on the variable font (1709+). That is more faithful than the Mac's static instances.
  - Tracking −0.04em comes from `SetCharacterSpacing`, and `fitMessage` sizing from `IDWriteTextLayout` metrics.
  - Pills and pages are D2D rounded rects. Hugeicons render as SVG through Direct2D's SVG support, or are converted to path geometry at build time.
  - The popup is the Windows analogue of the Mac's "native surface, system font": a Mica backdrop and rounded corners through `DwmSetWindowAttribute` on Windows 11, Segoe UI Variable, with Bricolage only in the title.
- **Tray.**
  - `Shell_NotifyIconW` with `NOTIFYICON_VERSION_4` (`NIN_SELECT`, `WM_CONTEXTMENU`).
  - Place the popup with `Shell_NotifyIconGetRect` + `CalculatePopupWindowPosition` ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-calculatepopupwindowposition)).
  - Use a fixed `guidItem` once signed. The GUID is tied to the exe path unless the binaries are signed by the same company ([NOTIFYICONDATAW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw)), so keep a stable install path.
  - Ship light and dark icon frames for the knock animation.
  - Windows 11 hides new icons in the overflow, so first-run copy explains how to pin it.
- **Launch at login.** HKCU Run key (no MSIX, so no StartupTask).
- **Credential.** A Credential Manager generic credential (`CredWriteW`, a blob of 2560 bytes or less, `CRED_PERSIST_LOCAL_MACHINE`, [docs](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)) holds the device token. Like DPAPI, it works unsigned and matches a future Mac Keychain. Pending acknowledgements and prefs go in a JSON file under `%LocalAppData%\Shouldertap`.
- **Network.**
  - A blocking network thread runs `ureq` (HTTPS) and `tungstenite` (WebSocket), both on `native-tls` → SChannel, plus serde. Each call does the ticket exchange, backoff `[1,2,5,10,30]s`, a 25 s ping, and a resync on open. It posts events to the UI thread with `PostMessage`.
  - Resume, unlock and network-change events (`WM_POWERBROADCAST`, `WTSRegisterSessionNotification`) trigger `nudge()`.
  - Staying off tokio and rustls saves about 1.1 MB (measured), and SChannel respects the Windows certificate store and proxies.
- **Idle CPU.** Zero between events: the UI thread blocks in `GetMessage` and the network thread blocks in a socket read, waking every 25 s for the ping. Release the D2D/DComp devices when no overlay or popup is visible, so idle memory stays low.

## 4. Shared Rust core with the Mac (UniFFI) or separate implementations

**For a shared core:**

- One implementation of the receiver's logic: ticket/backoff/resync, `mergeTap`/`mergeSnapshot`, the persisted pending-ack queue, and display receipts.
- UniFFI is mature: 0.32.2 (September 2026) has async functions mapped to Swift `async` and foreign traits ([changelog](https://github.com/mozilla/uniffi-rs/blob/main/CHANGELOG.md), [futures](https://mozilla.github.io/uniffi-rs/latest/futures.html)). It is used in production by Mozilla application-services, matrix-rust-sdk (Element X) and Bitwarden.
- It would also serve a later Linux client.

**Against it:**

- The shared part is small: seven HTTP endpoints, one WebSocket, and about 530 lines of TypeScript today (`packages/client/src/live.ts` plus `apps/macos/src/store.ts`). In either language that is roughly 500–700 lines. The hard parts (overlay, focus, tray, fonts) are platform code either way.
- UniFFI adds real costs to the Mac, which is the priority platform:
  - a cargo + lipo + xcframework step in the Xcode and `release-mac.sh` build;
  - debugging across an FFI boundary;
  - Rust async runtime and TLS choices inside a Swift app (use native TLS, or it adds about 1 MB);
  - a second language for the Mac-only developer loop.
- Swift already has `URLSessionWebSocketTask`, the Keychain and `Codable`.
- There is a third implementation regardless: the TypeScript client, which the web sender uses. A Rust core would not remove it.

**Recommendation: implement separately, but keep it possible to share later.**

1. Put the Windows logic in `crates/shouldertap-core`: pure Rust, no Win32, no UI, with a `Platform` trait for secrets, prefs and events. If Linux arrives, or the protocol grows (for example end-to-end encryption), that crate can take UniFFI annotations and back the Mac too.
2. Make the protocol checkable across languages:
   - Export JSON Schema from the Effect Schemas in `packages/domain` (Effect's `JSONSchema` module).
   - Commit golden fixtures: a snapshot, each `ServerEvent`, and the error bodies.
   - Have each client's unit tests decode those fixtures.
   - Keep the Alchemy integration suite in `apps/server/test` as the behavioral oracle.

## 5. Recommendation and plan

**Build `apps/windows`: a Rust + windows-rs tray app, one signed per-user exe.**

Expected numbers, to be confirmed in M0 on hardware:

|  | Expected | Basis |
| --- | --- | --- |
| Download = installed size | 1.5–2.5 MB exe; about 0.8–1.2 MB compressed if it's ever zipped | 872 KB measured skeleton, plus popup UI, AccessKit, QR, and 2–3 font files (about 90 KB each, from `apps/macos/.../Fonts`) |
| Idle RAM | 5–12 MB working set | Estimate: Win32 baseline, network thread, and graphics devices released while idle |
| RAM with the overlay showing | +20–40 MB while visible, dropped on dismiss | Estimate: D3D/D2D/DComp devices and surfaces per monitor |
| Idle CPU | ~0% | Event-driven; one ping every 25 s |
| Runtime dependencies | None | Measured import table: system DLLs only |
| Install friction | Download, run, done. No UAC, no runtime, no reboot. `winget install Shouldertap.Shouldertap` for developers. | Per-user install to `%LocalAppData%\Programs\Shouldertap` |

### Install, update, sign

- **Single exe that installs itself.** Run from Downloads, `Shouldertap-Setup.exe` copies itself to `%LocalAppData%\Programs\Shouldertap\Shouldertap.exe`. It then:
  - writes the HKCU uninstall entry, a Start menu shortcut and the Run key;
  - starts the installed copy;
  - supports `--install --silent` and `--uninstall` so winget can use it.
  - This keeps the tray GUID's path stable across updates. Velopack ([Rust docs](https://docs.velopack.io/getting-started/rust)) is the off-the-shelf alternative with delta updates, but its `vpk` packager needs the .NET 8 SDK in CI and adds its own Update.exe. For a 2 MB app, full-file updates are fine.
- **Self-update.**
  - On launch and every 6 h, read `download.shouldertap.app/windows/latest.json` (`{version, url, sha256}`).
  - Download, check the SHA-256, and check with `WinVerifyTrust` that the publisher matches.
  - Rename the running exe (Windows allows that), move the new one into place, and restart. About 250 lines.
- **Signing.**
  - Use Azure Artifact Signing: Basic $9.99/month; individuals must be in the US or Canada ([quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). It is signed with the `azure/trusted-signing-action` in CI.
  - Smart App Control blocks unsigned apps without reputation ([SAC FAQ](https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003)). It can now be re-enabled without a reinstall, so expect more machines to have it on.
  - Signing does not give instant SmartScreen reputation ([code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)).
  - One exe means one signature. SAC and the Trusted Root Program accept RSA certificates only ([best practices](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices)).
- **winget.** A PR to `microsoft/winget-pkgs` needs an HTTPS URL on the publisher's domain, a SHA-256, and silent install/uninstall; Defender scans it ([repository docs](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)). Point it at the immutable versioned URL.
- **Microsoft Store, later.** Registration is free for individuals ([blog](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)). EXE submissions are allowed but must be signed by you; the Store re-signs only MSIX ([requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)). MSIX would mean StartupTask instead of the Run key ([docs](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap5-startuptask)). Not v0.

### Monorepo, releases and downloads

```text
Cargo.toml                    NEW: [workspace] members = crates/*, apps/windows
crates/shouldertap-core/      protocol types (serde), ApiClient (ureq), Live (tungstenite), Store, Platform trait
apps/windows/                 Win32 app: overlay/, popup/, tray.rs, platform.rs, install.rs, update.rs
  app.manifest                PerMonitorV2, common controls v6, asInvoker
  assets/                     Bricolage TTFs (from apps/macos), tray icon frames, .ico
  package.json                {"scripts": {"build": "cargo build --release", "check-types": "cargo check"}}, so Turbo can run it
packages/domain/fixtures/     NEW: JSON Schema + golden JSON shared by TS, Rust (and Swift) tests
scripts/release-windows.sh    mirrors release-mac.sh
```

- **Bun workspace.** Either add `apps/windows` to `workspaces.packages` for Turbo's `build`/`check-types` (its `package.json` only wraps cargo), or leave it outside, as `apps/macos` is. Cargo does not care. Add `target/` to `.gitignore`.
- **Builds.**
  - CI runs on GitHub Actions `windows-latest`: `x86_64-pc-windows-msvc` with `-C target-feature=+crt-static`, plus `aarch64-pc-windows-msvc` later.
  - Local builds can cross-compile from the Mac, as done for this research: `cargo zigbuild --target x86_64-pc-windows-gnu`, with zig and cargo-zigbuild from pip.
  - Signing happens in CI.
- **`scripts/release-windows.sh`** has the same shape as `release-mac.sh`:
  - it reads the version from `apps/windows/Cargo.toml`;
  - it builds and signs (or `--no-upload`);
  - it runs `bunx wrangler r2 object put` to the `shouldertap-releases` bucket.

  ```text
  windows/Shouldertap-Setup-<v>.exe   immutable (max-age=31536000)   winget + update source
  windows/Shouldertap-Setup.exe       max-age=300                     Download button
  windows/latest.json                 max-age=60                      self-updater feed
  ```

  The existing `Shouldertap.dmg` keys stay where they are.

- **`domains.ts` / `alchemy.run.ts`.** Add `windowsDownloadUrl`, and pass `VITE_WINDOWS_DOWNLOAD_URL` next to `VITE_MAC_DOWNLOAD_URL`.
- **`/download`.**
  - Add a validated `?os=mac|windows` search param, defaulting from `navigator.userAgentData?.platform` with a `userAgent` fallback.
  - Each OS gets its own title, requirement line ("Windows 10 1809 or later · x64", Arm later), primary button and `STEPS`.
  - The Windows steps:
    1. Run Shouldertap-Setup.exe. Until reputation builds, it may say More info → Run anyway.
    2. Pin the mark from the taskbar's ^ overflow.
    3. Invite someone.
  - Add a small "or `winget install Shouldertap.Shouldertap`" line for developers.
  - Generalize "Mac" copy to "computer" where it refers to receivers.

### Milestones

| # | Milestone | Effort | Exit criteria |
| --- | --- | --- | --- |
| 0 | **Spike + gate** | 3–4 d | A windows-rs overlay on 2 monitors at mixed DPI, drawing Bricolage variable text, with an EDIT reply field (test IME with Microsoft Pinyin/Japanese). Run the earlier document's matrix: Edge F11, video full-screen, PowerPoint, a borderless game, an exclusive-fullscreen game, sleep/wake, lock, virtual desktops, other topmost apps. Record the focus success rate with and without the Alt fallback. **Measure the exe size and idle/active working set.** Decide whether to hand-draw the popup or use Slint. |
| 1 | `crates/shouldertap-core` | 2–3 d | Types, ApiClient, Live, Store and the persisted ack queue. Fixture tests pass. It pairs with `alchemy dev` from a CLI harness and receives taps. |
| 2 | Overlay | 4–5 d | Full `docs/design.md` overlay: band, page, sized message, pills with 1/2/3, reply mode, "N more waiting", fades (reduced motion honored via `SPI_GETCLIENTAREAANIMATION`), and cross-device dismissal with a Mac. |
| 3 | Tray + popup | 5–7 d | Tray with knock animation (light/dark). Popup covers setup (create inbox / join with code), invite with QR (`qrcode` crate) + link + copy, add another computer, can tap you (revoke), your computers, recent, open at login, quit. Mica, keyboard navigation, AccessKit tree. |
| 4 | Platform glue | 2–3 d | Credential Manager, prefs, Run key, single instance (named mutex + activate the existing popup), power/session events, friendly device name at setup. |
| 5 | Install, update, release | 3–4 d | Self-install and uninstall, self-update from R2, CI build + Artifact Signing, `release-windows.sh`, `domains.ts`, per-OS `/download`, winget manifest PR. |
| 6 | Hardening | 2–3 d | Re-run the M0 matrix on the signed build. Narrator pass. Soak test for idle RAM/CPU (24 h). Update the README and architecture docs. |

**Total: about 21–29 working days.** Start Artifact Signing validation on day 1. The Slint variant would take about 17–23 days, saving time mainly in M3.

### Risks

1. **Focus stealing** (high likelihood, medium impact). This applies to every framework. The Alt-key enable is the known workaround, and clicks work regardless. If the fallback misbehaves, fall back to click-to-focus plus `FlashWindowEx`.
2. **Hand-drawn popup effort** (medium). Layout, hover and focus states, scrolling in Recent, and an accessibility tree are real work. Mitigations: keep the popup small and list-based, or switch to Slint at the M0 gate.
3. **Windows domain knowledge** (medium). COM/D2D/DComp lifetimes and device-lost handling. windows-rs 0.100 is about to reorganize its crates, including new `windows-canvas`/`windows-composition` crates ([newsletter](https://github.com/microsoft/windows-rs/issues/4867)). Pin 0.62 and upgrade later.
4. **Exclusive-fullscreen games and topmost contention** (certain for some games, low-to-medium impact). No framework fixes these. Reword the promise.
5. **SmartScreen / Smart App Control** (certain until signed and reputable). Sign from the first public build. Individual Artifact Signing eligibility is US/Canada only.
6. **Tray icon in overflow** (high on Windows 11). Handle it with first-run and download-page copy.
7. **Estimates are unmeasured on hardware.** RAM figures for (a) are projections. M0 is where they become facts.
8. **Two UI codebases** (certain). Swift on Mac, Rust on Windows. `docs/design.md` plus shared tokens (`packages/domain/src/colors.ts`, exported to a generated Rust constants file) keep them aligned.

## Decisions for Jake

1. **Native Rust (windows-rs), about 2 MB and about 10 MB RAM,** vs **Slint** (about 8 MB and about 25 MB RAM, about a week faster, with a "Made with Slint" badge on the download page or an About screen, per the [FAQ](https://github.com/slint-ui/slint/blob/master/FAQ.md)). Both beat Electron by about 50x on download size.
2. **Shared core:** accept "separate Swift and Rust, shared fixtures, a Rust core crate that can adopt UniFFI later", or commit to UniFFI now. Committing now makes sense only if the Swift Mac rewrite would rather not write its own protocol layer.
3. **PWA lite tier:** skip it (recommended), or plan it as a later fallback. It costs about 2–4 days of backend Web Push work.
4. **Signing:** enroll in Azure Artifact Signing now ($9.99/month; your legal name and city appear on the certificate).
5. **Distribution:** single self-installing exe + winget (recommended); the Store later, or never.
6. **Hardware:** a Windows 11 PC with two monitors at different scaling, plus one exclusive-fullscreen game, for M0.
7. **Architectures:** x64 only for v0, or x64 + arm64. Arm64 is cheap in Rust, but it is a second signed artifact and a second feed entry.

## Measurements

Cross-compiled on this Mac (Apple silicon, macOS 15) with Rust 1.93.1, target `x86_64-pc-windows-gnu`, and zig 0.16.0 + cargo-zigbuild as the linker, in a scratch directory outside the repo. The release profile was `opt-level="z"`, `lto=true`, `codegen-units=1`, `panic="abort"`, `strip=true`. Sizes are in bytes (the text rounds to decimal KB/MB), with `xz -9e` sizes as a proxy for a compressed download. The MSVC target, which CI would use, was not measured. Its sizes are typically similar, but that is unverified. None of these binaries were run, so no RAM was measured.

| Build | Contents | Raw | xz |
| --- | --- | --- | --- |
| `w32` | windows 0.62.2: PMv2, topmost popup over the virtual screen, D2D rounded page, DirectWrite 120px text, tray icon | **311,808** | 134,688 |
| `netsync` | `w32` + ureq 3.4.2 + tungstenite 0.28.0 over native-tls 0.2.18 (SChannel) + serde_json: ticket POST, WSS read loop | **872,448** | 401,864 |
| `netasync` | `w32` + tokio 1.53.1 + tokio-tungstenite 0.28.0 + reqwest 0.12.28 on rustls 0.23.45 / ring 0.17.14 | **2,035,712** | 893,536 |
| `slinthello` (default features) | Slint 1.18.1: frameless always-on-top window, rounded page, 120px text, pill, TextInput | **8,249,344** | – |
| `slinthello` (winit + femtovg + a11y) | same UI | **7,765,504** | – |
| `slinthello` (winit + software + a11y) | same UI | **7,881,728** | – |
| `slinthello` (winit + software, no a11y) | same UI | **7,674,368** | 3,362,388 |
| `eguihello` | eframe 0.33.3 defaults (glow, AccessKit, default fonts): fullscreen, no decorations, always on top, label + button + text field | **3,307,520** | 1,429,548 |

The `w32` import table (`llvm-objdump -p`) lists KERNEL32, ntdll, user32, shell32, oleaut32, d2d1, dwrite and the api-ms-win-crt/core API sets. All of them are in-box on Windows 10 and 11.

## Sources

Web/PWA: [Chromium push while closed](https://groups.google.com/a/chromium.org/g/chromium-dev/c/jqrtJCPMb-k), [web.dev push FAQ](https://web.dev/push-notifications-faq/), [Chromium background-mode flag](https://codereview.chromium.org/1124263002), [Edge notifications blog](https://blogs.windows.com/msedgedev/2020/11/16/improving-notifications-badging-microsoft-edge/), [Edge push](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push), [Edge notifications and badges](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/notifications-badges), [StartupBoostEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/startupboostenabled), [BackgroundModeEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/backgroundmodeenabled), [Mozilla bug 1794475](https://bugzilla.mozilla.org/show_bug.cgi?id=1794475), [toast content](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-content), [toast schema](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-toast), [inline reply status](https://chromestatus.com/feature/5743740178137088), [getNotifications](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/getNotifications), [Windows Focus](https://support.microsoft.com/en-us/windows/experience/focus-stay-on-task-without-distractions-in-windows), [Document PiP](https://developer.chrome.com/docs/web-platform/document-picture-in-picture), [AutomaticFullscreenAllowedForUrls](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/automaticfullscreenallowedforurls), [Window Management API](https://developer.chrome.com/docs/capabilities/web-apis/window-management), [IWA allowlist](https://developer.chrome.com/docs/iwa/allowlist), [Window Controls Overlay](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/window-controls-overlay), [WebAppSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/webappsettings), [Run on login explainer](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/RunOnLogin/Explainer.md), [PWA in the Store](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store), [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292), [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

Frameworks: [windows-rs newsletter #4867](https://github.com/microsoft/windows-rs/issues/4867), [DirectWrite in-memory loader](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_3/nf-dwrite_3-idwritefactory5-createinmemoryfontfileloader), [IDWriteFontFace5](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_3/nn-dwrite_3-idwritefontface5), [IDWriteTextFormat3](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_3/nn-dwrite_3-idwritetextformat3), [UIA providers](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-providersoverview), [Slint 1.17](https://slint.dev/blog/slint-1.17-released), [Slint size discussion](https://github.com/slint-ui/slint/discussions/9570), [Slint Windows RAM #13470](https://github.com/slint-ui/slint/issues/13470), [Slint FAQ/licensing](https://github.com/slint-ui/slint/blob/master/FAQ.md), Slint issues [#2895](https://github.com/slint-ui/slint/issues/2895), [#5206](https://github.com/slint-ui/slint/issues/5206), [#10861](https://github.com/slint-ui/slint/issues/10861), [egui/Slint RSS blog](https://trystan-sarrade.com/article/rust-gui-135mb-to-30mb-egui-to-slint/), [egui #7761](https://github.com/emilk/egui/issues/7761), [eframe features](https://docs.rs/crate/eframe/latest/features), [iced 0.14](https://github.com/iced-rs/iced/releases/tag/0.14.0), [iced #552](https://github.com/iced-rs/iced/issues/552), [Tauri 2 releases](https://v2.tauri.app/release/tauri/), [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/), [framework comparison](https://github.com/Elanis/web-to-desktop-framework-comparison), [Tauri memory discussion](https://github.com/orgs/tauri-apps/discussions/3162), [WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution), [WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model), [WebView2 performance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance), [.NET trimming incompatibilities](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities), [.NET Framework versions](https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies), [WPF memory Q&A](https://learn.microsoft.com/en-us/answers/questions/1285803/), [wpf#9017](https://github.com/dotnet/wpf/discussions/9017), [Windows App SDK downloads](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads), [WinUI size discussion](https://github.com/microsoft/microsoft-ui-xaml/discussions/7683), [WinAppSDK 1.6 NativeAOT](https://blogs.windows.com/windowsdeveloper/2024/09/04/whats-new-in-windows-app-sdk-1-6/), [WindowsAppSDK #713](https://github.com/microsoft/WindowsAppSDK/issues/713).

Win32 platform: [High-DPI desktop apps](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows), [MarkFullscreenWindow](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-itaskbarlist2-markfullscreenwindow), [SHQueryUserNotificationState](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state), [DirectComposition layering](https://learn.microsoft.com/en-us/archive/msdn-magazine/2014/june/windows-with-c-high-performance-window-layering-using-the-windows-composition-engine), [SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow), [LockSetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-locksetforegroundwindow), [tao focus note](https://github.com/tauri-apps/plugins-workspace/issues/3548), [Shell_NotifyIconW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shell_notifyiconw), [NOTIFYICONDATAW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw), [CalculatePopupWindowPosition](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-calculatepopupwindowposition), [tray-icon releases](https://github.com/tauri-apps/tray-icon/releases), [StartupTask](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap5-startuptask), [CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw), [CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata), [WinHTTP WebSocket](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpwebsocketcompleteupgrade), [IVirtualDesktopManager](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ivirtualdesktopmanager).

Distribution and signing: [Velopack Rust](https://docs.velopack.io/getting-started/rust), [Velopack installer](https://docs.velopack.io/packaging/installer), [Velopack distributing](https://docs.velopack.io/distributing/overview), [App Installer file](https://learn.microsoft.com/en-us/windows/msix/app-installer/app-installer-file-overview), [MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide), [winget repository](https://learn.microsoft.com/en-us/windows/package-manager/package/repository), [winget installer schema](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/installer.md), [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [SAC FAQ](https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003), [Windows app best practices](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices), [Store EXE/MSI requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements), [free Store registration](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/).

UniFFI: [changelog](https://github.com/mozilla/uniffi-rs/blob/main/CHANGELOG.md), [async/futures](https://mozilla.github.io/uniffi-rs/latest/futures.html), [Swift bindgen](https://mozilla.github.io/uniffi-rs/latest/swift/uniffi-bindgen-swift.html), [Xcode integration](https://mozilla.github.io/uniffi-rs/latest/swift/xcode.html).
