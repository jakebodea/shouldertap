import ShouldertapCore
import SwiftUI

/// Compose and follow taps to one recipient. Mirrors apps/web/src/routes/tap.tsx.
struct ComposeView: View {
  let session: SenderSession
  let store: SenderStore
  let onSelect: (String) -> Void
  let onAdd: () -> Void

  @State private var draft = ""
  @State private var confirmUnpair = false
  @FocusState private var focused: Bool

  private var recipient: String { session.pairing.recipientName }
  private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    Frame(color: session.color) {
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
        Button(action: send) {
          Label {
            Text("Send tap")
          } icon: {
            IconView(icon: .send, size: 20)
          }
        }
        .buttonStyle(PillStyle(color: session.color))
        .disabled(trimmed.isEmpty)
        .accessibilityIdentifier("send-button")
      }

      recent

      footer
    }
    .confirmationDialog(
      "Stop sending taps to \(recipient) from this phone?", isPresented: $confirmUnpair, titleVisibility: .visible
    ) {
      Button("Unpair", role: .destructive) { store.unpair(id: session.id) }
    }
    .sensoryFeedback(.success, trigger: session.taps.first { $0.state == .acknowledged }?.id)
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 16) {
      if store.sessions.count > 1 {
        Menu {
          ForEach(store.sessions) { other in
            Button {
              onSelect(other.id)
            } label: {
              Text(other.pairing.recipientName)
              if other.id == session.id { Image(systemName: "checkmark") }
            }
          }
          Divider()
          Button("Pair with someone else", action: onAdd)
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            title
            Image(systemName: "chevron.down").font(.system(size: 18, weight: .bold)).foregroundStyle(Paper.tone)
          }
        }
        .tint(Paper.ink)
      } else {
        title
      }
      Spacer(minLength: 0)
      StatusLabel(status: session.status)
    }
  }

  private var title: some View {
    Text("Tap \(recipient)")
      .font(Bricolage.extraBold(34))
      .tracking(-1.2)
      .multilineTextAlignment(.leading)
      .foregroundStyle(Paper.ink)
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
            row { TapRow(tap: tap, recipient: recipient, color: session.color, now: context.date) }
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

  private var footer: some View {
    VStack(spacing: 10) {
      Text("Paired as \(session.pairing.senderName)")
      HStack(spacing: 18) {
        Button("Unpair this phone") { confirmUnpair = true }
        Button("Pair with someone else", action: onAdd)
      }
      .underline()
      .foregroundStyle(Paper.ink)
    }
    .font(Bricolage.medium(13, relativeTo: .footnote))
    .foregroundStyle(Paper.tone)
    .frame(maxWidth: .infinity)
    .padding(.top, 8)
  }

  private func send() {
    do {
      try withAnimation(.easeOut(duration: 0.25)) { try session.send(draft) }
      draft = ""
    } catch {
      // The button is disabled for empty drafts and the field caps length.
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
          note: tap.displayedAt == nil ? "Waiting for \(recipient)'s Mac" : "On \(recipient)'s screen now")
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
          Text("Couldn't send")
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
