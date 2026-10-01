import ShouldertapCore
import SwiftUI

/// A screen in the pairing flow after the first.
enum PairStep: Hashable {
  case mac
  case invite
  case profile(invite: String)
  case paired(id: String)

  /// Where it sits on the step track: the Mac app, the invite, you.
  var track: Int? {
    switch self {
    case .mac: 0
    case .invite: 1
    case .profile: 2
    case .paired: nil
    }
  }
}

/// Pairing this phone with someone's Mac, one step per screen. The first run
/// starts with a welcome and walks through getting the Mac app; adding
/// someone later starts at the invite. An invite link opened from outside
/// jumps straight to name and color.
///
/// Navigation sits on the frame's top edge: back, the step track, close.
/// Screens slide across the page; once paired, the page drops away and the
/// whole screen is your color. The color it picks is the frame's, so the
/// caller owns the `Frame`.
struct PairFlow: View {
  let store: SenderStore
  let firstRun: Bool
  @Binding var color: PersonColor
  var onCancel: (() -> Void)?
  let onDone: (String) -> Void

  @State private var path: [PairStep]
  @State private var forward = true
  @State private var knock = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    store: SenderStore, invite: String = "", firstRun: Bool, color: Binding<PersonColor>,
    onCancel: (() -> Void)? = nil, onDone: @escaping (String) -> Void
  ) {
    self.store = store
    self.firstRun = firstRun
    _color = color
    self.onCancel = onCancel
    self.onDone = onDone
    _path = State(initialValue: inviteCode(from: invite) == nil ? [] : [.profile(invite: invite)])
  }

  /// The screen showing; nil is the first one (welcome, or the invite).
  private var current: PairStep? { path.last }

  private var paired: SenderSession? {
    guard case .paired(let id)? = current else { return nil }
    return store.session(id: id)
  }

  var body: some View {
    ZStack {
      if let paired {
        PairedStep(session: paired) { onDone(paired.id) }
          .transition(.opacity.animation(.easeOut(duration: 0.4).delay(0.25)))
      } else {
        VStack(spacing: 0) {
          bar
          ZStack {
            screen
              .id(current)
              .transition(reduceMotion ? .opacity : .step(forward: forward))
          }
          .onPaper()
        }
        .transition(
          reduceMotion
            ? .opacity
            : .asymmetric(insertion: .opacity, removal: .move(edge: .bottom).combined(with: .opacity)))
      }
    }
  }

  private var bar: some View {
    FrameBar {
      if path.isEmpty {
        Wordmark(knock: knock)
      } else {
        BackButton { go(forward: false) { path.removeLast() } }
      }
    } trailing: {
      if let step = current?.track ?? (firstRun ? nil : PairStep.invite.track) {
        StepTrack(step: step)
      }
      if path.isEmpty && firstRun {
        Button("I have an invite") { go { path.append(.invite) } }
          .buttonStyle(FrameButtonStyle())
          .accessibilityIdentifier("welcome-invite")
      }
      if let onCancel {
        Button(action: onCancel) { IconView(icon: .close, size: 18) }
          .buttonStyle(FrameButtonStyle(iconOnly: true))
          .accessibilityLabel("Close")
          .accessibilityIdentifier("close-button")
      }
    }
  }

  @ViewBuilder private var screen: some View {
    switch current {
    case nil:
      if firstRun {
        WelcomeStep(color: $color, knock: $knock) { go { path.append(.mac) } }
      } else {
        InviteStep(color: color, onInvite: { code in go { path.append(.profile(invite: code)) } }) {
          go { path.append(.mac) }
        }
      }
    case .mac:
      MacStep(color: color, firstRun: firstRun) {
        if firstRun { go { path.append(.invite) } } else { go(forward: false) { path.removeLast() } }
      }
    case .invite:
      InviteStep(color: color, onInvite: { code in go { path.append(.profile(invite: code)) } })
    case .profile(let invite):
      ProfileStep(store: store, invite: invite, color: $color) { session in
        withAnimation(.outExpo(0.8)) { path.append(.paired(id: session.id)) }
      }
    case .paired:
      EmptyView()
    }
  }

  /// Set the direction first, so the leaving screen slides the right way,
  /// then move on the next turn of the run loop.
  private func go(forward: Bool = true, _ change: @escaping () -> Void) {
    self.forward = forward
    Task { withAnimation(.outExpo(0.55)) { change() } }
  }
}

