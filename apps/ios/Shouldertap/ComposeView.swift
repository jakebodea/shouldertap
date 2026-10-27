import ShouldertapCore
import SwiftUI

/// The paired screen: everyone you can tap as avatars on the frame (tap one
/// to switch, and the frame floods to their color; long-press for their page
/// in Settings), and the composer for the selected person on the page, which
/// rises into place when it appears.
struct ComposeView: View {
  let session: SenderSession
  let store: SenderStore
  let onSelect: (String) -> Void
  let onAdd: () -> Void

  @State private var risen = false
  @State private var pressed = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.inboxActions) private var actions

  var body: some View {
    VStack(spacing: 0) {
      FrameBar {
        // Knocks each time one of your taps reaches their screen.
        Wordmark(knock: session.taps.filter { $0.displayedAt != nil }.count)
      } trailing: {
        HStack(spacing: 6) {
          people
          SettingsButton()
        }
      }
      ZStack {
        ComposerPage(session: session)
          .id(session.id)
          .transition(reduceMotion ? .opacity : .rise)
      }
      .onPaper()
        .offset(y: risen || reduceMotion ? 0 : 320)
        .opacity(risen ? 1 : 0)
    }
    .onAppear {
      withAnimation(.outExpo(0.8)) { risen = true }
    }
  }

  private var people: some View {
    HStack(spacing: 6) {
      ForEach(store.sessions) { person in
        let selected = person.id == session.id
        PersonChip(person: person, selected: selected)
          .onTapGesture { onSelect(person.id) }
          .onLongPressGesture(minimumDuration: 0.4) {
            pressed += 1
            actions.settings(.person(person.id))
          }
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(person.pairing.recipientName)
          .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
          .accessibilityAction { onSelect(person.id) }
          .accessibilityAction(named: "How \(person.pairing.recipientName) sees you") {
            actions.settings(.person(person.id))
          }
          .accessibilityIdentifier("person-\(person.pairing.recipientName)")
      }
      Button(action: onAdd) { IconView(icon: .invite, size: 19) }
        .buttonStyle(FrameButtonStyle(iconOnly: true))
        .accessibilityLabel("Add someone")
        .accessibilityIdentifier("add-person")
    }
    .sensoryFeedback(.selection, trigger: session.id)
    .sensoryFeedback(.impact(weight: .medium), trigger: pressed)
  }
}

/// Someone you can tap, on the frame: their initial in their color, ringed
/// in the frame's ink when selected.
private struct PersonChip: View {
  let person: SenderSession
  let selected: Bool
  @Environment(\.frameColor) private var frame

  var body: some View {
    Avatar(name: person.pairing.recipientName, color: person.color, size: 34)
      .overlay(Circle().strokeBorder(frame.ink.opacity(selected ? 0 : 0.3), lineWidth: 1.5))
      .padding(3)
      .overlay(Circle().strokeBorder(frame.ink, lineWidth: 2).opacity(selected ? 1 : 0))
      .scaleEffect(selected ? 1.06 : 0.94)
      .animation(.spring(duration: 0.4, bounce: 0.4), value: selected)
      .contentShape(.circle)
  }
}

/// Compose and follow taps to one recipient. Mirrors apps/web/src/routes/tap.tsx.
private struct ComposerPage: View {
  let session: SenderSession

  @State private var draft = ""
  /// This tap's answers when changed here; nil follows the account's defaults.
  @State private var replies: [String]?
  @State private var savingReplies = false
  @State private var sent = 0
  @State private var deleting: Tap?
  @State private var deleteError: String?
  @FocusState private var focused: Bool

  private var recipient: String { session.pairing.recipientName }
  private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var defaultReplies: [String] { Stores.account.me?.defaultReplies ?? defaultQuickReplies }
  private var shownReplies: [String] { replies ?? defaultReplies }

