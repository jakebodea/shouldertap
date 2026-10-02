import ActivityKit
import ShouldertapCore
import SwiftUI
import UserNotifications
import os

private let log = Logger(subsystem: "app.shouldertap.ios", category: "IncomingTaps")

// MARK: - RECEIVER SEAM (prototype)
//
// The iPhone is only a sender today. This is the receiving side's surface,
// the iPhone's answer to the Mac overlay, in three layers:
//
// - App open: `TapTakeover` fills the screen, like the Mac overlay.
// - Locked or in another app: a Live Activity (Widgets/TapLiveActivity.swift)
//   on the Lock Screen and in the Dynamic Island, answerable in place.
// - A Time Sensitive notification (category "tap") with On it, In 10 min
//   and a typed Reply, for when Live Activities are off.
//
// Not wired yet: an inbox for the phone on the server, sending answers
// back, and APNs. In production the server starts the Live Activity with a
// push-to-start token (`Activity.pushToStartTokenUpdates`, iOS 17.2) and
// sends the notification over APNs; here, debug builds fake an arriving tap
// with shouldertap://demo-tap (see `handle(_:)`).

nonisolated struct IncomingTap: Identifiable, Equatable, Sendable {
  let id: String
  var senderName: String
  var color: PersonColor
  var body: String
  var createdAt: Date
}

@MainActor @Observable
final class IncomingTaps {
  static let shared = IncomingTaps()

  /// The tap filling the screen while the app is open.
  var current: IncomingTap?
  var replying = false

  nonisolated static let category = "tap"

  /// Arrival: take over the screen and start the Live Activity that stands
  /// in for it once the app is left.
  func receive(_ tap: IncomingTap, takeOver: Bool = true) {
    if takeOver { show(tap) }
    startActivity(tap)
  }

  func show(_ tap: IncomingTap, replying: Bool = false) {
    withAnimation(.outExpo(0.52)) {
      current = tap
      self.replying = replying
    }
  }

  func answer(_ response: TapResponse) {
    guard let tap = current else { return }
    Task { await TapActivities.answer(tapId: tap.id, with: response) }
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [tap.id])
    withAnimation(.easeOut(duration: 0.42)) {
      current = nil
      replying = false
    }
  }

  /// shouldertap://tap/<id>[?reply=1] from the Live Activity, and in debug
  /// builds shouldertap://demo-tap?from=&color=&body=&delay= (or
  /// demo-tap/<from>/<color>/<delay>) to fake one.
  func handle(_ url: URL) -> Bool {
    guard url.scheme == "shouldertap" else { return false }
    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String? { query.first { $0.name == name }?.value }

    switch url.host() {
    case "tap":
      let id = url.lastPathComponent
      if let activity = Activity<TapActivityAttributes>.activities.first(where: { $0.attributes.tapId == id }) {
        show(IncomingTap(activity), replying: value("reply") == "1")
      }
      return true
    #if DEBUG
    case "demo-tap":
      // Also /<from>/<color>/<delay>, for shells that mangle `&`.
      let path = url.pathComponents.dropFirst().map { $0 }
      func part(_ index: Int) -> String? { path.indices.contains(index) ? path[index] : nil }
      let tap = IncomingTap(
        id: UUID().uuidString, senderName: value("from") ?? part(0) ?? "Maya",
        color: (value("color") ?? part(1)).flatMap(PersonColor.init(rawValue:)) ?? .tomato,
        body: value("body") ?? "Dinner's ready, come down?", createdAt: .now)
      demo(tap, delay: (value("delay") ?? part(2)).flatMap(Double.init))
      return true
    #endif
    default:
      return false
    }
  }

  #if DEBUG
  /// With a delay: start the Live Activity now (it can only start in the
  /// foreground), then "arrive" after `delay` seconds with an alert that
  /// lights the Lock Screen or expands the Dynamic Island, the way a pushed
  /// update would; if the app is still open by then, take over instead.
  private func demo(_ tap: IncomingTap, delay: Double?) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    guard let delay else { return receive(tap) }
    receive(tap, takeOver: false)
    let task = UIApplication.shared.beginBackgroundTask()
    Task {
      try? await Task.sleep(for: .seconds(delay))
      if UIApplication.shared.applicationState == .active {
        show(tap)
      } else {
        await TapActivities.alert(tapId: tap.id)
      }
      UIApplication.shared.endBackgroundTask(task)
    }
  }
  #endif

  private func startActivity(_ tap: IncomingTap) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      log.notice("Live Activities are off for Shouldertap")
      return
    }
    let attributes = TapActivityAttributes(
      tapId: tap.id, senderName: tap.senderName, senderColor: tap.color, createdAt: tap.createdAt)
    let activity: Activity<TapActivityAttributes>
    do {
      activity = try Activity.request(
        attributes: attributes,
        content: ActivityContent(state: .init(body: tap.body), staleDate: nil, relevanceScore: 100))
    } catch {
      log.error("Couldn't start the tap's Live Activity: \(error)")
      return
    }
    // Answered from the Lock Screen or the island: leave the takeover too.
    Task {
      for await state in activity.activityStateUpdates where state != .active {
        if current?.id == tap.id {
          withAnimation(.easeOut(duration: 0.42)) { current = nil }
        }
        break
      }
    }
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

