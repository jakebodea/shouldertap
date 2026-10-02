import ActivityKit
import AppIntents
import Foundation
import ShouldertapCore

// Compiled into both the app and the ShouldertapWidgets extension: the
// extension draws the activity, the app starts it and runs the intents.

/// A tap shown as a Live Activity: on the Lock Screen and in the Dynamic
/// Island until it's answered.
nonisolated struct TapActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var body: String
    /// Set once answered; the activity shows it briefly, then leaves.
    var answer: String?
  }

  var tapId: String
  var senderName: String
  var senderColor: PersonColor
  var createdAt: Date
}

/// "On it" / "In 10 min" from the Lock Screen or the Dynamic Island,
/// without opening the app. Runs in the app's process.
struct AnswerTapIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Answer tap"
  static let isDiscoverable = false

  @Parameter(title: "Tap") var tapId: String
  @Parameter(title: "Answer") var kind: String

  init() {}

  init(tapId: String, response: TapResponse.Kind) {
    self.tapId = tapId
    kind = response.rawValue
  }

  func perform() async throws -> some IntentResult {
    let response = TapResponse(kind: TapResponse.Kind(rawValue: kind) ?? .onIt)
    await TapActivities.answer(tapId: tapId, with: response)
    return .result()
  }
}

enum TapActivities {
  /// Show the answer for a moment, then dismiss. RECEIVER SEAM: also send
  /// `response` to the server for `tapId`, as the Mac does.
  static func answer(tapId: String, with response: TapResponse) async {
    for activity in Activity<TapActivityAttributes>.activities where activity.attributes.tapId == tapId {
      var state = activity.content.state
      state.answer = response.label
      await activity.end(
        ActivityContent(state: state, staleDate: nil),
        dismissalPolicy: .after(.now.addingTimeInterval(4)))
    }
  }

  /// Re-announce a tap the way a pushed update with an alert would: lights
  /// the Lock Screen, or expands the Dynamic Island over the current app.
  static func alert(tapId: String) async {
    for activity in Activity<TapActivityAttributes>.activities where activity.attributes.tapId == tapId {
      let content = activity.content
      await activity.update(
        content,
        alertConfiguration: AlertConfiguration(
          title: "\(activity.attributes.senderName)", body: "\(content.state.body)", sound: .default))
    }
  }
}
