import ShouldertapCore
import UIKit

// MARK: - PUSH SEAM (not implemented)
//
// Replies only arrive while the app is open (the live WebSocket). To notify a
// sender when the recipient answers:
//
// 1. Capability: add the Push Notifications entitlement (aps-environment)
//    once there is an Apple Developer team; simulator-only builds can't
//    register for remote notifications.
// 2. Here: request authorization (.alert, .sound) after the first tap is
//    sent, call `UIApplication.shared.registerForRemoteNotifications()`, and
//    in `didRegisterForRemoteNotificationsWithDeviceToken` send the hex token
//    to the server once per pairing (each pairing is its own credential):
//      POST /v1/push-tokens  { token, environment: "sandbox" | "production" }
//    authorized with that pairing's bearer credential. Re-send on every
//    launch (tokens rotate) and DELETE it when unpairing.
// 3. Server: store the token on the sender's credential row in the Inbox
//    Durable Object; on acknowledge (and optionally on displayed), send an
//    APNs alert from the Worker over HTTP/2 to api.push.apple.com with a
//    .p8 key-signed ES256 JWT (team id, key id; cached ~50 min), topic =
//    the bundle id, `thread-id` = recipient inbox so replies group per
//    person, and `tapId` in the payload. Drop tokens APNs reports as 410.
// 4. Here: on a notification tap, open that recipient's session; the
//    snapshot resync on foreground shows the reply.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    _ = hex  // PUSH SEAM: register `hex` for every pairing (see above).
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    // PUSH SEAM: expected on the simulator and without the entitlement.
  }
}
