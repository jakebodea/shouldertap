import ShouldertapCore
import UIKit
import os

/// Launch setup and APNs callbacks. Taps for a linked iPhone arrive as
/// pushes (see Receiving.swift); this hands the device token and background
/// pushes to the `Receiver`.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Also on background launches (a Lock Screen answer, a background push),
    // which never build the UI.
    Receiver.registerCategory()
    Receiver.shared.attach(Stores.inbox)
    return true
  }

  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Receiver.shared.didRegister(deviceToken: deviceToken)
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    // Expected without the push entitlement (some simulators).
    Logger(subsystem: "app.shouldertap.ios", category: "Receiving").error(
      "Couldn't register for remote notifications: \(error.localizedDescription, privacy: .public)")
  }

  /// "This tap was answered": clear its notification or Live Activity.
  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]
  ) async -> UIBackgroundFetchResult {
    guard let tapId = userInfo["resolvedTapId"] as? String else { return .noData }
    await Receiver.shared.clear(tapId: tapId)
    Stores.inbox.refresh()
    return .newData
  }
}