/// Three short segments on the frame, like the tap progress track: where
/// you are in getting the Mac app, the invite, and your name and color.
private struct StepTrack: View {
  let step: Int

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { index in
        Capsule()
          .opacity(index <= step ? 1 : 0.28)
          .frame(width: index == step ? 22 : 12, height: 5)
      }
    }
    .padding(.horizontal, 6)
    .animation(.spring(duration: 0.45, bounce: 0.3), value: step)
    .accessibilityElement()
    .accessibilityLabel("Step \(step + 1) of 3")
  }
}

/// Adding someone later: the flow in its own frame, over the composer.
struct PairCover: View {
  let store: SenderStore
  let invite: String
  let onCancel: () -> Void
  let onDone: (String) -> Void

  @State private var color: PersonColor

  init(store: SenderStore, invite: String, onCancel: @escaping () -> Void, onDone: @escaping (String) -> Void) {
    self.store = store
    self.invite = invite
    self.onCancel = onCancel
    self.onDone = onDone
    _color = State(initialValue: store.sessions.last?.color ?? .cobalt)
  }

  var body: some View {
    Frame(color: color) {
      PairFlow(store: store, invite: invite, firstRun: false, color: $color, onCancel: onCancel, onDone: onDone)
    }
  }
}

// MARK: Welcome

/// The first screen: what Shouldertap does, with a live-looking tap cycling
/// through people and their colors like the landing page. Each new tap
/// floods the frame with its color and knocks the wordmark.
private struct WelcomeStep: View {
  @Binding var color: PersonColor
  @Binding var knock: Int
  let onStart: () -> Void

  @State private var sample = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let samples: [(name: String, color: PersonColor, message: String)] = [
    ("Mom", .cobalt, "Dinner's ready"),
    ("Sam", .tomato, "Can you get the door?"),
    ("Ari", .moss, "Call me when you're free"),
    ("Jo", .plum, "Leaving in 5"),
  ]

  var body: some View {
    let current = Self.samples[sample]
    Page {
      VStack(alignment: .leading, spacing: 14) {
        Text("Welcome to Shouldertap")
          .font(Bricolage.extraBold(42))
          .tracking(-1.5)
          .fixedSize(horizontal: false, vertical: true)
          .arrive()
        Text("Tap someone on the shoulder from your iPhone. Your message covers their Mac screen until they answer.")
          .font(Bricolage.medium(17))
          .foregroundStyle(Paper.tone)
          .arrive(after: 0.08)
      }
      .padding(.top, 16)

      TapPreview(name: current.name, color: current.color, message: current.message, replies: true)
        .arrive(after: 0.2)

      VStack(alignment: .leading, spacing: 18) {
        Feature(icon: .mac, title: "Hard to miss", text: "It covers every screen on their Mac, even full-screen apps.")
          .arrive(after: 0.32)
        Feature(icon: .onIt, title: "Answered in a click", text: "They reply On it, In 10 min, or a few words.")
          .arrive(after: 0.4)
        Feature(icon: .send, title: "See it land", text: "Follow each tap from sent to on screen to answered.")
          .arrive(after: 0.48)
      }
    } actions: {
      Button("Get started", action: onStart)
        .buttonStyle(PillStyle(color: color))
        .accessibilityIdentifier("welcome-start")
        .arrive(after: 0.56)
    }
    .onAppear { color = current.color }
    .task {
      // The first knock once the screen has settled.
      guard (try? await Task.sleep(for: .seconds(0.7))) != nil else { return }
      knock += 1
      guard !reduceMotion else { return }
      while (try? await Task.sleep(for: .seconds(3.2))) != nil {
        withAnimation(.outExpo(0.7)) {
          sample = (sample + 1) % Self.samples.count
          color = Self.samples[sample].color
        }
        knock += 1
      }
    }
  }
}

