import Foundation

/// A launcher-owned namespace. Apps only opt into this in debug builds.
/// Reject path separators instead of silently falling back to ordinary state.
public struct VerificationScope: Sendable {
  public let runID: String

  public enum InvalidRun: Error { case invalidIdentifier }

  public init(runID: String) throws {
    guard !runID.isEmpty, runID.count <= 100,
      runID.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 })
    else { throw InvalidRun.invalidIdentifier }
    self.runID = runID
  }

  public func namespace(_ base: String) -> String { "\(base).verify.\(runID)" }

  public func directory(in base: URL) -> URL {
    base.appending(path: "Verification", directoryHint: .isDirectory)
      .appending(path: runID, directoryHint: .isDirectory)
  }
}
