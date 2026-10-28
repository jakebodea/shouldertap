import AppKit
import ShouldertapCore
import SwiftUI

// Patron membership as the sender meets it (docs/patrons.md): optional
// support that keeps Shouldertap free, thanked with themes for the taps they
// send. Shown, not described: every pitch draws their own tap in the themes.
// Nothing here ever appears in a received tap.

extension TapTheme {
  /// The four a patron's taps can use, in the order they're shown off.
  static let patron: [TapTheme] = [.broadsheet, .billboard, .terminal, .note]

  var sub: String {
    switch self {
    case .default: "The calm Frame. Free"
    case .broadsheet: "Your tap as a front page"
    case .billboard: "A poster in your color"
    case .terminal: "A phosphor console"
    case .note: "Handwritten, taped down"
    }
  }
}

enum PatronCopy {
  static let price = "$2/month, billed $24 a year, plus tax."
  static let perks = [
    (Icon.send, "Broadsheet, Billboard, Terminal and Note, on every tap you send."),
    (Icon.invite, "To everyone you tap. They never pay to see it."),
    (Icon.onIt, "Helps cover running costs, so sending and answering stay free for everyone."),
  ]
}

/// Opens checkout in the browser; the membership unlocks here when the
/// account says it's paid (on refresh, or when the app comes back).
@MainActor func becomePatron(_ patron: PatronStore) async {
  if let url = await patron.checkoutURL() { NSWorkspace.shared.open(url) }
}

@MainActor func manageBilling(_ patron: PatronStore) async {
  if let url = await patron.manageURL() { NSWorkspace.shared.open(url) }
}

// MARK: Previews

/// The real overlay drawing one tap at a 1440×900 display, scaled to `width`.
/// Decorative and inert: answering it does nothing.
struct ThemePreview: View {
  let theme: TapTheme
  let name: String
  let color: PersonColor
  let message: String
  let width: CGFloat
  /// Bump to play the arrival again.
  var replay = 0
  var cornerRadius: CGFloat = 8
  @State private var model: OverlayModel

  init(
    theme: TapTheme, name: String, color: PersonColor, message: String, width: CGFloat, replay: Int = 0,
    cornerRadius: CGFloat = 8
  ) {
    self.theme = theme
    self.name = name
    self.color = color
    self.message = message
    self.width = width
    self.replay = replay
    self.cornerRadius = cornerRadius
    _model = State(
      initialValue: OverlayModel(
        active: ActiveTap(tap: Self.tap(name: name, color: color, message: message), queued: 0), theme: theme,
        reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, respond: { _, _ in }))
  }

  var body: some View {
    let scale = width / 1440
    OverlayView(model: model)
      .frame(width: 1440, height: 900)
      .scaleEffect(scale, anchor: .topLeading)
      .frame(width: width, height: 900 * scale, alignment: .topLeading)
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(.separator, lineWidth: 0.5))
      .allowsHitTesting(false)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Preview of a tap in \(theme.label)")
      .onChange(of: theme) { _, next in
        model.theme = next
        model.arrival += 1
      }
      .onChange(of: replay) { model.arrival += 1 }
      .onChange(of: "\(name)|\(color)|\(message)") {
        model.active = ActiveTap(tap: Self.tap(name: name, color: color, message: message), queued: 0)
      }
  }

  private static func tap(name: String, color: PersonColor, message: String) -> Tap {
    Tap(
      id: "preview", senderId: "preview", senderName: name, senderColor: color, body: message,
      createdAt: Date.now.timeIntervalSince1970 * 1000)
  }
}

/// Steps through the patron themes, one arrival each, unless motion is
/// reduced (then Broadsheet holds still).
@MainActor @Observable
final class ThemeCycle {
  private(set) var theme: TapTheme = .broadsheet
  @ObservationIgnored private var timer: Timer?