private struct Feature: View {
  let icon: Icon
  let title: String
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      IconView(icon: icon, size: 22)
        .frame(width: 44, height: 44)
        .background(Paper.faint, in: .circle)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(Bricolage.bold(17))
        Text(text).font(Bricolage.medium(15)).foregroundStyle(Paper.tone)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: The Mac app

/// The person being tapped needs Shouldertap on their Mac first. Send them
/// the download page (AirDrop goes straight to the Mac).
private struct MacStep: View {
  let color: PersonColor
  let firstRun: Bool
  let onNext: () -> Void

  @State private var copied = false

  var body: some View {
    Page {
      StepHeader(
        title: "Get Shouldertap on their Mac",
        text: "It lives in the menu bar of the Mac you want to tap. To try it yourself, put it on your own Mac.")

      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 12) {
          IconView(icon: .mac, size: 26)
            .frame(width: 48, height: 48)
            .background(Paper.paper, in: .rect(cornerRadius: 12, style: .continuous))
          VStack(alignment: .leading, spacing: 2) {
            Text("Shouldertap for Mac").font(Bricolage.bold(17))
            Text("Free for 7 days, then $5 once").font(Bricolage.medium(14)).foregroundStyle(Paper.tone)
          }
        }
        VStack(alignment: .leading, spacing: 4) {
          Text("On their Mac, go to")
            .font(Bricolage.medium(15))
            .foregroundStyle(Paper.tone)
          Text("shouldertap.app/download")
            .font(Bricolage.extraBold(24))
            .tracking(-0.6)
            .textSelection(.enabled)
        }
        HStack(spacing: 10) {
          ShareLink(
            item: Config.macDownloadPage,
            message: Text("Install Shouldertap on your Mac so I can tap you.")
          ) {
            Label("Send link", systemImage: "square.and.arrow.up")
          }
          .buttonStyle(PillStyle(color: color, small: true))
          .accessibilityIdentifier("share-download")
          Button {
            UIPasteboard.general.url = Config.macDownloadPage
            copied = true
          } label: {
            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
          }
          .buttonStyle(PillStyle(small: true))
          .sensoryFeedback(.success, trigger: copied)
        }
        Text("AirDrop the link straight to the Mac, or text it to them.")
          .font(Bricolage.medium(14))
          .foregroundStyle(Paper.tone)
      }
      .padding(18)
      .background(Paper.faint, in: .rect(cornerRadius: 20, style: .continuous))

      NumberedSteps(color: color, steps: [
        "Open Shouldertap.dmg and drag Shouldertap into Applications.",
        "Open Shouldertap. Its mark appears in the menu bar, at the top right of the screen.",
      ])
    } actions: {
      Button(firstRun ? "It's on their Mac" : "Done", action: onNext)
        .buttonStyle(PillStyle(color: color))
        .accessibilityIdentifier("mac-next")
    }
  }
}

// MARK: The invite

/// Where the invite comes from on the Mac, then scan it (or paste the link
/// they sent).
private struct InviteStep: View {
  let color: PersonColor
  let onInvite: (String) -> Void
  var onNeedsMac: (() -> Void)?

  @State private var text = ""
  @State private var scanning = false
  @State private var scanned: String?
  @State private var demo = MacDemo.rest
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var code: String? { inviteCode(from: text) }

