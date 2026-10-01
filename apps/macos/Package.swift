// swift-tools-version: 6.0
import PackageDescription

/// The native Mac receiver. `ShouldertapCore` is the protocol, API client,
/// live socket and state (no UI, fully tested); `Shouldertap` is the menu bar
/// app. `scripts/build.sh` wraps the executable into Shouldertap.app.
let package = Package(
  name: "Shouldertap",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "ShouldertapCore"),
    .executableTarget(name: "Shouldertap", dependencies: ["ShouldertapCore"]),
    .testTarget(
      name: "ShouldertapCoreTests",
      dependencies: ["ShouldertapCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
