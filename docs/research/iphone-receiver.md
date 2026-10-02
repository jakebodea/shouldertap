# iPhone as a receiver

Checked October 2, 2026, on Xcode 26.3 with the iOS 26.3 simulator (iPhone 17 Pro). The research is from Apple platform knowledge and wasn't re-verified against live documentation. The prototype was built and exercised in the simulator; no device testing has been done.

## Question

On the Mac, a tap takes over every display: a borderless `.screenSaver`-level window in the sender's color (`apps/macos/Sources/Shouldertap/Overlay.swift`). Can the iPhone do the same, so a tap reaches the recipient on every device they own, not only their Mac?

## Answer

Not literally. iOS gives no third-party app a way to draw over other apps, the Home Screen or the Lock Screen, and no entitlement changes that. The app owns the screen only while it's in the foreground.

The closest equivalent is three layers, used by what the phone is doing when the tap lands:

| Phone state | Surface | What it does |
| --- | --- | --- |
| Locked | Live Activity, Lock Screen | Wakes the screen; a card in the sender's color stays pinned until answered. On it and In 10 min run without unlocking. |
| Unlocked, another app open | Live Activity, Dynamic Island | Expands over the current app on arrival, then shrinks to a compact pill (initial and name). Long-press expands it again with the same buttons. iPhone 14 Pro and later; other models only get the Lock Screen and a banner. |
| Shouldertap open | In-app takeover | The Mac overlay on a phone: full-screen frame color, paper page, On it / In 10 min / Reply. |
| Live Activities turned off | Time Sensitive notification | Breaks through Focus, with On it, In 10 min and a typed Reply as notification actions. |

### Options considered and rejected

- **Critical Alerts**: these bypass mute and Do Not Disturb, but need an entitlement Apple grants only to health, safety and security apps. Shouldertap wouldn't qualify.
- **CallKit / PushKit (a fake incoming call)**: this is the only real full-screen interrupt available to third parties. App Review rejects it for anything but VoIP, and iOS terminates apps that receive a VoIP push without reporting a call.
- **AlarmKit (iOS 26)**: full-screen alarms that break through silent mode. They're intended for alarms and timers, so using them for messages will very likely fail review. They're also scheduled on the device, not triggered by a push. This is the least certain conclusion here; re-check the current AlarmKit docs and review guidelines before ruling it out for good.

### Platform constraints that shape the design

- A Live Activity can only be **started by the app while it's in the foreground**, or **by a push-to-start APNs push** (iOS 17.2+). The production path is push-to-start from the server, and the app's deployment target is iOS 17.0, so this needs an availability check.
- An update sent with an `AlertConfiguration` (or an APNs `alert` on a Live Activity push) lights the Lock Screen or expands the Dynamic Island. That is the "arrival" moment.
- Live Activity buttons run `LiveActivityIntent`s in the app's process without opening it (iOS 17+). A Live Activity **cannot take text input**, so Reply opens the app.
- iOS shows a one-time "Allow Live Activities from Shouldertap?" prompt the first time the user interacts with one. "Don't Allow" ends all of the app's activities and turns the feature off until changed in Settings.
- The user can turn off Live Activities per app, so the notification has to stand on its own.

## Prototype: receiving surfaces

The prototype covers only the receiving surfaces. The iPhone app is still a sender only: there's no inbox for the phone, answers aren't sent to the server, and there's no APNs. Debug builds fake an arriving tap with a URL.

### Files

- `apps/ios/TapActivity/TapActivity.swift` — compiled into **both** the app and the widget extension. Contains:
  - `TapActivityAttributes`, with static fields tapId, senderName, senderColor and createdAt, and `ContentState` holding the body plus an optional answer;
  - `AnswerTapIntent`, the `LiveActivityIntent` behind On it and In 10 min;
  - `TapActivities.answer`, which shows the answer and dismisses after 4s;
  - `TapActivities.alert`, which re-announces a tap with an `AlertConfiguration`.
