import ActivityKit
import ShouldertapCore
import SwiftUI
import UserNotifications
import os

private let log = Logger(subsystem: "app.shouldertap.ios", category: "Receiving")

// Taps on this iPhone, once it's linked to your inbox. The server pushes
// each new tap (apps/server/src/apns.ts):
//
// - Live Activities on: it starts the tap's Live Activity with a
//   push-to-start push (Lock Screen and Dynamic Island, answerable in place).
// - Otherwise: a Time Sensitive notification with On it, In 10 min, Reply.
// - App open: the takeover fills the screen, like the Mac overlay.
//
// Once a tap is answered anywhere, the server ends its Live Activity (with
// the token we report for it) and sends a background push; the app clears
// whatever is left. Opening the app reconciles too.

/// Push setup and everything about taps arriving on this phone.
@MainActor @Observable
final class Receiver {
  static let shared = Receiver()

  /// The tap whose takeover opened straight into typing a reply.
  var replyingTapId: String?

  @ObservationIgnored private var inbox: ReceiverStore?
  /// The last tokens iOS gave us, kept across launches: after a restart iOS
  /// can take a while to hand them over again, and a change (Live
  /// Activities turned off) must reach the server before the next tap.
  private var deviceToken: String? {
    get { UserDefaults.standard.string(forKey: "push.deviceToken") }
    set { UserDefaults.standard.set(newValue, forKey: "push.deviceToken") }
  }
  private var startToken: String? {
    get { UserDefaults.standard.string(forKey: "push.startToken") }
    set { UserDefaults.standard.set(newValue, forKey: "push.startToken") }
  }
  @ObservationIgnored private var liveActivities = ActivityAuthorizationInfo().areActivitiesEnabled
  /// What the server last accepted (or is being sent), per credential, so
  /// token callbacks arriving together don't repeat it.
  @ObservationIgnored private var registered: (credentialId: String, registration: PushRegistration)?
  @ObservationIgnored private var observing = false
  /// Taps that were waiting at the last reconcile, to notice deleted ones.
  @ObservationIgnored private var waiting: Set<String> = []
  @ObservationIgnored private var reportedActivities: Set<String> = []

  nonisolated static let category = "tap"

  func attach(_ inbox: ReceiverStore) {
    self.inbox = inbox
    TapAnswers.handler = { [weak self] tapId, response in await self?.answer(tapId: tapId, response: response) }
    observe()
  }

  // MARK: Push setup

  /// Called whenever the link may have changed (launch, linking, foreground).
  /// Asks once for notification permission, then keeps the server current.
  func sync() {
    guard let inbox, inbox.phase == .ready else { return }
    Task {
      let center = UNUserNotificationCenter.current()
      let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
      if !granted { log.notice("Notifications aren't allowed") }
      UIApplication.shared.registerForRemoteNotifications()
      await upload()
    }
  }

  func didRegister(deviceToken data: Data) {
    deviceToken = data.map { String(format: "%02x", $0) }.joined()
    Task { await upload() }
  }

