import AppKit
import ShouldertapCore
import SwiftUI

/// Tapping someone from this Mac, in its own window like Account: the
/// popover is transient, and a draft or a tap in flight shouldn't vanish
/// with it. Mirrors the iPhone composer (apps/ios ComposeView, PairFlow).
@MainActor
final class SendController {
  private let store: SenderStore
  private let account: AccountStore
  private let patron: PatronStore
  private let selection = SendSelection()
  private var window: NSWindow?

  init(store: SenderStore, account: AccountStore, patron: PatronStore) {
    self.store = store
    self.account = account
    self.patron = patron
  }

  /// Tap style, over whoever was last tapped (or the invite form when there's
  /// nobody yet).
  func showStyle() {
    show(personId: selection.person ?? store.sessions.last?.id)
    if !selection.adding { selection.styling = true }
  }

  /// `personId` nil opens the invite form.
  func show(personId: String?) {
    if let personId, store.session(id: personId) != nil {
      selection.person = personId
      selection.adding = false
    } else {
      selection.adding = true
    }
    if window == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
        styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
        backing: .buffered, defer: false)
      window.title = "Tap someone"
      window.titlebarAppearsTransparent = true
      window.isReleasedWhenClosed = false
      window.contentView = NSHostingView(
        rootView: SendView(store: store, account: account, patron: patron, selection: selection))
      window.contentMinSize = NSSize(width: 440, height: 480)
      window.center()
      self.window = window
    }
    store.nudge()
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

@MainActor @Observable
final class SendSelection {
  var person: String?
  var adding = false
  /// The Tap style sheet is up.
  var styling = false
}

/// The sender's color frames the window, like the iPhone and Safari: people
/// you can tap on the frame's top edge, the composer on the page below.
struct SendView: View {
  let store: SenderStore
  let account: AccountStore
  let patron: PatronStore
  let selection: SendSelection
  @State private var pairColor = PersonColor.cobalt

  private var current: SenderSession? {
    selection.person.flatMap(store.session(id:)) ?? store.sessions.last
  }

  private var adding: Bool { selection.adding || current == nil }