  var body: some View {
    Page {
      StepHeader(
        title: "Get an invite from their Mac",
        text: "Each invite pairs this phone with one person, on all of their Macs.")

      MenuBarIllustration(color: color, phase: demo)

      NumberedSteps(color: color, active: demo.step, steps: [
        "Click the Shouldertap mark in their Mac's menu bar.",
        "Click Invite someone. A QR code appears.",
        "Scan it with this phone.",
      ])

      VStack(alignment: .leading, spacing: 8) {
        Text("Or paste the link they sent you").font(Bricolage.bold(14, relativeTo: .subheadline))
        HStack(spacing: 8) {
          TextField("shouldertap.app/join#…", text: $text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .submitLabel(.continue)
            .onSubmit { if code != nil { onInvite(text) } }
            .accessibilityIdentifier("invite-field")
            .field()
          PasteButton(payloadType: String.self) { strings in
            guard let first = strings.first else { return }
            text = first
            if inviteCode(from: first) != nil { onInvite(first) }
          }
          .labelStyle(.iconOnly)
          .buttonBorderShape(.capsule)
          .tint(color.base)
        }
        if !text.isEmpty && code == nil {
          Text("That doesn't look like a Shouldertap invite link.")
            .font(Bricolage.medium(14)).foregroundStyle(.red)
        }
      }
    } actions: {
      if code != nil {
        Button("Continue") { onInvite(text) }
          .buttonStyle(PillStyle(color: color))
          .accessibilityIdentifier("invite-continue")
      } else {
        Button {
          scanning = true
        } label: {
          Label("Scan QR code", systemImage: "qrcode.viewfinder")
        }
        .buttonStyle(PillStyle(color: color))
        .accessibilityIdentifier("scan-button")
      }
      if let onNeedsMac {
        Button("They don't have the Mac app yet", action: onNeedsMac)
          .buttonStyle(QuietStyle())
      }
    }
    .task {
      if reduceMotion {
        demo = .toInvite
        return
      }
      let script: [(MacDemo, Animation, Double)] = [
        (.rest, .easeInOut(duration: 0.5), 0.9),
        (.toMark, .easeInOut(duration: 0.75), 0.95),
        (.open, .spring(duration: 0.35, bounce: 0.2), 0.8),
        (.toInvite, .easeInOut(duration: 0.6), 0.75),
        (.press, .easeOut(duration: 0.12), 0.3),
        (.qr, .spring(duration: 0.4, bounce: 0.15), 2.6),
      ]
      while !Task.isCancelled {
        for (phase, animation, hold) in script {
          withAnimation(animation) { demo = phase }
          guard (try? await Task.sleep(for: .seconds(hold))) != nil else { return }
        }
      }
    }
    .fullScreenCover(
      isPresented: $scanning,
      onDismiss: {
        if let scanned { onInvite(scanned) }
        scanned = nil
      }
    ) {
      ScanScreen(color: color) { value in
        scanned = value
        scanning = false
      }
    }
  }
}

/// The camera, over everything in your frame. Takes only invite links
/// (https://shouldertap.app/join#… or shouldertap://join#…); any other QR
/// code keeps it scanning.
private struct ScanScreen: View {
  let color: PersonColor
  let onInvite: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Frame(color: color) {
      VStack(spacing: 0) {
        FrameBar {
          Text("Scan their invite").font(Bricolage.extraBold(19)).tracking(-0.6)
        } trailing: {
          Button { dismiss() } label: { IconView(icon: .close, size: 18) }
            .buttonStyle(FrameButtonStyle(iconOnly: true))
            .accessibilityLabel("Close")
            .accessibilityIdentifier("scan-cancel")
        }
        VStack(alignment: .leading, spacing: 16) {
          QRScanner { value in
            guard let url = URL(string: value), url.path == "/join" || url.host == "join",
              inviteCode(from: value) != nil
            else { return false }
            onInvite(value)
            return true
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 22)
        .padding(.top, 22)
        .onPaper()
      }
    }
  }
}

/// A loop of what to do on the Mac: the cursor clicks the mark in the menu
/// bar, the menu opens (as on apps/macos MenuView), Invite someone, and the
/// QR code appears.
enum MacDemo: Int {
  case rest, toMark, open, toInvite, press, qr

  /// Which numbered step it shows.
  var step: Int {
    switch self {
    case .rest, .toMark: 0
    case .open, .toInvite, .press: 1
    case .qr: 2
    }
  }
}

private struct DemoAnchors: PreferenceKey {
  static let defaultValue: [String: Anchor<CGRect>] = [:]
  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue()) { $1 }
  }
}

private struct MenuBarIllustration: View {
  let color: PersonColor
  let phase: MacDemo

  private var open: Bool { phase.rawValue >= MacDemo.open.rawValue }

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      HStack(spacing: 14) {
        Spacer()
        MarkView(size: 20, knock: open ? 1 : 0)
          .foregroundStyle(open ? Paper.paper : Paper.ink)
          .padding(.horizontal, 6)
          .padding(.vertical, 3)
          .background(open ? Paper.ink : .clear, in: .rect(cornerRadius: 5, style: .continuous))
          .anchorPreference(key: DemoAnchors.self, value: .bounds) { ["mark": $0] }
        Image(systemName: "wifi")
        Image(systemName: "battery.75percent")
        Text("9:41").font(Bricolage.bold(13).monospacedDigit())
      }
      .font(.system(size: 13, weight: .semibold))
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(Paper.line)