  func start() {
    guard timer == nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    let timer = Timer(timeInterval: 3.2, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        let next = (TapTheme.patron.firstIndex(of: self.theme) ?? 0) + 1
        self.theme = TapTheme.patron[next % TapTheme.patron.count]
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }
}

// MARK: Composer

/// The way into Tap style for one person, drawn as the tap itself: the style
/// their taps use, or the draft cycling through the patron themes.
struct StyleRow: View {
  let patron: PatronStore
  let pairing: SenderPairing
  let message: String
  let open: () -> Void
  @State private var cycle = ThemeCycle()

  private var inUse: TapTheme { patron.theme(for: pairing) }
  private var showcasing: Bool { inUse == .default }
  private var theme: TapTheme { showcasing ? cycle.theme : inUse }

  var body: some View {
    Button(action: open) {
      HStack(spacing: 12) {
        ThemePreview(
          theme: theme, name: pairing.senderName, color: pairing.swatchColor, message: message, width: 88,
          cornerRadius: 5)
        VStack(alignment: .leading, spacing: 2) {
          Text(showcasing ? "Send it as \(theme.label)" : "Style: \(theme.label)")
            .font(.system(size: 14, weight: .semibold))
          Text(showcasing ? "Patron themes" : "How \(pairing.recipientName) sees it")
            .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(.tertiary)
      }
      .padding(8)
      .padding(.trailing, 6)
      .background(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
      .contentShape(RoundedRectangle(cornerRadius: 12))
    }
    .buttonStyle(.plain)
    .onAppear { cycle.start() }
    .onDisappear { cycle.stop() }
  }
}

/// After a few taps (PatronNudge): a quiet word about membership, once per
/// milestone, never for a patron.
struct PatronNudgeCard: View {
  let patron: PatronStore
  let color: PersonColor

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Enjoying Shouldertap?").font(Bricolage.bold(17))
      Text(
        "It's free, and patrons keep it that way. If you'd like to chip in $2 a month, your taps can arrive in Broadsheet, Billboard, Terminal or Note."
      )
      .font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 12) {
        Button("Become a patron") {
          patron.nudgeHandled()
          Task { await becomePatron(patron) }
        }
        .buttonStyle(PatronPill(color: color))
        Button("Not now") { withAnimation(.easeOut(duration: 0.25)) { patron.nudgeHandled() } }
          .buttonStyle(.plain)
          .font(.system(size: 13, weight: .medium))
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.5)))
    .transition(.opacity)
  }
}

// MARK: Tap style

/// How the sender's taps look on one person's screens, chosen here
/// (`PatronStore.choose`); a patron theme leads to membership for someone
/// who isn't one yet.
struct StyleSheet: View {
  let patron: PatronStore
  let pairing: SenderPairing
  let message: String
  /// Saves the theme for this person.
  let choose: (TapTheme) async throws -> Void
  let done: () -> Void
  /// Picked here; until then the theme in use, also once status loads.
  @State private var picked: TapTheme?
  @State private var replay = 0
  @State private var saving = false
  @State private var failure: String?