  var body: some View {
    let color = adding ? pairColor : current?.color ?? pairColor
    VStack(spacing: 0) {
      people(color: color)
      Group {
        if adding {
          AcceptForm(store: store, account: account, color: $pairColor, canCancel: current != nil) { id in
            selection.person = id ?? selection.person
            selection.adding = false
          }
        } else if let current {
          Composer(session: current, store: store, account: account, patron: patron, selection: selection)
            .id(current.id)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(
        UnevenRoundedRectangle(topLeadingRadius: 14, topTrailingRadius: 14).fill(Color(nsColor: .windowBackgroundColor)))
    }
    .background(color.base)
    .animation(.easeOutExpo(0.5), value: color)
    .frame(minWidth: 440, minHeight: 480)
    .alert(
      store.notice ?? "", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
    ) {
      Button("OK", role: .cancel) {}
    }
  }

  /// Everyone you can tap, as avatars in their colors; Add someone beside them.
  private func people(color: PersonColor) -> some View {
    HStack(spacing: 8) {
      ForEach(store.sessions) { person in
        let selected = !adding && person.id == current?.id
        Button {
          selection.person = person.id
          selection.adding = false
        } label: {
          HStack(spacing: 6) {
            // In the frame's ink: the pairing's color is the frame itself.
            Circle()
              .fill(selected ? color.base : color.ink)
              .frame(width: 22, height: 22)
              .overlay(
                Text(person.pairing.recipientName.prefix(1).uppercased())
                  .font(Bricolage.bold(11))
                  .foregroundStyle(selected ? color.ink : color.base))
            Text(person.pairing.recipientName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
          }
          .padding(.leading, 4)
          .padding(.trailing, 12)
          .padding(.vertical, 4)
          .foregroundStyle(selected ? color.base : color.ink)
          .background(Capsule().fill(selected ? color.ink : .clear))
          .overlay(Capsule().strokeBorder(color.ink.opacity(selected ? 0 : 0.35), lineWidth: 1))
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Tap \(person.pairing.recipientName)")
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
      Button {
        selection.adding = true
      } label: {
        HStack(spacing: 5) {
          IconView(icon: .invite, size: 15)
          Text("Add someone").font(.system(size: 13, weight: .medium))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      .foregroundStyle(color.ink.opacity(adding ? 1 : 0.75))
      Spacer(minLength: 0)
    }
    // Clear of the traffic lights; the frame is the title bar.
    .padding(.leading, 80)
    .padding(.trailing, 14)
    .frame(height: 52)
  }
}

// MARK: Accepting an invite

/// Accept an invite link: who it's from in their color, then Accept. Your
/// name and color come from your profile (docs/onboarding.md, "Invites").
private struct AcceptForm: View {
  let store: SenderStore
  let account: AccountStore
  /// The page's frame: the inviter's color once the link is read.
  @Binding var color: PersonColor
  let canCancel: Bool
  /// nil: cancelled, or done without a new person to select.
  let onDone: (String?) -> Void

  @State private var invite = ""
  @State private var preview: InvitePreview?
  @State private var connected: (name: String, id: String?, mutual: Bool)?
  @State private var pending = false
  @State private var error: String?
  /// Picked for just this person; nil sends `me.sendProfile`.
  @State private var seenAs: Profile?
  @State private var choosing = false

  private var code: String? { inviteCode(from: invite) }
  /// How they'll see you unless you change it: the profile you picked last.
  private var sendDefault: Profile? { account.me?.sendProfile ?? account.me?.profile }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        if let connected {
          VStack(alignment: .leading, spacing: 6) {
            Text("You and \(connected.name) are connected").font(Bricolage.extraBold(28)).tracking(-0.9)
            Text(connected.mutual
              ? "Taps from this Mac reach their screens, and they can tap you too."
              : "Taps from this Mac reach their screens.")
              .font(.system(size: 13)).foregroundStyle(.secondary)
          }
          HStack {
            Spacer()
            Button("Tap \(connected.name)") { onDone(connected.id) }
              .buttonStyle(SenderPill(color: color))
              .keyboardShortcut(.defaultAction)
          }
        } else {
          form
        }
      }
      .padding(24)
    }
    .onAppear {
      // A link just copied from a message is the usual way in.
      if invite.isEmpty, let copied = NSPasteboard.general.string(forType: .string), inviteCode(from: copied) != nil {
        invite = copied.trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
    .task(id: code) { await lookUp() }
  }

  @ViewBuilder private var form: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(preview.map { "\($0.name) invited you" } ?? "Add someone").font(Bricolage.extraBold(28)).tracking(-0.9)
      Text(preview == nil
        ? "Paste the invite link they sent you."
        : "Accept to tap each other. A tap covers their screen until they answer.")
        .font(.system(size: 13)).foregroundStyle(.secondary)
    }

    VStack(alignment: .leading, spacing: 6) {
      Text("Invite link").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
      TextField("https://shouldertap.app/join#…", text: $invite)
        .textFieldStyle(.roundedBorder)
        .onSubmit(accept)
    }

    if let preview {
      SenderPreview(name: preview.name, color: preview.swatchColor)
      if let profile = seenAs ?? sendDefault {
        if choosing {
          SeenAsEditor(
            note: "Only \(preview.name) sees this. Everyone else keeps seeing you as before.",
            saveLabel: "Use for them", initial: profile,
            onCancel: { choosing = false },
            onSave: { picked in
              seenAs = picked
              choosing = false
            })
        } else {
          SeenAsRow(lead: "They'll see you as", profile: profile) { choosing = true }
        }
      }
    }

    if let error { Text(error).font(.system(size: 12)).foregroundStyle(.red) }

    if !choosing {
      HStack {
        if canCancel { Button("Cancel") { onDone(nil) }.keyboardShortcut(.cancelAction) }
        Spacer()
        if pending { ProgressView().controlSize(.small) }
        Button("Accept", action: accept)
          .buttonStyle(SenderPill(color: color))
          .keyboardShortcut(.defaultAction)
          .disabled(pending || code == nil)
      }
    }
  }

  private func lookUp() async {
    preview = nil
    guard let code else {
      error = invite.trimmingCharacters(in: .whitespaces).isEmpty ? nil : "That doesn't look like a Shouldertap invite link."
      return
    }
    error = nil
    do {
      let found = try await account.previewInvite(code: code)
      guard code == self.code else { return }
      preview = found
      color = found.swatchColor
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func accept() {
    guard !pending, let code else { return }
    pending = true
    error = nil
    Task {
      defer { pending = false }
      do {
        let result = try await account.accept(
          code: code, profile: seenAs, platform: .mac, deviceName: Host.current().localizedName ?? "Mac",
          senders: store)
        invite = ""
        if let person = result.person.color { color = person }
        let id =
          result.sender?.grant.credentialId
          ?? store.sessions.first { $0.pairing.recipientName == result.person.name }?.id
        withAnimation(.easeOutExpo(0.5)) { connected = (result.person.name, id, result.mutual) }
      } catch {
        self.error = error.localizedDescription
      }
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
        HStack(spacing: 6) {
          Text("\(index + 1)").font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(.secondary)
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
          .textFieldStyle(.plain)
          .font(.system(size: 13, weight: .medium))
          .accessibilityLabel("Reply option \(index + 1)")
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
      }
    }
  }
}

/// How a tap from you looks on their screen: your color on the frame, your
/// name on its edge, the message on the page.
struct SenderPreview: View {
  let name: String
  let color: PersonColor
  var large = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(name).font(Bricolage.bold(large ? 20 : 13)).foregroundStyle(color.ink)
        .padding(.horizontal, large ? 18 : 12).padding(.vertical, large ? 12 : 7)
      Text("Dinner's ready")
        .font(Bricolage.extraBold(large ? 44 : 26))
        .tracking(large ? -1.6 : -0.8)
        .foregroundStyle(Color(hex: 0x1d1d1f))
        .frame(maxWidth: .infinity, minHeight: large ? 150 : 70, alignment: .leading)
        .padding(.horizontal, large ? 22 : 14)
        .background(RoundedRectangle(cornerRadius: large ? 16 : 8).fill(Color(hex: 0xfbfaf6)))
        .padding([.horizontal, .bottom], large ? 10 : 6)
    }
    .background(RoundedRectangle(cornerRadius: large ? 22 : 12).fill(color.base))
    .animation(.easeOutExpo(0.4), value: color)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Preview of a tap from \(name)")
  }
}

// MARK: Composing

/// Compose and follow taps to one recipient. Mirrors apps/web/src/routes/tap.tsx.
private struct Composer: View {
  let session: SenderSession
  let store: SenderStore
  let account: AccountStore
  let patron: PatronStore
  @Bindable var selection: SendSelection

  @State private var draft = ""
  @State private var editingSelf = false
  /// This tap's answers when changed here; nil follows the account's defaults.
  @State private var replies: [String]?
  @State private var savingReplies = false
  @State private var confirmUnpair = false
  @State private var confirmDelete = false
  @State private var deleting: Tap?
  @State private var error: String?
  @FocusState private var focused: Bool

  private var recipient: String { session.pairing.recipientName }
  private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
  /// The draft in the style previews, or a sample before there is one.
  private var previewMessage: String { trimmed.isEmpty ? "Dinner's ready." : trimmed }
  private var defaultReplies: [String] { account.me?.defaultReplies ?? defaultQuickReplies }
  private var shownReplies: [String] { replies ?? defaultReplies }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Tap \(recipient)").font(Bricolage.extraBold(30)).tracking(-1).lineLimit(1)
          SendStatus(status: session.status)
        }

        VStack(alignment: .trailing, spacing: 10) {
          TextField("What does \(recipient) need to know?", text: $draft, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 15))
            .lineLimit(3...8)
            .focused($focused)
            .onChange(of: draft) { _, value in
              if value.count > maxTapLength { draft = String(value.prefix(maxTapLength)) }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
            .overlay(alignment: .bottomTrailing) {
              if draft.count > maxTapLength - 40 {
                Text("\(maxTapLength - draft.count)").font(.system(size: 12).monospacedDigit())
                  .foregroundStyle(.secondary).padding(8)
              }
            }
          replyOptions
          HStack {
            Text("⌘↩ to send").font(.system(size: 11)).foregroundStyle(.tertiary)
            Spacer()
            Button(action: send) {
              HStack(spacing: 6) {
                IconView(icon: .send, size: 15)
                Text("Send tap")
              }
            }
            .buttonStyle(SenderPill(color: session.color))
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(trimmed.isEmpty || tidyQuickReplies(shownReplies) == nil)
          }
          StyleRow(patron: patron, pairing: session.pairing, message: previewMessage) { selection.styling = true }
        }

        if patron.nudgeDue {
          PatronNudgeCard(patron: patron, color: session.color)
        }

        recent

        footer
      }
      .padding(24)
    }
    .onAppear { focused = true }
    .sheet(isPresented: $selection.styling) {
      StyleSheet(
        patron: patron, pairing: session.pairing, message: previewMessage,
        choose: { try await patron.choose($0, for: session.id, senders: store) }
      ) { selection.styling = false }
    }
    .sheet(isPresented: $editingSelf) {
      SeenAsEditor(
        note: "Only \(recipient) sees this. It changes your taps they already have too.",
        saveLabel: "Save", initial: Profile(name: session.pairing.senderName, color: session.color),
        onCancel: { editingSelf = false },
        onSave: { profile in
          try await account.updateSendProfile(session.id, name: profile.name, color: profile.color, senders: store)
          editingSelf = false
        }
      )
      .padding(24)
      .frame(width: 380)
    }
    .confirmationDialog("Stop tapping \(recipient)?", isPresented: $confirmUnpair, titleVisibility: .visible) {
      Button("Remove", role: .destructive) {
        Task {
          do { try await account.remove(session.id, senders: store) } catch { store.notice = error.localizedDescription }
        }
      }
    } message: {
      Text("Your taps stop reaching \(recipient), from all your devices. To tap them again, you'll need a new invite.")
    }
    .confirmationDialog("Delete your data with \(recipient)?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete everything", role: .destructive) { deleteData() }
    } message: {
      Text("Removes your taps, their answers and this pairing from \(recipient)'s inbox, for good.")
    }
    .confirmationDialog(
      "Delete this tap?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible, presenting: deleting
    ) { tap in
      Button("Delete", role: .destructive) { delete(tap) }
    } message: { tap in
      Text(
        tap.state == .pending
          ? "It's taken back from \(recipient)'s screens before they answer, and removed for both of you."
          : "It's removed for both of you, along with \(recipient)'s answer.")
    }
  }

  /// The two answers this tap offers, editable for it alone.
  private var replyOptions: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("\(recipient) can answer").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
      QuickReplyFields(replies: Binding(get: { shownReplies }, set: { replies = $0 }))
      if case .failure(let problem) = normalizeQuickReplies(shownReplies) {
        Text(problem.localizedDescription).font(.system(size: 12)).foregroundStyle(.red)
      } else if let chosen = tidyQuickReplies(shownReplies), chosen != defaultReplies {
        HStack(spacing: 12) {
          if account.me != nil {
            Button("Use these for every tap") {
              savingReplies = true
              Task {
                if await account.saveQuickReplies(chosen) { replies = nil }
                savingReplies = false
              }
            }
            .disabled(savingReplies)
          }
          Button("Reset") { replies = nil }
        }
        .buttonStyle(.link)
        .font(.system(size: 12))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var recent: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Recent").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).padding(.bottom, 4)
      TimelineView(.periodic(from: .now, by: 15)) { context in
        VStack(alignment: .leading, spacing: 0) {
          ForEach(session.outbox) { item in
            row { OutboxRow(item: item, session: session) }
          }
          ForEach(session.taps) { tap in
            row {
              SentTapRow(tap: tap, recipient: recipient, color: session.color, now: context.date) { deleting = tap }
                .contextMenu {
                  Button("Delete…", role: .destructive) { deleting = tap }
                  Link("Report this tap or reply", destination: reportURL(tap))
                }
            }
          }
        }
      }
      if session.loaded && session.taps.isEmpty && session.outbox.isEmpty {
        Text("Nothing sent yet. Your taps and \(recipient)'s answers show up here.")
          .font(.system(size: 13)).foregroundStyle(.secondary).padding(.top, 6)
      }
      if let error { Text(error).font(.system(size: 12)).foregroundStyle(.red).padding(.top, 6) }
    }
  }

  private var footer: some View {
    HStack(spacing: 4) {
      Text("You're \(session.pairing.senderName) on \(recipient)'s devices.")
      Spacer(minLength: 8)
      Menu("Options") {
        Button("How they see you") { editingSelf = true }
        Button("Remove \(recipient)…") { confirmUnpair = true }
        Button("Delete my data with \(recipient)…") { confirmDelete = true }
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
    }
    .font(.system(size: 12))
    .foregroundStyle(.secondary)
  }

  private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(spacing: 0) {
      content().padding(.vertical, 12)
      Divider()
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }

  private func send() {
    do {
      try withAnimation(.easeOutExpo(0.5)) { try session.send(draft, replies: shownReplies) }
      draft = ""
      replies = nil
    } catch {
      // The button is disabled for empty drafts and the field caps length.
    }
  }

  private func delete(_ tap: Tap) {
    error = nil
    Task {
      do { try await session.delete(tapId: tap.id) } catch { self.error = error.localizedDescription }
    }
  }

  private func deleteData() {
    error = nil
    Task {
      do { try await store.deleteData(id: session.id) } catch { self.error = error.localizedDescription }
    }
  }

  private func reportURL(_ tap: Tap) -> URL {
    var url = URLComponents()
    url.scheme = "mailto"
    url.path = "support@shouldertap.app"
    url.queryItems = [
      URLQueryItem(name: "subject", value: "Shouldertap abuse report"),
      URLQueryItem(
        name: "body",
        value:
          "Tap ID: \(tap.id)\nPairing ID: \(session.id)\n\nDescribe the problem here. Include only information you want to share with support."
      ),
    ]
    return url.url!
  }
}