      ZStack(alignment: .topTrailing) {
        if open {
          menu
            .transition(.scale(scale: 0.92, anchor: .top).combined(with: .opacity))
        }
      }
      .frame(maxWidth: .infinity, minHeight: 156, alignment: .topTrailing)
      .padding(.trailing, 64)
      .padding(.bottom, 14)
    }
    .foregroundStyle(Paper.ink)
    .background(Paper.faint)
    .overlayPreferenceValue(DemoAnchors.self) { anchors in
      GeometryReader { proxy in
        Cursor(pressed: phase == .press || phase == .open)
          .position(cursor(in: proxy, anchors: anchors))
      }
    }
    .clipShape(.rect(cornerRadius: 20, style: .continuous))
    .accessibilityElement()
    .accessibilityLabel("The Shouldertap menu open in the Mac's menu bar, with Invite someone at the top")
  }

  private var menu: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        MarkView(size: 16)
        Text("Shouldertap").font(Bricolage.extraBold(14)).tracking(-0.4)
      }
      if phase == .qr {
        VStack(spacing: 6) {
          Image(systemName: "qrcode")
            .font(.system(size: 66, weight: .regular))
            .padding(6)
            .background(.white, in: .rect(cornerRadius: 6))
            .foregroundStyle(.black)
          Text("Scan with their iPhone").font(.system(size: 10, weight: .medium)).foregroundStyle(Paper.tone)
        }
        .frame(maxWidth: .infinity)
        .transition(.scale(scale: 0.85).combined(with: .opacity))
      } else {
        HStack(spacing: 6) {
          IconView(icon: .invite, size: 14)
          Text("Invite someone").font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(Paper.paper)
        .frame(maxWidth: .infinity, minHeight: 28)
        .background(Paper.ink, in: .rect(cornerRadius: 7, style: .continuous))
        .scaleEffect(phase == .press ? 0.95 : 1)
        .anchorPreference(key: DemoAnchors.self, value: .bounds) { ["invite": $0] }
        VStack(alignment: .leading, spacing: 5) {
          Text("Can tap you").font(.system(size: 10, weight: .semibold)).foregroundStyle(Paper.tone)
          HStack(spacing: 4) {
            ForEach([PersonColor.tomato, .moss, .plum], id: \.self) { Circle().fill($0.base).frame(width: 14, height: 14) }
          }
        }
      }
    }
    .padding(12)
    .frame(width: 180)
    .background(Paper.paper, in: .rect(cornerRadius: 12, style: .continuous))
    .shadow(color: .black.opacity(0.14), radius: 12, y: 5)
  }

  private func cursor(in proxy: GeometryProxy, anchors: [String: Anchor<CGRect>]) -> CGPoint {
    let rest = CGPoint(x: proxy.size.width * 0.32, y: proxy.size.height * 0.62)
    func point(_ key: String, dx: CGFloat, dy: CGFloat) -> CGPoint {
      guard let anchor = anchors[key] else { return rest }
      let rect = proxy[anchor]
      return CGPoint(x: rect.midX + dx, y: rect.midY + dy)
    }
    switch phase {
    case .rest, .qr: return rest
    case .toMark, .open: return point("mark", dx: 4, dy: 8)
    case .toInvite, .press: return point("invite", dx: 30, dy: 8)
    }
  }
}

/// The macOS arrow, with a quick squeeze when it clicks.
private struct Cursor: View {
  let pressed: Bool

  var body: some View {
    Image(systemName: "cursorarrow")
      .font(.system(size: 20))
      .foregroundStyle(.black)
      .background(Image(systemName: "cursorarrow").font(.system(size: 23)).foregroundStyle(.white))
      .scaleEffect(pressed ? 0.88 : 1, anchor: .topLeading)
      .offset(x: 6, y: 9)
      .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
  }
}

