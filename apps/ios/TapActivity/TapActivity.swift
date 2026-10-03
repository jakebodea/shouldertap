import ActivityKit
import AppIntents
import Foundation
import ShouldertapCore

// Compiled into both the app and the ShouldertapWidgets extension: the
// extension draws the activity, the app answers it.

/// A tap shown as a Live Activity: on the Lock Screen and in the Dynamic
/// Island until it's answered. The server starts it with a push-to-start
/// push whose `attributes` and `content-state` must decode as these
/// (`startActivityPayload` in apps/server/src/apns.ts).
nonisolated struct TapActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var body: String
    /// Set once answered, e.g. "On it · Studio Mac".
    var answer: String?
  }

  var tapId: String
  var senderName: String
  var senderColor: PersonColor
  /// Epoch milliseconds, as the server sends them.
  var createdAt: Timestamp

  var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

/// "On it" / "In 10 min" from the Lock Screen or the Dynamic Island,
/// without opening the app. The system runs it in the app's process.
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
    await TapAnswers.answer(tapId: tapId, response: response)
    return .result()
  }
}

/// Where answers from outside the app go. The app sets `handler` at launch
/// (it sends the answer and clears the tap); the extension never runs one.
enum TapAnswers {
  @MainActor static var handler: ((String, TapResponse) async -> Void)?

  @MainActor static func answer(tapId: String, response: TapResponse) async {
    if let handler {
      await handler(tapId, response)
    } else {
      await TapActivities.end(tapId: tapId, answer: response.label)
    }
  }
}

enum TapActivities {
  /// End the tap's Live Activity, showing `answer` until it's dismissed.
  static func end(tapId: String, answer: String?) async {
    for activity in Activity<TapActivityAttributes>.activities where activity.attributes.tapId == tapId {
      var state = activity.content.state
      state.answer = answer ?? state.answer
      await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate)
    }
  }
}