private struct SentTapRow: View {
  let tap: Tap
  let recipient: String
  let color: PersonColor
  let now: Date
  let onDelete: () -> Void
  @State private var hovered = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(tap.body).font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading)
        Text(ago(tap.createdAt, now: now)).font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
        Button(action: onDelete) { IconView(icon: .remove, size: 14) }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .opacity(hovered ? 1 : 0)
          .help("Delete for everyone")
          .accessibilityLabel("Delete this tap")
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
    .contentShape(Rectangle())
    .onHover { hovered = $0 }
  }
}

private struct OutboxRow: View {
  let item: OutgoingTap
  let session: SenderSession

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(item.body).font(.system(size: 15, weight: .semibold))
      if item.failed {
        HStack(spacing: 8) {
          Text(item.error ?? "Couldn't send").font(.system(size: 12, weight: .medium)).foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
          Button("Discard") { session.discard(requestId: item.requestId) }
          Button("Try again") { session.retry(requestId: item.requestId) }
            .buttonStyle(SenderPill(color: session.color, small: true))
        }
      } else {
        Track(reached: 0, color: session.color, note: "Sending")
      }
    }
  }
}

/// Three segments in the sender's color: Sent, On screen, Answered. The
/// current step pulses (never with Reduce Motion).
private struct Track: View {
  let reached: Int
  let color: PersonColor
  let note: String
  @State private var pulse = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let steps = ["Sent", "On screen", "Answered"]

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { step in
          Capsule()
            .fill(step <= reached ? color.base : Color(nsColor: .quaternaryLabelColor))
            .opacity(step == reached && pulse ? 0.35 : 1)
            .frame(height: 4)
        }
      }
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { step in
          Text(Self.steps[step])
            .foregroundStyle(step == reached - 1 ? .primary : .secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .font(.system(size: 11, weight: .semibold))
    }
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 0.8).repeatForever()) { pulse = true }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(note)
  }
}

