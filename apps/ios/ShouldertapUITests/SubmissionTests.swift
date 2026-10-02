import XCTest

@MainActor
final class SubmissionTests: XCTestCase {
  func testPublicSampleAndPrivacyAccess() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.buttons["help-button"].waitForExistence(timeout: 10))
    app.buttons["help-button"].tap()
    XCTAssertTrue(app.buttons["Privacy Policy"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Support"].exists)
    app.buttons["sample-tap"].tap()
    XCTAssertTrue(app.buttons["sample-send"].waitForExistence(timeout: 5))
    app.buttons["sample-send"].tap()
    XCTAssertTrue(app.buttons["On it"].waitForExistence(timeout: 5))
    app.buttons["On it"].tap()
    XCTAssertTrue(app.staticTexts["sample-answer"].waitForExistence(timeout: 5))
  }
}
