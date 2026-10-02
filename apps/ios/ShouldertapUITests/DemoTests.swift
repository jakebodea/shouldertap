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
  func testPairAndSendATap() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let invite = environment["SHOULDERTAP_INVITE"], !invite.isEmpty else {
      throw XCTSkip("Set TEST_RUNNER_SHOULDERTAP_INVITE to run against a stack")
    }
    let message = environment["SHOULDERTAP_TAP"] ?? "Dinner's ready"
    let name = environment["SHOULDERTAP_NAME"] ?? "Rosa"
    let color = environment["SHOULDERTAP_COLOR"] ?? "plum"

    let app = XCUIApplication()
    if let server = environment["SHOULDERTAP_SERVER_URL"] {
      app.launchEnvironment["SHOULDERTAP_SERVER_URL"] = server
    }
    app.launch()

    XCTAssertTrue(app.buttons["welcome-start"].waitForExistence(timeout: 10), "Expected the welcome screen")
    if let url = URL(string: invite), url.scheme == "shouldertap" {
      // Exercise onOpenURL, confirming the system's "Open in Shouldertap?".
      app.open(url)
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let open = springboard.buttons["Open"]
      if open.waitForExistence(timeout: 3) { open.tap() }
    } else {
      // Walk the onboarding: welcome, the Mac app, then paste the link.
      app.buttons["welcome-start"].tap()
      app.buttons["mac-next"].tap()
      let inviteField = app.textFields["invite-field"]
      XCTAssertTrue(inviteField.waitForExistence(timeout: 5))
      inviteField.tap()
      inviteField.typeText(invite)
      app.buttons["invite-continue"].tap()
    }
    XCTAssertTrue(app.staticTexts["You're invited"].waitForExistence(timeout: 5))

    let nameField = app.textFields["name-field"]
    nameField.tap()
    if let existing = nameField.value as? String, !existing.isEmpty, existing != "e.g. Sam" {
      nameField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    nameField.typeText(name)
    app.buttons["color-\(color)"].tap()

    app.buttons["pair-button"].tap()
    let done = app.buttons["paired-done"]
    XCTAssertTrue(done.waitForExistence(timeout: 10), "Expected the paired screen")
    try await Task.sleep(for: .seconds(1))
    capture(app, name: "04-pairing")
    done.tap()
    try await Task.sleep(for: .seconds(1))
    capture(app, name: "01-compose")

    // A vertical-axis TextField surfaces as a text view.
    let field = app.descendants(matching: .any)["tap-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "Expected the composer")
    field.tap()
    app.typeText(message)
    app.buttons["send-button"].tap()

    XCTAssertTrue(app.staticTexts[message].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Live"].waitForExistence(timeout: 10))
    capture(app, name: "02-delivery")
    if let server = environment["SHOULDERTAP_SERVER_URL"], let token = environment["SHOULDERTAP_RECEIVER_TOKEN"] {
      var snapshot = URLRequest(url: URL(string: server + "/v1/me")!)
      snapshot.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (data, _) = try await URLSession.shared.data(for: snapshot)
      let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      let taps = try XCTUnwrap(object["taps"] as? [[String: Any]])
      let id = try XCTUnwrap(taps.first?["id"] as? String)
      var reply = URLRequest(url: URL(string: server + "/v1/taps/" + id + "/acknowledge")!)
      reply.httpMethod = "POST"
      reply.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      reply.setValue("application/json", forHTTPHeaderField: "Content-Type")
      reply.httpBody = Data(#"{"response":{"kind":"on_it"}}"#.utf8)
      let (_, response) = try await URLSession.shared.data(for: reply)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      XCTAssertTrue(app.descendants(matching: .any)["answer"].waitForExistence(timeout: 10))
      capture(app, name: "03-reply")
    }
  }

  private func capture(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