/// The answer card: icon, answer, how long it took and on which device.
private struct Answer: View {
  let response: TapResponse
  let createdAt: Timestamp
  let acknowledgedAt: Timestamp
  let by: String?

  var body: some View {
    HStack(spacing: 10) {
      IconView(icon: response.icon, size: 17)
      Text(response.label).font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading)
      VStack(alignment: .trailing, spacing: 0) {
        Text("\(duration(from: createdAt, to: acknowledgedAt)) later")
        if let by { Text("on \(by)") }
      }
      .font(.system(size: 11).monospacedDigit())
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.5)))
    .accessibilityElement(children: .combine)
  }
}

struct SendStatus: View {
  let status: LiveStatus

  var body: some View {
    let (label, color): (String, Color) =
      switch status {
      case .live: ("Live", liveGreen)
      case .connecting: ("Connecting…", .orange)
      case .offline: ("Offline", Color(nsColor: .tertiaryLabelColor))
      }
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(label).font(.system(size: 12)).foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A person: a circle in their color with their initial in its ink.
struct SendAvatar: View {
  let name: String
  let color: PersonColor
  var size: CGFloat = 26

  var body: some View {
    Circle()
      .fill(color.base)
      .frame(width: size, height: size)
      .overlay(
        Text(name.trimmingCharacters(in: .whitespaces).prefix(1).uppercased())
          .font(Bricolage.bold(size * 0.46))
          .foregroundStyle(color.ink)
      )
      .overlay(Circle().strokeBorder(color.ink.opacity(0.25), lineWidth: 1))
      .accessibilityHidden(true)
  }
}

/// A pill in the sender's color with its ink.
private struct SenderPill: ButtonStyle {
  let color: PersonColor
  var small = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: small ? 12 : 13, weight: .semibold))
      .foregroundStyle(color.ink)
      .padding(.horizontal, small ? 10 : 16)
      .frame(minHeight: small ? 24 : 32)
      .background(Capsule().fill(color.base))
      .contentShape(Capsule())
      .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
  }
}

