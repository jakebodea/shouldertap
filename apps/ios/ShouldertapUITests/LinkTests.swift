import XCTest

/// Links this iPhone to an inbox with a device code from the Mac ("Add a Mac
/// or iPhone"), then manages it: people, devices, an invite. Run against a
/// stack, with a fresh code:
///
///   TEST_RUNNER_SHOULDERTAP_LINK_CODE='<code>' xcodebuild test …
///
/// With TEST_RUNNER_SHOULDERTAP_MAC_TOKEN (the Mac's credential, the inbox's
/// only Mac), it also checks the phone can't remove that Mac, and that the
/// Mac removing the phone unlinks it. With TEST_RUNNER_SHOULDERTAP_INVITE (a
/// sender invite to someone else), it also pairs to tap them, and opens the
/// inbox from the composer. Skipped without a code.
@MainActor
final class LinkTests: XCTestCase {
  func testLinkAndManageTheInbox() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let code = environment["SHOULDERTAP_LINK_CODE"], !code.isEmpty else {
      throw XCTSkip("Set TEST_RUNNER_SHOULDERTAP_LINK_CODE to run against a stack")
    }
    let app = XCUIApplication()
    if let server = environment["SHOULDERTAP_SERVER_URL"] {
      app.launchEnvironment["SHOULDERTAP_SERVER_URL"] = server
    }
    app.launch()

    XCTAssertTrue(app.buttons["welcome-link"].waitForExistence(timeout: 10), "Expected the welcome screen")
    app.buttons["welcome-link"].tap()
    let field = app.textFields["link-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    capture(app, name: "01-link")
    field.tap()
    field.typeText(code)
    app.buttons["link-button"].tap()

    XCTAssertTrue(app.buttons["invite-someone"].waitForExistence(timeout: 10), "Expected the inbox")
    try await Task.sleep(for: .seconds(1.5))
    capture(app, name: "02-inbox")
    XCTAssertTrue(app.buttons["tap-someone"].exists, "The inbox is home with no one to tap yet")

    app.buttons["invite-someone"].tap()
    XCTAssertTrue(app.buttons["share-invite"].waitForExistence(timeout: 10), "Expected the invite card")
    capture(app, name: "03-invite")

    app.swipeUp()
    try await Task.sleep(for: .seconds(0.5))
    capture(app, name: "04-devices")

    guard let macToken = environment["SHOULDERTAP_MAC_TOKEN"], !macToken.isEmpty else { return }
    // The inbox's only Mac stays while this iPhone is linked.
    let macName = environment["SHOULDERTAP_MAC_NAME"] ?? "Studio Mac"
    app.buttons["Options for \(macName)"].tap()
    app.buttons["Remove \(macName)"].tap()
    app.buttons["Remove"].firstMatch.tap()
    XCTAssertTrue(app.alerts["Couldn't remove"].waitForExistence(timeout: 10), "Expected the last Mac to stay")
    capture(app, name: "05-last-mac")
    app.alerts.buttons["OK"].tap()

    // Someone to tap too: the composer becomes home, with the inbox on its frame.
    let invite = environment["SHOULDERTAP_INVITE"].flatMap { $0.isEmpty ? nil : $0 }
    if let invite {
      app.buttons["tap-someone"].tap()
      let inviteField = app.textFields["invite-field"]
      XCTAssertTrue(inviteField.waitForExistence(timeout: 5))
      inviteField.tap()
      inviteField.typeText(invite)
      app.buttons["invite-continue"].tap()
      let nameField = app.textFields["name-field"]
      XCTAssertTrue(nameField.waitForExistence(timeout: 5))
      nameField.tap()
      nameField.typeText("Jake")
      app.buttons["pair-button"].tap()
      XCTAssertTrue(app.buttons["paired-done"].waitForExistence(timeout: 10))
      app.buttons["paired-done"].tap()
      XCTAssertTrue(app.buttons["your-inbox"].waitForExistence(timeout: 5), "Expected the inbox on the frame")
      try await Task.sleep(for: .seconds(1))
      capture(app, name: "06-composer")
      app.buttons["your-inbox"].tap()
      XCTAssertTrue(app.buttons["inbox-close"].waitForExistence(timeout: 5), "Expected the inbox over the composer")
      try await Task.sleep(for: .seconds(1))
      capture(app, name: "07-inbox-cover")
    }

    // The Mac removes this iPhone: it says so, and the inbox goes.
    let server = URL(string: environment["SHOULDERTAP_SERVER_URL"] ?? "http://localhost:3000")!
    var me = URLRequest(url: server.appending(path: "v1/me"))
    me.setValue("Bearer \(macToken)", forHTTPHeaderField: "Authorization")
    let (data, _) = try await URLSession.shared.data(for: me)
    let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let credentials = snapshot?["credentials"] as? [[String: Any]] ?? []
    let phones = credentials.filter { $0["platform"] as? String == "iphone" }.compactMap { $0["id"] as? String }
    XCTAssertFalse(phones.isEmpty)
    for phone in phones {
      var revoke = URLRequest(url: server.appending(path: "v1/credentials/\(phone)"))
      revoke.httpMethod = "DELETE"
      revoke.setValue("Bearer \(macToken)", forHTTPHeaderField: "Authorization")
      _ = try await URLSession.shared.data(for: revoke)
    }
    XCTAssertTrue(
      app.alerts["This iPhone was unlinked from your Shouldertap"].waitForExistence(timeout: 10),
      "Expected the unlink notice")
    capture(app, name: "08-unlinked")
    app.alerts.buttons["OK"].tap()
    if invite != nil {
      XCTAssertTrue(app.buttons["add-person"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["your-inbox"].exists)
    } else {
      XCTAssertTrue(app.buttons["welcome-link"].waitForExistence(timeout: 5))
    }
  }

  private func capture(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