  /// Tokens arrive and change on their own: watch them for as long as the
  /// app runs, linked or not.
  private func observe() {
    guard !observing else { return }
    observing = true
    Task {
      for await enabled in ActivityAuthorizationInfo().activityEnablementUpdates {
        liveActivities = enabled
        await upload()
      }
    }
    if #available(iOS 17.2, *) {
      Task {
        for await data in Activity<TapActivityAttributes>.pushToStartTokenUpdates {
          startToken = data.map { String(format: "%02x", $0) }.joined()
          await upload()
        }
      }
    }
    // Activities the server started: report each one's token so answering
    // the tap anywhere ends it here.
    Task {
      for activity in Activity<TapActivityAttributes>.activities { watch(activity) }
      for await activity in Activity<TapActivityAttributes>.activityUpdates { watch(activity) }
    }
  }

  private func watch(_ activity: Activity<TapActivityAttributes>) {
    guard reportedActivities.insert(activity.id).inserted else { return }
    let tapId = activity.attributes.tapId
    Task {
      for await data in activity.pushTokenUpdates {
        let token = data.map { String(format: "%02x", $0) }.joined()
        // iOS wakes the app briefly to hand over the token: ask for the few
        // seconds the request needs.
        let background = UIApplication.shared.beginBackgroundTask(withName: "activity-token")
        defer { UIApplication.shared.endBackgroundTask(background) }
        do {
          try await inbox?.saveActivityToken(tapId: tapId, token: token)
        } catch let error as APIError where error.code == .notFound {
          // Answered before we could report it: end it here.
          await TapActivities.end(tapId: tapId, answer: nil)
        } catch {
          log.error("Couldn't report a Live Activity token: \(error)")
        }
      }
    }
  }

  private func upload() async {
    // The credential id only arrives with the first snapshot, which can be
    // after the tokens: don't wait for it (it only keys the "already sent" check).
    guard let inbox, inbox.phase == .ready else { return }
    let credentialId = inbox.credentialId ?? ""
    let registration = PushRegistration(
      environment: Self.environment, topic: Bundle.main.bundleIdentifier ?? "app.shouldertap.ios",
      deviceToken: deviceToken, startToken: startToken, liveActivities: liveActivities)
    guard registration.deviceToken != nil || registration.startToken != nil else { return }
    if let registered, registered.credentialId == credentialId, registered.registration == registration { return }
    let previous = registered
    registered = (credentialId, registration)
    do {
      try await inbox.registerPush(registration)
      log.notice(
        "Registered for pushes: device token \(registration.deviceToken != nil), start token \(registration.startToken != nil), Live Activities \(registration.liveActivities)"
      )
    } catch {
      registered = previous
      log.error("Couldn't register for pushes: \(error)")
    }
  }

  /// Debug and simulator builds get sandbox tokens; TestFlight and the App
  /// Store, production.
  private static var environment: PushEnvironment {
    #if DEBUG || targetEnvironment(simulator)
      .sandbox
    #else
      .production
    #endif
  }

  // MARK: Answering

  /// From the takeover, the Lock Screen, the Dynamic Island or a
  /// notification: clear it here at once, then tell the server.
  func answer(tapId: String, response: TapResponse) async {
    replyingTapId = nil
    // Sending starts at once (and the takeover moves on); clearing runs alongside.
    async let sent: Void = inbox?.answer(tapId: tapId, response: response) ?? ()
    await clear(tapId: tapId, answer: response.label)
    await sent
  }

  /// A tap answered (here or elsewhere): end its Live Activity and remove
  /// its notification.
  func clear(tapId: String, answer: String? = nil) async {
    log.notice("Clearing tap \(tapId, privacy: .public)")
    await TapActivities.end(tapId: tapId, answer: answer)
    let center = UNUserNotificationCenter.current()
    let delivered = await center.deliveredNotifications()
    let ids = delivered.filter { $0.request.content.userInfo["tapId"] as? String == tapId }.map(\.request.identifier)
    center.removeDeliveredNotifications(withIdentifiers: ids)
  }

  /// After a snapshot: anything still showing for a tap that's been answered,
  /// or deleted while it waited, goes.
  func reconcile(_ taps: [Tap]) {
    let deleted = waiting.subtracting(taps.map(\.id))
    waiting = Set(taps.filter { $0.state == .pending }.map(\.id))
    let answered = Set(taps.filter { $0.state == .acknowledged }.map(\.id)).union(deleted)
    let showing = Set(Activity<TapActivityAttributes>.activities.map(\.attributes.tapId))
    Task {
      for tapId in answered.intersection(showing) { await TapActivities.end(tapId: tapId, answer: nil) }
      let center = UNUserNotificationCenter.current()
      let stale = await center.deliveredNotifications().filter {
        ($0.request.content.userInfo["tapId"] as? String).map(answered.contains) ?? false
      }
      center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier))
    }
  }

  /// shouldertap://tap/<id>[?reply=1], from the Live Activity.
  func handle(_ url: URL) -> Bool {
    guard url.scheme == "shouldertap", url.host() == "tap" else { return false }
    let reply = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
      .contains { $0.name == "reply" && $0.value == "1" } ?? false
    replyingTapId = reply ? url.lastPathComponent : nil
    inbox?.refresh()
    return true
  }

  /// The notification's actions: answer in place, or a typed reply.
  static func registerCategory() {
    let center = UNUserNotificationCenter.current()
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: category,
        actions: [
          UNNotificationAction(identifier: TapResponse.Kind.onIt.rawValue, title: "On it"),
          UNNotificationAction(identifier: TapResponse.Kind.in10.rawValue, title: "In 10 min"),
          UNTextInputNotificationAction(
            identifier: TapResponse.Kind.text.rawValue, title: "Reply", textInputButtonTitle: "Send",
            textInputPlaceholder: "Reply"),
        ],
        intentIdentifiers: [])
    ])
    center.delegate = NotificationRouter.shared
  }
}

