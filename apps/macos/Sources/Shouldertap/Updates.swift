import AppKit
import Sparkle

/// Sparkle updates from the EdDSA-signed appcast that scripts/release-mac.sh
/// publishes (Info.plist: SUFeedURL, SUPublicEDKey; once a day).
///
/// A menu bar app shouldn't throw an update window over whatever you're
/// doing, so scheduled checks use Sparkle's gentle reminders: a found update
/// shows as a row in the menu, and Sparkle's window opens when you click it.
@MainActor @Observable
final class Updates: NSObject {
  /// The version a scheduled check found, until you look at it.
  private(set) var available: String?
  @ObservationIgnored private var controller: SPUStandardUpdaterController!

  override init() {
    super.init()
    controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
    #if DEBUG
      // SHOULDERTAP_UPDATE_SELFTEST=1: check now, then download, install and
      // relaunch without any UI, to exercise an update end to end.
      if Self.selfTest {
        controller.updater.automaticallyDownloadsUpdates = true
        controller.updater.checkForUpdatesInBackground()
      }
    #endif
  }

  #if DEBUG
    static let selfTest = ProcessInfo.processInfo.environment["SHOULDERTAP_UPDATE_SELFTEST"] != nil
  #endif

  func checkForUpdates() {
    NSApp.activate(ignoringOtherApps: true)
    controller.checkForUpdates(nil)
  }
}

extension Updates: SPUUpdaterDelegate {
  /// Debug builds can test against a local feed.
  func feedURLString(for updater: SPUUpdater) -> String? {
    #if DEBUG
      ProcessInfo.processInfo.environment["SHOULDERTAP_FEED_URL"]
    #else
      nil
    #endif
  }

  #if DEBUG
    func updater(
      _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
      immediateInstallationBlock: @escaping () -> Void
    ) -> Bool {
      guard Self.selfTest else { return false }
      immediateInstallationBlock()
      return true
    }
  #endif
}

extension Updates: @preconcurrency SPUStandardUserDriverDelegate {
  var supportsGentleScheduledUpdateReminders: Bool { true }

  /// Let Sparkle show its window only when the app is already in front
  /// (you opened the menu); otherwise the menu row announces it.
  func standardUserDriverShouldHandleShowingScheduledUpdate(
    _ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool
  ) -> Bool {
    immediateFocus
  }

  func standardUserDriverWillHandleShowingUpdate(
    _ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState
  ) {
    if !handleShowingUpdate { available = update.displayVersionString }
  }

  func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
    available = nil
  }

  func standardUserDriverWillFinishUpdateSession() {
    available = nil
  }
}
