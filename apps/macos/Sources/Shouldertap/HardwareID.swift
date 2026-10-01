import Foundation
import IOKit
import ShouldertapCore

/// This Mac's identity for its one free trial.
enum HardwareID {
  /// The Mac's hardware UUID (IOPlatformUUID), or nil if it can't be read.
  /// It never leaves the Mac; only `trialFingerprint` does.
  static func platformUUID() -> String? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    let property = IORegistryEntryCreateCFProperty(
      service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)
    return property?.takeRetainedValue() as? String
  }

  /// Sent when setting up a new inbox. Debug builds salt differently, so
  /// testing setup never uses up this Mac's real trial.
  static func trialFingerprint() -> String? {
    #if DEBUG
      let salt = MachineFingerprint.debugSalt
    #else
      let salt = MachineFingerprint.releaseSalt
    #endif
    return platformUUID().flatMap { MachineFingerprint.make(hardwareUUID: $0, salt: salt) }
  }
}
