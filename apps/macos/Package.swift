// swift-tools-version: 6.0
import PackageDescription

/// The native Mac receiver. `ShouldertapCore` is the protocol, API client,
/// live socket and state (no UI, fully tested); `Shouldertap` is the menu bar
/// app. `scripts/build.sh` wraps the executable into Shouldertap.app.
let package = Package(
  name: "Shouldertap",
  platforms: [.macOS(.v14)],
  dependencies: [
    // Updates: an EdDSA-signed appcast on download.shouldertap.app.
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")
  ],
  targets: [
    .target(name: "ShouldertapCore"),
    .executableTarget(
      name: "Shouldertap",
      dependencies: ["ShouldertapCore", .product(name: "Sparkle", package: "Sparkle")],
      // Sparkle.framework is embedded in Contents/Frameworks by scripts/build.sh.
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    ),
    .testTarget(
      name: "ShouldertapCoreTests",
      dependencies: ["ShouldertapCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