/// One line on where a sent tap stands, for the popover.
@MainActor func latestSummary(_ session: SenderSession, now: Date = .now) -> String {
  if let failed = session.outbox.first(where: \.failed) { return failed.error ?? "Couldn't send" }
  if !session.outbox.isEmpty { return "Sending…" }
  guard let tap = session.taps.first else { return session.loaded ? "Nothing sent yet" : "Paired" }
  if let response = tap.response, tap.state == .acknowledged { return "\(response.label) · \(ago(tap.createdAt, now: now))" }
  return tap.displayedAt == nil ? "Sent \(ago(tap.createdAt, now: now))" : "On their screen · \(ago(tap.createdAt, now: now))"
}

// MARK: How they see you

/// "{lead} ● {name} · Change": how one person will see you, before accepting.
private struct SeenAsRow: View {
  let lead: String
  let profile: Profile
  let onChange: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(profile.color.base).frame(width: 10, height: 10)
      Text("\(lead) \(Text(profile.name).bold())")
      Button("Change", action: onChange).buttonStyle(.link)
    }
    .font(.system(size: 13))
    .foregroundStyle(.secondary)
  }
}

/// A name and color for one person only (docs/onboarding.md, "Change how
/// one person sees you"). Mirrors apps/web/src/components/seen-as.tsx.
private struct SeenAsEditor: View {
  let note: String
  let saveLabel: String
  let onCancel: () -> Void
  let onSave: (Profile) async throws -> Void

