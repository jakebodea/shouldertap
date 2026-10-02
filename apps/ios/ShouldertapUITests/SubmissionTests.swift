import XCTest
import UIKit

@MainActor
final class SubmissionTests: XCTestCase {
  func testHelpTextContrast() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let invite = environment["SHOULDERTAP_INVITE"], let url = URL(string: invite) else {
      throw XCTSkip("Set TEST_RUNNER_SHOULDERTAP_INVITE to test Help from a green pairing")
    }
    let app = XCUIApplication()
    app.launchEnvironment["SHOULDERTAP_SERVER_URL"] = environment["SHOULDERTAP_SERVER_URL"]
    app.launch()
    app.open(url)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    if springboard.buttons["Open"].waitForExistence(timeout: 2) { springboard.buttons["Open"].tap() }
    let name = app.textFields["name-field"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    if let existing = name.value as? String, !existing.isEmpty, existing != "e.g. Sam" {
      name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    name.typeText("Sam")
    app.buttons["color-\(environment["SHOULDERTAP_COLOR"] ?? "moss")"].tap()
    app.buttons["pair-button"].tap()
    XCTAssertTrue(app.buttons["paired-done"].waitForExistence(timeout: 10))
    app.buttons["paired-done"].tap()
    XCTAssertTrue(app.buttons["help-button"].waitForExistence(timeout: 10))
    app.buttons["help-button"].tap()
    let explanation = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Send a tap from your iPhone")).firstMatch
    XCTAssertTrue(explanation.waitForExistence(timeout: 5))
    try assertReadable(explanation, in: app, name: "help-body")
    try assertReadable(app.buttons["Privacy Policy"], in: app, name: "help-privacy")
    try assertReadable(app.buttons["Done"], in: app, name: "help-done")

    app.buttons["Report a problem or abuse"].tap()
    let report = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Describe what happened.")).firstMatch
    XCTAssertTrue(report.waitForExistence(timeout: 5))
    try assertReadable(report, in: app, name: "report-body")
    try assertReadable(app.buttons["Email report"], in: app, name: "report-email")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["sample-tap"].tap()
    let sampleTitle = app.staticTexts["sample-title"]
    XCTAssertTrue(sampleTitle.waitForExistence(timeout: 5))
    try assertReadable(sampleTitle, in: app, name: "sample-title")
  }

  /// Measures the actual rendered glyphs against the dominant background.
  /// This catches inherited pale ink on a light sheet (and the inverse).
  private func assertReadable(_ element: XCUIElement, in app: XCUIApplication, name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    let image = try XCTUnwrap(screenshot.image.cgImage)
    let scale = CGFloat(image.width) / app.frame.width
    let frame = element.frame
    let region = CGRect(x: frame.minX * scale, y: frame.minY * scale,
                        width: frame.width * scale, height: frame.height * scale)
    let cropped = try XCTUnwrap(image.cropping(to: region))
    let width = cropped.width
    let height = cropped.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let luminances = try pixels.withUnsafeMutableBytes { buffer -> [Double] in
      let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
      func linear(_ byte: UInt8) -> Double {
        let value = Double(byte) / 255
        return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
      }
      return stride(from: 0, to: buffer.count, by: 4).map { offset in
        0.2126 * linear(buffer[offset]) + 0.7152 * linear(buffer[offset + 1]) + 0.0722 * linear(buffer[offset + 2])
      }.sorted()
    }
    let background = luminances[luminances.count / 2]
    let readable = luminances.filter { value in
      (max(value, background) + 0.05) / (min(value, background) + 0.05) >= 4.5
    }.count
    let coverage = Double(readable) / Double(luminances.count)
    XCTAssertGreaterThan(coverage, 0.005, "\(name) needs visible glyphs with at least 4.5:1 contrast; coverage: \(coverage)")
  }

  func testPublicSampleAndPrivacyAccess() {
    let app = XCUIApplication()
    app.launchEnvironment["SHOULDERTAP_SERVER_URL"] = ProcessInfo.processInfo.environment["SHOULDERTAP_SERVER_URL"]
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
