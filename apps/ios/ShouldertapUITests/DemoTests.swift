import XCTest

/// Drives the real app against a running stack: pair with an invite, then
/// send a tap. Pass the invite from the shell:
///
///   TEST_RUNNER_SHOULDERTAP_INVITE='shouldertap://join#<code>' \
///   TEST_RUNNER_SHOULDERTAP_TAP='Dinner is ready' xcodebuild test …
///
/// Skipped without an invite, so a plain `xcodebuild test` stays green.
@MainActor
final class DemoTests: XCTestCase {
  func testPairAndSendATap() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let invite = environment["SHOULDERTAP_INVITE"], !invite.isEmpty else {
      throw XCTSkip("Set TEST_RUNNER_SHOULDERTAP_INVITE to run against a stack")
    }
    let message = environment["SHOULDERTAP_TAP"] ?? "Dinner's ready"
    let name = environment["SHOULDERTAP_NAME"] ?? "Rosa"
    let color = environment["SHOULDERTAP_COLOR"] ?? "plum"

    let app = XCUIApplication()
    app.launch()

    let inviteField = app.textFields["invite-field"]
    XCTAssertTrue(inviteField.waitForExistence(timeout: 10), "Expected the pairing screen")
    if let url = URL(string: invite), url.scheme == "shouldertap" {
      // Exercise onOpenURL, confirming the system's "Open in Shouldertap?".
      app.open(url)
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let open = springboard.buttons["Open"]
      if open.waitForExistence(timeout: 3) { open.tap() }
      XCTAssertTrue(app.staticTexts["You're invited"].waitForExistence(timeout: 5))
    } else {
      inviteField.tap()
      inviteField.typeText(invite)
    }

    let nameField = app.textFields["name-field"]
    nameField.tap()
    if let existing = nameField.value as? String, !existing.isEmpty, existing != "e.g. Sam" {
      nameField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    nameField.typeText(name)
    app.buttons["color-\(color)"].tap()

    let pair = app.buttons["pair-button"]
    if !pair.isHittable { app.swipeUp() }
    pair.tap()

    // A vertical-axis TextField surfaces as a text view.
    let field = app.descendants(matching: .any)["tap-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "Expected the composer")
    field.tap()
    app.typeText(message)
    app.buttons["send-button"].tap()

    XCTAssertTrue(app.staticTexts[message].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Live"].waitForExistence(timeout: 10))
  }
}