- `apps/ios/Widgets/TapLiveActivity.swift`, plus `Widgets/Info.plist` — the new `ShouldertapWidgets` widget extension. It holds the Lock Screen card and all Dynamic Island presentations: expanded, compact and minimal. It carries its own copies of a small piece of the theme (`Bricolage`, `PersonColor.base/ink`, plus an `accent` that keeps dark swatches legible on the island's black) because `Theme.swift` isn't compiled into the extension. It bundles the Bricolage fonts through `UIAppFonts`.
- `apps/ios/Shouldertap/IncomingTaps.swift` — the app side of receiving:
  - the `IncomingTaps` model, which starts the activity and drives the takeover;
  - `TapTakeover`, the in-app overlay;
  - `NotificationRouter`, the `UNUserNotificationCenterDelegate`. A tap notification that arrives while the app is open becomes the takeover, and its actions answer the tap;
  - URL handling.
- Edits:
  - `App.swift`: the takeover overlay, and routing URLs to `IncomingTaps.handle`.
  - `Push.swift`: registers the notification category at launch.
  - `Info.plist`: `NSSupportsLiveActivities`.
  - `project.pbxproj`: the `ShouldertapWidgets` target, the `TapActivity` synchronized group shared by both targets, and an Embed Foundation Extensions phase. The project file was edited by hand with `B1…` object IDs.

### Running it

Build the `ShouldertapIOS` scheme for an iPhone 17 Pro simulator, then:

```bash
xcrun simctl openurl booted shouldertap://demo-tap/Maya/tomato/6
```

The path is `/<from>/<color>/<delay seconds>`. The query form `?from=&color=&body=&delay=` also works, but some terminals turn `&` into `&amp;`. Without a delay, the tap takes over the open app. With one, the Live Activity starts at once (the app has to be in the foreground) and "arrives" after the delay. Lock the simulator or switch apps before then to see the Lock Screen light up or the island expand.

The notification path takes a payload sent with `xcrun simctl push booted app.shouldertap.ios.debug tap.apns`:

```json
{
  "aps": {
    "alert": { "title": "Maya", "body": "Can you grab the door?" },
    "category": "tap",
    "interruption-level": "time-sensitive",
    "sound": "default"
  },
  "tapId": "demo-push-1",
  "senderName": "Maya",
  "senderColor": "tomato"
}
```

### Verified in the simulator

- In-app takeover in tomato and plum.
- Lock Screen Live Activity, including the woken, full-brightness state.
- Compact Dynamic Island over Settings, and the expanded island appearing by itself on the delayed alert.
- On it from the expanded island ended the activity.
- The push notification arriving on a locked phone.

| Lock Screen | Dynamic Island, expanded | In-app takeover | Notification |
| --- | --- | --- | --- |
| ![Lock Screen Live Activity](iphone-receiver/lock-screen.png) | ![Expanded Dynamic Island over Settings](iphone-receiver/dynamic-island.png) | ![In-app takeover](iphone-receiver/takeover.png) | ![Notification on a locked phone](iphone-receiver/notification.png) |

### Not verified

- The notification's long-press actions, and the typed reply from the notification. The simulator wouldn't expand the notification on the Lock Screen.
- The 4-second "You answered: …" state on the Lock Screen.
- Reply from the Live Activity opening the takeover in reply mode.
- Anything on a real device.

### Gotchas hit while building

- With `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`:
  - `TapActivityAttributes` must be `nonisolated`, otherwise its `ActivityAttributes` and `Codable` conformances are main-actor-isolated and won't compile.
  - `IncomingTap` is `nonisolated` and `Sendable`, so notification delegate callbacks can build it before hopping to the main actor.
  - `Activity.update` is called from a `nonisolated` static helper, to avoid "sending risks data races" errors.
- When driving the simulator, the panel's screenshots lagged the device, and a tap aimed at "Allow" on the Live Activities prompt landed on "Don't Allow". `xcrun simctl io booted screenshot` is reliable. Reinstalling the app resets the choice.

## Step 1, built: the iPhone as a companion

Before building receiving, the phone links to the recipient's inbox to manage it, so we can see whether people link their phone at all. Receiving is the next step, behind the same link.

- **Linking.** On the Mac, Your devices → Add a Mac or iPhone shows the one-time device code as a QR code (`shouldertap://link#<code>`) and as text. The iPhone scans it from the camera (opens the app at the link screen), from its own scanner, or takes the pasted code. Entry points: "I use Shouldertap on my Mac" on the welcome screen, and Help → Your own Shouldertap.
- **Server.** A linked iPhone is a `device` credential, so it can do everything a Mac can over the API. Credentials now carry `platform` (`mac` | `iphone`; a migration backfills existing devices as `mac`), sent when redeeming a device code. The inbox refuses to remove its last Mac while other devices remain (`Conflict`), so an inbox can't be left with only iPhones that don't display taps; removing the very last device still works. Caps now say 10 devices.
- **iPhone app.** A second store, `ReceiverStore(platform: .iphone)`, with its credential in the Keychain (`app.shouldertap.ios.inbox`). `InboxView.swift` is the Mac menu's ready view on a graphite page: plan status (read-only; buying stays on the Mac), Invite someone (QR plus share sheet), Can tap you, Your devices (with Add a Mac, a code to AirDrop), Recent. With no one to tap yet, the inbox is the home screen ("Tap someone" on the frame); once you tap people too, a tray button on the composer's frame opens it. If the Mac removes the phone, it says so once and the inbox goes away.
- **The phone never reports a tap as displayed or answers one**, so senders' "On screen" still means a Mac.
- **Tests.** Server: `integ.test.ts` (platform, management from the phone, the last-Mac rule). Swift: decoding `platform`, the iPhone join body, a refused self-removal keeping the pairing. The iPhone flows (link, invite, the last-Mac refusal, the inbox from the composer, being unlinked by the Mac) were checked once in the simulator against a local stack; the iOS UI test target has since been removed.

## Step 2, built: taps reach the iPhone (1.1)

Every tap goes to every device at once: the Macs over their sockets, linked iPhones over APNs.

- **Server** (`apps/server/src/apns.ts`, `Inbox.ts`). Each linked iPhone registers its setup with `PUT /v1/push`: environment (sandbox for debug and simulator builds), topic (bundle id), device token, push-to-start token, and whether Live Activities are on. On a new tap the Inbox, in the background (`state.waitUntil`), starts the tap's Live Activity with a push-to-start push where it can, and otherwise sends a Time Sensitive notification (category `tap`, collapse id = tap id). The app reports each started activity's token (`POST /v1/taps/:id/activity-token`). Once the tap is answered anywhere, the Inbox ends those activities and sends a background push (`resolvedTapId`) so the app clears the notification, or an activity it never got a token for. Dead tokens (410, BadDeviceToken) are dropped. The Worker signs the ES256 provider token (cached 45 min per isolate) from `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID`; without them nothing is pushed.
- **iPhone** (`Receiving.swift`). The `Receiver` asks for notification permission once linked, registers tokens (re-sent when they change), watches Live Activities to report their tokens, answers from the Lock Screen and Dynamic Island (`AnswerTapIntent`, run in the app process) and from notification actions, and reconciles on every snapshot. While the app is open the oldest waiting tap takes over the screen (and is reported displayed, like the Mac overlay).
- **App layout.** Two tabs: Tap (the composer, or getting an invite) and Inbox (your inbox with a badge for waiting taps, or linking it). A new phone starts at the welcome, which offers both.
- **Release signing.** The archive is unsigned, so `scripts/release-ios.sh` stamps the entitlements (`apps/ios/Shouldertap.entitlements`) on with an ad-hoc signature before exporting; otherwise the export drops push.

## What's left

1. **Sender notifications.** Senders' phones could get a push when their tap is answered (the old "PUSH SEAM" idea); the APNs plumbing is now there.
2. **Notification Content Extension (optional).** Without it, the long-pressed notification is plain iOS. One would give it the frame-color paper look from the mockup.
3. **Takeover polish.** A reduced-motion check and Dynamic Type limits for the message size.
4. **iPad.** The app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`). iPad has Lock Screen Live Activities but no Dynamic Island.
5. **Tests.** There's no iOS UI test target any more; the server's payloads and the Swift registration are unit-tested, and the flows were checked by hand in the simulator.