// MARK: Name and color

/// Redeem the invite: your name and the color that frames your taps on their
/// Mac. Mirrors apps/web/src/routes/join.tsx.
private struct ProfileStep: View {
  let store: SenderStore
  let invite: String
  @Binding var color: PersonColor
  let onPaired: (SenderSession) -> Void

  @State private var name: String
  @State private var pending = false
  @State private var error: String?
  @FocusState private var nameFocused: Bool

  init(store: SenderStore, invite: String, color: Binding<PersonColor>, onPaired: @escaping (SenderSession) -> Void) {
    self.store = store
    self.invite = invite
    _color = color
    self.onPaired = onPaired
    // Pairing with another person reuses the name you gave the first.
    _name = State(initialValue: store.sessions.last?.pairing.senderName ?? "")
  }

  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var canSubmit: Bool { !trimmedName.isEmpty && !pending }

  var body: some View {
    Page {
      StepHeader(title: "You're invited", text: "Choose how your taps look on their Mac.")

      VStack(alignment: .leading, spacing: 8) {
        Text("Your name").font(Bricolage.bold(14, relativeTo: .subheadline))
        TextField("e.g. Sam", text: $name)
          .textContentType(.givenName)
          .submitLabel(.done)
          .focused($nameFocused)
          .onChange(of: name) { _, value in
            if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
          }
          .accessibilityIdentifier("name-field")
          .field()
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Your color").font(Bricolage.bold(14, relativeTo: .subheadline))
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 10) {
          ForEach(PersonColor.allCases, id: \.self) { option in
            Button {
              withAnimation(.easeInOut(duration: 0.3)) { color = option }
            } label: {
              Circle()
                .fill(option.base)
                .overlay {
                  if option == color {
                    IconView(icon: .onIt, size: 22).foregroundStyle(option.ink)
                  }
                }
                .overlay(Circle().strokeBorder(Paper.ink.opacity(option == color ? 0.9 : 0), lineWidth: 2).padding(-4))
                .frame(height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(option.label)
            .accessibilityAddTraits(option == color ? .isSelected : [])
            .accessibilityIdentifier("color-\(option.rawValue)")
          }
        }
        .sensoryFeedback(.selection, trigger: color)
        Text("Frames your taps on their screen, so they know it's you from across the room.")
          .font(Bricolage.medium(14)).foregroundStyle(Paper.tone)
      }

      TapPreview(name: trimmedName.isEmpty ? "You" : trimmedName, color: color, message: "Dinner's ready")

      if let error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }
    } actions: {
      Button {
        Task { await pair() }
      } label: {
        if pending { ProgressView().tint(color.ink) } else { Text("Pair") }
      }
      .buttonStyle(PillStyle(color: color))
      .disabled(!canSubmit)
      .accessibilityIdentifier("pair-button")
    }
    .onAppear { if name.isEmpty { nameFocused = true } }
  }

  private func pair() async {
    nameFocused = false
    pending = true
    error = nil
    defer { pending = false }
    do {
      onPaired(try await store.pair(invite: invite, name: trimmedName, color: color))
    } catch let failure as APIError where failure.code != .network {
      error = failure.message
    } catch let failure as APIError {
      error = failure.errorDescription
    } catch {
      self.error = error.localizedDescription
    }
  }
}

// MARK: Paired

/// The page has dropped away and the whole screen is your color, the way
/// your taps will cover their Mac. The mark lands big and knocks twice
/// (with a haptic per knock), then keeps knocking now and then.
private struct PairedStep: View {
  let session: SenderSession
  let onDone: () -> Void

  @State private var shown = false
  @State private var knock = 0
  @State private var thud = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var recipient: String { session.pairing.recipientName }