/// Tap notifications: while the app is open the takeover shows instead of a
/// banner; their actions answer the tap.
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationRouter()

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    guard notification.request.content.categoryIdentifier == Receiver.category else { return [.banner, .sound] }
    return []
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    guard let tapId = response.notification.request.content.userInfo["tapId"] as? String else { return }
    let action = response.actionIdentifier
    let text = (response as? UNTextInputNotificationResponse)?.userText
    let answer: TapResponse? =
      switch action {
      case TapResponse.Kind.onIt.rawValue: .onIt
      case TapResponse.Kind.in10.rawValue: .in10
      case TapResponse.Kind.text.rawValue:
        TapResponse(kind: .text, text: String((text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxReplyLength)))
      default: nil
      }
    guard let answer, answer.kind != .text || !(answer.text ?? "").isEmpty else { return }
    await Receiver.shared.answer(tapId: tapId, response: answer)
  }
}

// MARK: - Takeover

/// The Mac overlay on a phone: the sender's color fills the screen and holds
/// a paper page with the message and the answers. Shown for the oldest
/// waiting tap while the app is open.
struct TapTakeover: View {
  let active: ActiveTap
  let receiver: Receiver
  @State private var replying = false
  @State private var reply = ""
  @FocusState private var focused: Bool

  private var tap: Tap { active.tap }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(tap.senderName)
          .font(Bricolage.bold(24))
          .tracking(-0.5)
          .lineLimit(1)
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text(relativeTime(tap.createdAt, now: context.date))
            .font(Bricolage.medium(15))
            .opacity(0.75)
        }
        Spacer()
        if active.queued > 0 {
          Text("\(active.queued) more waiting")
            .font(Bricolage.bold(14))
            .opacity(0.8)
        }
      }
      .foregroundStyle(tap.senderColor.ink)
      .padding(.horizontal, 24)
      .frame(height: 56)

      VStack(alignment: .leading, spacing: 20) {
        Text(tap.body)
          .font(Bricolage.extraBold(messageSize, relativeTo: .largeTitle))
          .tracking(-0.04 * messageSize)
          .lineSpacing(-0.1 * messageSize)
          .minimumScaleFactor(0.4)
          .foregroundStyle(Paper.ink)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .textSelection(.enabled)
          .id(tap.id)
          .transition(.rise)
        if replying { replyRow } else { answerRows }
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Paper.paper, in: .rect(cornerRadius: 32, style: .continuous))
      .padding(.horizontal, 9)
      .padding(.bottom, 9)
    }
    .background(tap.senderColor.base.ignoresSafeArea())
    .sensoryFeedback(.impact(weight: .heavy), trigger: tap.id)
    .onAppear { replying = receiver.replyingTapId == tap.id }
    .onChange(of: tap.id) { _, id in
      reply = ""
      replying = receiver.replyingTapId == id
    }
  }

  private var answerRows: some View {
    VStack(spacing: 8) {
      Button { answer(.onIt) } label: { label(.onIt, "On it") }
        .buttonStyle(PillStyle(color: tap.senderColor))
        .accessibilityIdentifier("takeover-on-it")
      Button { answer(.in10) } label: { label(.in10, "In 10 min") }
        .buttonStyle(PillStyle())
      Button { withAnimation(.outExpo(0.4)) { replying = true } } label: { label(.reply, "Reply") }
        .buttonStyle(PillStyle())
    }
  }

  private var replyRow: some View {
    VStack(spacing: 8) {
      TextField("Reply to \(tap.senderName)", text: $reply, axis: .vertical)
        .lineLimit(1...4)
        .field()
        .focused($focused)
        .onAppear { focused = true }
        .onChange(of: reply) { _, text in
          if text.count > maxReplyLength { reply = String(text.prefix(maxReplyLength)) }
        }
      Button {
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        answer(TapResponse(kind: .text, text: text))
      } label: { label(.send, "Send") }
        .buttonStyle(PillStyle(color: tap.senderColor))
        .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      Button("Back") { withAnimation(.outExpo(0.4)) { replying = false } }
        .buttonStyle(QuietStyle())
    }
  }

  private func answer(_ response: TapResponse) {
    focused = false
    let tapId = tap.id
    Task { await receiver.answer(tapId: tapId, response: response) }
  }

  private func label(_ icon: Icon, _ text: String) -> some View {
    HStack(spacing: 8) {
      IconView(icon: icon, size: 20)
      Text(text)
    }
  }

  /// 64pt for a few words down to 34pt for a paragraph.
  private var messageSize: CGFloat {
    let t = min(1, max(0, Double(tap.body.count - 14) / 70))
    return (64 - 30 * t.squareRoot()).rounded()
  }
}