  @State private var name: String
  @State private var color: PersonColor
  @State private var pending = false
  @State private var error: String?

  init(
    note: String, saveLabel: String, initial: Profile, onCancel: @escaping () -> Void,
    onSave: @escaping (Profile) async throws -> Void
  ) {
    self.note = note
    self.saveLabel = saveLabel
    self.onCancel = onCancel
    self.onSave = onSave
    _name = State(initialValue: initial.name)
    _color = State(initialValue: initial.color)
  }

  private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text("How they see you").font(Bricolage.extraBold(22)).tracking(-0.6)
        Text(note).font(.system(size: 13)).foregroundStyle(.secondary)
      }
      TextField("Your name", text: $name)
        .textFieldStyle(.roundedBorder)
        .onSubmit(save)
        .onChange(of: name) { _, value in
          if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
        }
      ColorGrid(selection: $color)
      SenderPreview(name: trimmed.isEmpty ? "You" : trimmed, color: color)
      if let error { Text(error).font(.system(size: 12)).foregroundStyle(.red) }
      HStack {
        Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
        Spacer()
        if pending { ProgressView().controlSize(.small) }
        Button(saveLabel, action: save)
          .buttonStyle(SenderPill(color: color))
          .keyboardShortcut(.defaultAction)
          .disabled(pending || trimmed.isEmpty)
      }
    }
  }

  private func save() {
    guard !pending, !trimmed.isEmpty else { return }
    pending = true
    error = nil
    let picked = Profile(name: trimmed, color: color)
    Task {
      defer { pending = false }
      do { try await onSave(picked) } catch { self.error = error.localizedDescription }
    }
  }
}