  private var name: String { pairing.senderName }
  private var recipient: String { pairing.recipientName }
  private var color: PersonColor { pairing.swatchColor }
  private var inUse: TapTheme { patron.theme(for: pairing) }
  private var selected: TapTheme { picked ?? inUse }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 4) {
            Text("Tap style for \(recipient)").font(Bricolage.extraBold(28)).tracking(-0.9).lineLimit(1)
            Text("How your taps look on \(recipient)'s screens. They never pay to see it.")
              .font(.system(size: 13)).foregroundStyle(.secondary)
          }
          ThemePreview(
            theme: selected, name: name, color: color, message: message, width: 472, replay: replay, cornerRadius: 10
          )
          .shadow(color: .black.opacity(0.18), radius: 10, y: 6)
          HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
              Text(selected.label).font(Bricolage.bold(18))
              Text(selected.sub).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
              replay += 1
            } label: {
              Label("Replay", systemImage: "arrow.counterclockwise")
            }
          }
          themes
          action
          Divider().padding(.vertical, 4)
          membership
        }
        .padding(24)
      }
      Divider()
      HStack {
        Spacer()
        Button("Done", action: done).keyboardShortcut(.defaultAction)
      }
      .padding(12)
    }
    .frame(width: 520, height: 640)
    .onAppear {
      Task { await patron.refresh() }
    }
  }

  private var themes: some View {
    VStack(spacing: 6) {
      ForEach(TapTheme.allCases, id: \.self) { theme in
        Button {
          picked = theme
        } label: {
          HStack(spacing: 12) {
            ThemePreview(theme: theme, name: name, color: color, message: message, width: 88, cornerRadius: 5)
            VStack(alignment: .leading, spacing: 1) {
              Text(theme.label).font(.system(size: 14, weight: .semibold))
              Text(
                theme.sub + (theme == .default || patron.active ? "" : " · Patrons") + (theme == inUse ? " · in use" : "")
              )
              .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
          }
          .padding(6)
          .background(
            RoundedRectangle(cornerRadius: 12)
              .strokeBorder(selected == theme ? Color.primary : Color(nsColor: .separatorColor), lineWidth: selected == theme ? 2 : 1))
          .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected == theme ? .isSelected : [])
      }
    }
  }

  @ViewBuilder private var action: some View {
    if selected == inUse {
      Text("Your taps to \(recipient) use \(selected.label).")
        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    } else if selected == .default || patron.active {
      VStack(spacing: 6) {
        Button("Use \(selected.label)", action: use)
          .buttonStyle(PatronPill(color: color, wide: true))
          .disabled(saving)
        if let failure { Text(failure).font(.system(size: 12)).foregroundStyle(.red) }
      }
    } else if patron.checkoutEnabled {
      VStack(spacing: 6) {
        Button("Become a patron to use \(selected.label)") {
          Task { await becomePatron(patron) }
        }
        .buttonStyle(PatronPill(color: color, wide: true))
        .disabled(patron.busy)
        Text("\(PatronCopy.price) Come back here to switch it on.")
          .font(.system(size: 11)).foregroundStyle(.secondary)
      }
    } else {
      Text("Patron memberships open soon.").font(.system(size: 13)).foregroundStyle(.secondary)
    }
  }

  private func use() {
    let theme = selected
    saving = true
    failure = nil
    Task {
      defer { saving = false }
      do { try await choose(theme) } catch { failure = error.localizedDescription }
    }
  }

  @ViewBuilder private var membership: some View {
    VStack(alignment: .leading, spacing: 10) {
      if patron.active {
        Text("Thank you for being a patron.").font(Bricolage.bold(17))
        if let line = renewal(patron) { Text(line).font(.system(size: 12)).foregroundStyle(.secondary) }
        Button("Manage billing") { Task { await manageBilling(patron) } }.disabled(patron.busy)
      } else {
        Text("Help keep Shouldertap free.").font(Bricolage.bold(17))
        ForEach(PatronCopy.perks, id: \.1) { icon, text in
          HStack(alignment: .top, spacing: 10) {
            IconView(icon: icon, size: 15).padding(.top, 1)
            Text(text).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      if let error = patron.error { Text(error).font(.system(size: 12)).foregroundStyle(.red) }
    }
  }
}

/// "Renews October 21, 2027." / "Ends …" for a paid-up membership.
@MainActor func renewal(_ patron: PatronStore) -> String? {
  guard let billing = patron.status?.active?.status.patron, let until = billing.paidUntil else { return nil }
  let date = Date(timeIntervalSince1970: until / 1000).formatted(date: .long, time: .omitted)
  return billing.status == "ending" ? "Ends \(date)." : "Renews \(date)."
}

/// A pill in the person's color with its ink.
struct PatronPill: ButtonStyle {
  let color: PersonColor
  var wide = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(color.ink)
      .padding(.horizontal, 16)
      .frame(maxWidth: wide ? .infinity : nil, minHeight: 32)
      .background(Capsule().fill(color.base))
      .contentShape(Capsule())
      .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
  }
}