  var body: some View {
    let color = session.color
    VStack(spacing: 0) {
      Spacer(minLength: 24)
      MarkView(size: 148, knock: knock)
        .scaleEffect(shown || reduceMotion ? 1 : 0.4)
        .rotationEffect(.degrees(shown || reduceMotion ? 0 : -14))
        .opacity(shown ? 1 : 0)
      VStack(spacing: 12) {
        Text("You can tap \(recipient) now")
          .font(Bricolage.extraBold(44))
          .tracking(-1.8)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Text("Your taps cover \(recipient)'s Mac screens in \(color.label.lowercased()), until they answer.")
          .font(Bricolage.medium(17))
          .multilineTextAlignment(.center)
          .opacity(0.78)
      }
      .padding(.top, 36)
      .arrive(after: 1.0)
      Spacer(minLength: 24)
      Button("Send your first tap", action: onDone)
        .buttonStyle(PillStyle(color: color, inverted: true))
        .accessibilityIdentifier("paired-done")
        .arrive(after: 1.3)
    }
    .foregroundStyle(color.ink)
    .padding(.horizontal, 28)
    .padding(.bottom, 12)
    .sensoryFeedback(.impact(weight: .heavy, intensity: 0.9), trigger: thud)
    .task {
      guard (try? await Task.sleep(for: .seconds(0.25))) != nil else { return }
      withAnimation(.spring(duration: 0.6, bounce: 0.45)) { shown = true }
      guard (try? await Task.sleep(for: .seconds(0.35))) != nil else { return }
      // Knock, knock: the mark pops twice; a thud lands with each.
      knock += 1
      thud += 1
      guard (try? await Task.sleep(for: .seconds(0.45))) != nil else { return }
      thud += 1
      while (try? await Task.sleep(for: .seconds(3.5))) != nil {
        knock += 1
      }
    }
  }
}

// MARK: Pieces

private struct StepHeader: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(Bricolage.extraBold(34))
        .tracking(-1.2)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      Text(text)
        .font(Bricolage.medium(17))
        .foregroundStyle(Paper.tone)
    }
  }
}

/// Numbered instructions, the number in a circle of the sender's color.
private struct NumberedSteps: View {
  let color: PersonColor
  var active: Int?
  let steps: [String]

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
        let lit = active == nil || active == index
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text("\(index + 1)")
            .font(Bricolage.bold(14))
            .foregroundStyle(lit ? color.ink : Paper.tone)
            .frame(width: 28, height: 28)
            .background(lit ? color.base : Paper.faint, in: .circle)
            .scaleEffect(lit && active != nil ? 1.08 : 1)
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
          Text(step)
            .font(Bricolage.medium(16))
            .foregroundStyle(lit ? Paper.ink : Paper.tone)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
      }
    }
  }
}

/// How a tap from you looks on their Mac: your color as the frame, your name
/// on its edge, and (on the welcome) the answers they can give.
struct TapPreview: View {
  let name: String
  let color: PersonColor
  let message: String
  var replies = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(name)
        .font(Bricolage.bold(13))
        .foregroundStyle(color.ink)
        .padding(.horizontal, 6)
        .contentTransition(.opacity)
      VStack(alignment: .leading, spacing: 14) {
        ZStack(alignment: .leading) {
          Text(message)
            .font(Bricolage.extraBold(26))
            .tracking(-1)
            .id(message)
            .transition(reduceMotion ? .opacity : .rise)
        }
        .frame(maxWidth: .infinity, minHeight: replies ? 0 : 44, alignment: .leading)
        if replies {
          HStack(spacing: 6) {
            reply("On it", icon: .onIt, filled: true)
            reply("In 10 min", icon: .in10)
            reply("Reply", icon: .reply)
          }
        }
      }
      .padding(14)
      .background(Paper.paper, in: .rect(cornerRadius: 14, style: .continuous))
      .foregroundStyle(Paper.ink)
    }
    .padding(8)
    .background(color.base, in: .rect(cornerRadius: 20, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Preview of a tap from \(name): \(message)")
  }

  private func reply(_ label: String, icon: Icon, filled: Bool = false) -> some View {
    HStack(spacing: 4) {
      IconView(icon: icon, size: 13)
      Text(label).lineLimit(1)
    }
    .font(Bricolage.bold(12))
    .padding(.horizontal, 10)
    .frame(height: 28)
    .foregroundStyle(filled ? color.ink : Paper.ink)
    .background {
      if filled {
        Capsule().fill(color.base)
      } else {
        Capsule().strokeBorder(Paper.line, lineWidth: 1.5)
      }
    }
  }
}