  var body: some View {
    Page {
      header

      VStack(spacing: 12) {
        TextField("What does \(recipient) need to know?", text: $draft, axis: .vertical)
          .lineLimit(4...8)
          .focused($focused)
          .onChange(of: draft) { _, value in
            if value.count > maxTapLength { draft = String(value.prefix(maxTapLength)) }
          }
          .accessibilityIdentifier("tap-field")
          .field()
          .overlay(alignment: .bottomTrailing) {
            if draft.count > maxTapLength - 40 {
              Text("\(maxTapLength - draft.count)")
                .font(Bricolage.medium(13).monospacedDigit())
                .foregroundStyle(Paper.tone)
                .padding(10)
            }
          }
        replyOptions
        Button(action: send) {
          Label {
            Text("Send tap")
          } icon: {
            IconView(icon: .send, size: 20)
          }
        }
        .buttonStyle(PillStyle(color: session.color))
        .disabled(trimmed.isEmpty || tidyQuickReplies(shownReplies) == nil)
        .accessibilityIdentifier("send-button")
      }

      recent
    }
    .confirmationDialog(
      "Delete this tap?",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible,
      presenting: deleting
    ) { tap in
      Button("Delete", role: .destructive) { delete(tap) }
    } message: { tap in
      Text(
        tap.state == .pending
          ? "It's taken back from \(recipient)'s screens before they answer, and removed for both of you."
          : "It's removed for both of you, along with \(recipient)'s answer.")
    }
    .alert(
      "Couldn't delete", isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(deleteError ?? "")
    }
    .sensoryFeedback(.success, trigger: session.taps.first { $0.state == .acknowledged }?.id)
    .sensoryFeedback(.impact(weight: .medium), trigger: sent)
  }

  private func delete(_ tap: Tap) {
    Task {
      do {
        try await session.delete(tapId: tap.id)
      } catch {
        deleteError = (error as? APIError)?.errorDescription ?? error.localizedDescription
      }
    }
  }

  /// The two answers this tap offers, editable for it alone.
  private var replyOptions: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("\(recipient) can answer")
        .font(Bricolage.bold(14, relativeTo: .subheadline))
        .foregroundStyle(Paper.tone)
      QuickReplyFields(replies: Binding(get: { shownReplies }, set: { replies = $0 }))
      if case .failure(let problem) = normalizeQuickReplies(shownReplies) {
        Text(problem.localizedDescription)
          .font(Bricolage.medium(14))
          .foregroundStyle(.red)
      } else if let chosen = tidyQuickReplies(shownReplies), chosen != defaultReplies {
        HStack(spacing: 4) {
          if Stores.account.me != nil {
            Button("Use these for every tap") {
              savingReplies = true
              Task {
                if await Stores.account.saveQuickReplies(chosen) { replies = nil }
                savingReplies = false
              }
            }
            .disabled(savingReplies)
          }
          Button("Reset") { replies = nil }
        }
        .buttonStyle(QuietStyle())
        .padding(.horizontal, -16)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Tap \(recipient)")
        .font(Bricolage.extraBold(34))
        .tracking(-1.2)
        .multilineTextAlignment(.leading)
        .accessibilityAddTraits(.isHeader)
      StatusLabel(status: session.status)
    }
  }

  private var recent: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Recent")
        .font(Bricolage.bold(14, relativeTo: .subheadline))
        .foregroundStyle(Paper.tone)
        .padding(.bottom, 4)
      TimelineView(.periodic(from: .now, by: 15)) { context in
        VStack(alignment: .leading, spacing: 0) {
          ForEach(session.outbox) { item in
            row { OutboxRow(item: item, color: session.color, session: session) }
          }
          ForEach(session.taps) { tap in
            row {
              TapRow(tap: tap, recipient: recipient, color: session.color, now: context.date)
                .contextMenu {
                  Button("Delete", systemImage: "trash", role: .destructive) { deleting = tap }
                  Link("Report this tap or reply", destination: reportURL(tap))
                }
            }
          }
        }
      }
      if session.loaded && session.taps.isEmpty && session.outbox.isEmpty {
        Text("Nothing sent yet. Your taps and \(recipient)'s answers show up here.")
          .font(Bricolage.medium(15))
          .foregroundStyle(Paper.tone)
          .padding(.top, 8)
      }
    }
  }

  private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(spacing: 0) {
      content().padding(.vertical, 16)
      Rectangle().fill(Paper.line).frame(height: 1)
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }

  private func reportURL(_ tap: Tap) -> URL {
    var url = URLComponents()
    url.scheme = "mailto"
    url.path = "support@shouldertap.app"
    url.queryItems = [
      URLQueryItem(name: "subject", value: "Shouldertap abuse report"),
      URLQueryItem(name: "body", value: "Tap ID: \(tap.id)\nPairing ID: \(session.id)\n\nDescribe the problem here. Include only information you want to share with support.")
    ]
    return url.url!
  }

  private func send() {
    do {
      try withAnimation(.outExpo(0.5)) { try session.send(draft, replies: shownReplies) }
      draft = ""
      replies = nil
      focused = false
      sent += 1
    } catch {
      // The button is disabled for empty drafts and the field caps length.
    }
  }
}

