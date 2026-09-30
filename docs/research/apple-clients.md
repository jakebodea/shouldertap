# Apple client architecture research

Checked September 30, 2026. Research and proposed choices only; no app has been scaffolded or run.

## Product scope

The [current concept document](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) describes a trusted sender interrupting a recipient across connected Mac displays, followed by an explicit acknowledgement and response. The user confirmed Safari on iPhone/iPad as the initial sender, and subsequently said a native companion app will be needed eventually. Plan for a native iOS/iPadOS sender, without making it a prerequisite for the first Mac delivery loop.

## Selected direction

The user selected React Native macOS with a small Apple-specific module, prioritizing broad TypeScript/Effect reuse over shipping without a JavaScript runtime. Use React Native macOS for the Mac client, an isolated AppKit module for the overlay, and Expo/React Native for the later iOS companion. The Mac overlay is specialized platform work, so sharing business logic and protocols matters more than sharing every screen.

This is an agreed architecture direction, not a completed compatibility test. React Native macOS is Microsoft's separate platform extension; Expo does not automatically supply the Mac app. Choose compatible React Native/macOS/Expo versions before generating projects. Microsoft's [introduction](https://microsoft.github.io/react-native-macos/docs/intro) and [native-development guide](https://github.com/microsoft/react-native-macos/blob/main/docsite/docs/guides/native-development.md) describe component/library reuse and AppKit-backed native modules. React Native's [TypeScript guide](https://reactnative.dev/docs/typescript) establishes TypeScript as the normal application authoring path.

Keep Mac platform ownership behind a narrow interface:

- Observe connected displays and geometry changes.
- Present one interactive overlay per display and close all overlays for the same message together.
- Apply appropriate window level and Spaces/full-screen behavior.
- Manage menu-bar presence, launch at login, and credential storage.
- Report display lifecycle and presentation results to TypeScript; do not put pairing, protocol, or acknowledgement policy in the window module.

Swift/AppKit, and possibly Objective-C++ bridge glue, will still be needed. An all-TypeScript application layer is credible; promising that the entire repository contains only TypeScript would be misleading.

Apple documents window collection behavior specifically for floating windows and system overlays in [canJoinAllApplications](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/canjoinallapplications). It describes joining other apps' full-screen Spaces when eligible, not unrestricted control of all system surfaces. Exact behavior must be tested on Jake's devices. Do not infer Accessibility or Screen Recording permission requirements merely from creating an overlay; determine requirements from the actual APIs used.

## Vercel Native SDK

The current [vercel-labs/native README](https://github.com/vercel-labs/native) describes TypeScript compiled to native code, `.native` UI markup, and an engine with no JavaScript runtime in a native-rendered app. macOS is its primary desktop target. It remains pre-1.0; mobile is experimental. This is an appealing candidate for a compact Mac receiver, but it is a different programming environment from React Native.

The [TypeScript core documentation](https://native-sdk.dev/docs/typescript) specifies a synchronous, deterministic model/message/update core. Core code cannot import npm packages, use Promises or async/await, or assume normal JavaScript library behavior. Its `Cmd` effect mechanism belongs to Native SDK and is distinct from the Effect library requested for this project.

The [TypeScript services documentation](https://native-sdk.dev/docs/typescript/services) offers compiled service modules and selective, exact-version vendoring. A package must achieve complete static compiler coverage. The documented calibration rejects even `nanoid` and `micromark`. Therefore Effect, Better Auth clients, and a shared npm-heavy API client must not be assumed to compile. A successful check of the actual pinned package graph would be required.

The [package placement guide](https://native-sdk.dev/docs/typescript/packages) offers embedded web frontends or a Node subprocess for incompatible libraries. Those are valid patterns but change the no-JavaScript-runtime tradeoff. Do not choose this toolkit on that premise and quietly add a Node sidecar to recover Effect compatibility.

The [windows documentation](https://native-sdk.dev/docs/windows) supports multiple windows, floating overlays, transparent surfaces, passive presentation, menu-bar lifecycle, and login-item hooks. It also specifies literal window labels in the TypeScript window descriptors. A dynamic display fleet and full-display coverage should be proved rather than inferred from the existence of multiple windows.

Source inspected at commit `96943d4a680f27ea5bfa367c99db6cce58368d49`:

- [AppKit host window creation](https://github.com/vercel-labs/native/blob/96943d4a680f27ea5bfa367c99db6cce58368d49/src/platform/macos/appkit_host.m#L8007): ordinary creation constrains geometry to a display's visible frame; the always-on-top flag selects `NSFloatingWindowLevel`.
- [AppKit host frame constraint](https://github.com/vercel-labs/native/blob/96943d4a680f27ea5bfa367c99db6cce58368d49/src/platform/macos/appkit_host.m#L9498): frame dimensions are clamped to `visibleFrame`, rather than the full screen frame.
- In the inspected AppKit host, no `CanJoinAllSpaces` or `canJoinAllApplications` behavior was found. That is evidence about this source file, not proof that every toolkit integration path lacks it.

These findings make a platform extension plausible. They do not establish that the stock TypeScript scaffold can implement Shouldertap's all-display, all-Space overlay unchanged. If this toolkit is preferred, first test its compiled TypeScript path and identify the exact Zig/AppKit extension needed; keep backend and wire protocol independent of that outcome.

The [platform support matrix](https://native-sdk.dev/docs/platform-support) describes iOS simulator verification, experimental mobile tooling, and manual device/distribution steps. Do not treat a native iOS companion as an already-proven single-codebase follow-on for this toolkit.

## Other viable option

[Tauri](https://v2.tauri.app/start/) offers ordinary TypeScript/React in the system WebView with a Rust host. It supports a smaller desktop shell without bundling a Chromium browser. Its [window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) exposes monitors, always-on-top, and visibility across workspaces. Actual full-screen-overlay behavior still needs device verification and may require AppKit integration. It is credible if sharing the web UI is the priority; it introduces Rust and renders the application UI through a WebView. React Native macOS was selected for this project.

## Effect on Apple clients

React Native documents [Fetch and WebSockets](https://reactnative.dev/docs/network), making a TypeScript HTTP/socket adapter practical. The official [Effect repository](https://github.com/Effect-TS/effect) also includes a [React Native SQLite adapter](https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-react-native/src/SqliteClient.ts). This supports considering core Effect on React Native, but neither source guarantees every Effect 4 RC package works with the selected Mac/iOS runtime.

Before adopting the client runtime, smoke-test the pinned Effect core with the selected React Native engine: Schema decoding, a successful request, a cancelled request, retry/backoff, and reconnect after suspension. Keep Node/Bun platform packages out of client bundles. Use platform adapters for Fetch, sockets, secure storage, notifications, and lifecycle.

Native SDK's compiled core should instead consume neutral JSON wire contracts with a small native adapter unless an actual compatibility test proves broader sharing possible.

## Future iPhone/iPad companion

The companion is a native sender and response-history surface. A mobile web page is the v0 entry point, not the long-term application architecture. A later `apps/mobile` Expo app can share domain types, protocol schemas, and client orchestration with the TypeScript clients; layout, secure storage, push registration, and lifecycle remain platform-specific.

Expo's [native-module overview](https://docs.expo.dev/modules/overview/) supports Swift modules where needed, and [notifications documentation](https://docs.expo.dev/versions/latest/sdk/notifications/) supports notifications and native device-token registration. Native push is a separate background-delivery channel, not a substitute for the server's persisted response state. Verify notification behavior on a physical iPhone when that phase starts.

## First desktop proof

Before choosing the Mac scaffold, build one throwaway or isolated overlay experiment with a fixed local message. Verify: two displays, a display unplug/replug, normal desktops, native full-screen apps, Stage Manager if enabled, focus and text entry, sleep/wake, and acknowledgement on either display dismissing both. Record the tested OS/runtime versions and behavior.

Then test the complete network loop: Safari send, persisted server state, Mac presentation receipt, acknowledgement, Safari response, reconnect recovery, and a second connected Mac dismissing after the first acknowledges. This is the product's implementation gate, not a generic framework benchmark.
