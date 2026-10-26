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
    /// The sender's own two answers, when they changed them from On it and
    /// In 10 min.
    var replies: [String]?

    /// What the buttons offer, as `Tap.quickReplies`.
    var quickReplies: [QuickReply] {
      Tap(id: "", senderId: "", senderName: "", senderColor: .cobalt, body: body, createdAt: 0, replies: replies)
        .quickReplies
    }
  }

  var tapId: String
  var senderName: String
  var senderColor: PersonColor
  /// Epoch milliseconds, as the server sends them.
  var createdAt: Timestamp

  var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

/// "On it" / "In 10 min" (or the sender's own answers) from the Lock Screen
/// or the Dynamic Island, without opening the app. The system runs it in the
/// app's process.
struct AnswerTapIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Answer tap"
  static let isDiscoverable = false

  @Parameter(title: "Tap") var tapId: String
  @Parameter(title: "Answer") var kind: String
  /// A sender's own answer, sent as text.
  @Parameter(title: "Text") var text: String?

  init() {}

  init(tapId: String, response: TapResponse) {
    self.tapId = tapId
    kind = response.kind.rawValue
    text = response.text
  }

  func perform() async throws -> some IntentResult {
    let chosen = TapResponse.Kind(rawValue: kind) ?? .onIt
    let response: TapResponse =
      if chosen == .text, let text, !text.isEmpty {
        TapResponse(kind: .text, text: text)
      } else {
        TapResponse(kind: chosen == .text ? .onIt : chosen)
      }
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
  #if DEBUG && targetEnvironment(simulator)
    /// Render the real widget for artwork without APNs or production credentials.
    @MainActor static func startMarketingCaptureIfRequested() async {
      let environment = ProcessInfo.processInfo.environment
      guard environment["SHOULDERTAP_CAPTURE_ACTIVITY"] == "1" else { return }
      for activity in Activity<TapActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      do {
        _ = try Activity<TapActivityAttributes>.request(
          attributes: TapActivityAttributes(
            tapId: "marketing-tap-01", senderName: "Sam", senderColor: .moss,
            createdAt: Date.now.timeIntervalSince1970 * 1000),
          content: ActivityContent(
            state: .init(body: environment["SHOULDERTAP_CAPTURE_BODY"] ?? "Dinner's ready", answer: nil), staleDate: nil),
          pushType: nil)
      } catch {
        print("Marketing Live Activity capture failed: \(error)")
      }
    }
  #endif

  /// End the tap's Live Activity, showing `answer` until it's dismissed.
  static func end(tapId: String, answer: String?) async {
    for activity in Activity<TapActivityAttributes>.activities where activity.attributes.tapId == tapId {
      var state = activity.content.state
      state.answer = answer ?? state.answer
      await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate)
    }
  }
}