nonisolated extension IncomingTap {
  init(_ activity: Activity<TapActivityAttributes>) {
    let attributes = activity.attributes
    self.init(
      id: attributes.tapId, senderName: attributes.senderName, color: attributes.senderColor,
      body: activity.content.state.body, createdAt: attributes.createdAt)
  }

  /// A tap notification's payload: `aps` plus tapId, senderName, senderColor.
  init?(_ content: UNNotificationContent) {
    guard content.categoryIdentifier == IncomingTaps.category else { return nil }
    let info = content.userInfo
    self.init(
      id: info["tapId"] as? String ?? UUID().uuidString,
      senderName: info["senderName"] as? String ?? content.title,
      color: (info["senderColor"] as? String).flatMap(PersonColor.init(rawValue:)) ?? .cobalt,
      body: content.body, createdAt: .now)
  }
}

/// A tap notification arriving while the app is open becomes the takeover;
/// its actions answer it.
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationRouter()

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    let tap = IncomingTap(notification.request.content)
    return await MainActor.run {
      guard let tap else { return [.banner, .sound] }
      IncomingTaps.shared.receive(tap)
      return []
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let tap = IncomingTap(response.notification.request.content)
    let action = response.actionIdentifier
    let text = (response as? UNTextInputNotificationResponse)?.userText
    await MainActor.run {
      guard let tap else { return }
      let taps = IncomingTaps.shared
      taps.current = tap
      switch action {
      case TapResponse.Kind.onIt.rawValue: taps.answer(.onIt)
      case TapResponse.Kind.in10.rawValue: taps.answer(.in10)
      case TapResponse.Kind.text.rawValue:
        taps.answer(TapResponse(kind: .text, text: String((text ?? "").prefix(maxReplyLength))))
      default: taps.show(tap)
      }
    }
  }
}

// MARK: - Takeover

/// The Mac overlay on a phone: the sender's color fills the screen and holds
/// a paper page with the message and the answers.
struct TapTakeover: View {
  @Bindable var taps: IncomingTaps
  let tap: IncomingTap
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(tap.senderName)
          .font(Bricolage.bold(24))
          .tracking(-0.5)
          .lineLimit(1)
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text(relativeTime(tap.createdAt.timeIntervalSince1970 * 1000, now: context.date))
            .font(Bricolage.medium(15))
            .opacity(0.75)
        }
        Spacer()
      }
      .foregroundStyle(tap.color.ink)
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
        if taps.replying { replyRow } else { answerRows }
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Paper.paper, in: .rect(cornerRadius: 32, style: .continuous))
      .padding(.horizontal, 9)
      .padding(.bottom, 9)
    }
    .background(tap.color.base.ignoresSafeArea())
    .accessibilityIdentifier("tap-takeover")
  }

  private var answerRows: some View {
    VStack(spacing: 8) {
      Button { taps.answer(.onIt) } label: { label(.onIt, "On it") }
        .buttonStyle(PillStyle(color: tap.color))
      Button { taps.answer(.in10) } label: { label(.in10, "In 10 min") }
        .buttonStyle(PillStyle())
      Button { withAnimation(.outExpo(0.4)) { taps.replying = true } } label: { label(.reply, "Reply") }
        .buttonStyle(PillStyle())
    }
  }

  @State private var reply = ""

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
        taps.answer(TapResponse(kind: .text, text: text))
      } label: { label(.send, "Send") }
        .buttonStyle(PillStyle(color: tap.color))
        .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      Button("Back") { withAnimation(.outExpo(0.4)) { taps.replying = false } }
        .buttonStyle(QuietStyle())
    }
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