/// The two one-tap answers a tap offers, editable. The number on each is the
/// key that sends it from a computer.
struct QuickReplyFields: View {
  @Binding var replies: [String]

  var body: some View {
    HStack(spacing: 8) {
      ForEach(0..<2, id: \.self) { index in
        HStack(spacing: 8) {
          Text("\(index + 1)")
            .font(Bricolage.bold(14).monospacedDigit())
            .foregroundStyle(Paper.tone)
          TextField(
            "Reply \(index + 1)",
            text: Binding(
              get: { replies.indices.contains(index) ? replies[index] : "" },
              set: { value in
                var next = replies + Array(repeating: "", count: max(0, 2 - replies.count))
                next[index] = String(value.prefix(maxQuickReplyLength))
                replies = next
              })
          )
          .submitLabel(.done)
          .accessibilityLabel("Reply option \(index + 1)")
        }
        .field()
      }
    }
  }
}

/// Three segments in the sender's color: Sent, On screen, Answered. The
/// current step pulses.
struct Track: View {
  let reached: Int
  let color: PersonColor
  let note: String
  @State private var pulse = false

  private static let steps = ["Sent", "On screen", "Answered"]

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { step in
          Capsule()
            .fill(step <= reached ? color.base : Paper.faint)
            .opacity(step == reached ? (pulse ? 0.35 : 1) : 1)
            .frame(height: 5)
        }
      }
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { step in
          Text(Self.steps[step])
            .foregroundStyle(step == reached - 1 ? Paper.ink : Paper.tone)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .font(Bricolage.bold(12, relativeTo: .caption))
    }
    .onAppear {
      withAnimation(.easeInOut(duration: 0.8).repeatForever()) { pulse = true }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(note)
  }
}

struct TapRow: View {
  let tap: Tap
  let recipient: String
  let color: PersonColor
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(tap.body)
          .font(Bricolage.bold(21))
          .tracking(-0.4)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(relativeTime(tap.createdAt, now: now))
          .font(Bricolage.medium(13, relativeTo: .caption).monospacedDigit())
          .foregroundStyle(Paper.tone)
      }
      if tap.state == .acknowledged, let response = tap.response, let acknowledgedAt = tap.acknowledgedAt {
        Answer(response: response, createdAt: tap.createdAt, acknowledgedAt: acknowledgedAt, by: tap.acknowledgedBy)
          .transition(.opacity.combined(with: .scale(scale: 0.97)))
      } else {
        Track(
          reached: tap.displayedAt == nil ? 1 : 2, color: color,
          note: tap.displayedAt == nil ? "Waiting to be opened" : "On \(recipient)'s screen now")
      }
    }
    .animation(.easeOut(duration: 0.3), value: tap.state)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("tap-\(tap.id)")
  }
}

/// The answer card: icon, answer, how long it took and on which Mac.
struct Answer: View {
  let response: TapResponse
  let createdAt: Timestamp
  let acknowledgedAt: Timestamp
  let by: String?

  var body: some View {
    HStack(spacing: 10) {
      IconView(icon: icon, size: 20)
      Text(response.label)
        .font(Bricolage.bold(17))
        .frame(maxWidth: .infinity, alignment: .leading)
      VStack(alignment: .trailing, spacing: 0) {
        Text("\(duration(from: createdAt, to: acknowledgedAt)) later")
        if let by { Text("on \(by)") }
      }
      .font(Bricolage.medium(13, relativeTo: .caption).monospacedDigit())
      .foregroundStyle(Paper.tone)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(Paper.faint, in: .rect(cornerRadius: 16, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("answer")
  }

  private var icon: Icon {
    switch response.kind {
    case .onIt: .onIt
    case .in10: .in10
    case .text: .reply
    }
  }
}

struct OutboxRow: View {
  let item: OutgoingTap
  let color: PersonColor
  let session: SenderSession

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(item.body)
        .font(Bricolage.bold(21))
        .tracking(-0.4)
      if item.failed {
        HStack(spacing: 8) {
          Text(item.error ?? "Couldn't send")
            .font(Bricolage.bold(15))
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
          Button("Discard") { session.discard(requestId: item.requestId) }
            .buttonStyle(PillStyle(small: true))
          Button("Try again") { session.retry(requestId: item.requestId) }
            .buttonStyle(PillStyle(color: color, small: true))
        }
      } else {
        Track(reached: 0, color: color, note: "Sending")
      }
    }
  }
}
