import ShouldertapCore
import StoreKit
import SwiftUI

// Tap styles on iPhone (docs/patrons.md): each person you tap can get their
// own theme, chosen here and saved on the account. The paid themes go out
// only while the account has an active patron membership (`PatronStore`);
// the server still checks the key on every send.

/// The bundled faces, by PostScript name (apps/macos/Resources/Fonts,
/// registered with UIAppFonts). Fixed sizes: the cards are drawings.
private enum ThemeFont {
  static let frame = "BricolageGrotesque-ExtraBold"
  static let frameName = "BricolageGrotesque-Bold"
  static let serif = "InstrumentSerif-Regular"
  static let serifItalic = "InstrumentSerif-Italic"
  static let poster = "BigShouldersDisplay-Black"
  static let posterBold = "BigShouldersDisplay-Bold"
  static let terminal = "VT323-Regular"
  static let mono = "GeistMono-Bold"
  static let hand = "CaveatRoman-Bold"

  static func font(_ name: String, _ size: CGFloat) -> Font { .custom(name, fixedSize: size) }
}

extension Color {
  /// `share` of `a` into `b`, per channel, as the Mac themes mix them.
  fileprivate static func mix(_ a: UInt32, _ share: Double, _ b: UInt32) -> Color {
    func channel(_ hex: UInt32, _ shift: UInt32) -> Double { Double((hex >> shift) & 0xff) / 255 }
    let mixed = { (shift: UInt32) in channel(a, shift) * share + channel(b, shift) * (1 - share) }
    return Color(.sRGB, red: mixed(16), green: mixed(8), blue: mixed(0))
  }
}

/// One tap theme, small and still, on a phone-sized card (docs/design.md,
/// "Tap themes"): enough of each composition to tell them apart. Nothing
/// moves; the Mac draws the real thing.
struct ThemeCard: View {
  let theme: TapTheme
  let name: String
  let color: PersonColor
  let message: String

  var body: some View {
    GeometryReader { proxy in
      // Drawn for a 100pt-wide card; wide previews keep the type in step
      // with their height.
      let u = min(proxy.size.width, proxy.size.height * 0.64) / 100
      composition(u)
        .frame(width: proxy.size.width, height: proxy.size.height)
    }
    .clipShape(.rect(cornerRadius: 12, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(theme.label): a tap from \(name), \(message)")
  }

  @ViewBuilder private func composition(_ u: CGFloat) -> some View {
    switch theme {
    case .default: frame(u)
    case .broadsheet: broadsheet(u)
    case .billboard: billboard(u)
    case .terminal: terminal(u)
    case .note: note(u)
    }
  }

  /// Their color as the frame, their name on its edge, the message on paper.
  private func frame(_ u: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 4 * u) {
      Text(name).font(ThemeFont.font(ThemeFont.frameName, 9 * u)).foregroundStyle(color.ink).lineLimit(1)
        .padding(.leading, 3 * u)
      VStack(alignment: .leading, spacing: 0) {
        Text(message).font(ThemeFont.font(ThemeFont.frame, 15 * u)).tracking(-0.5 * u)
          .lineLimit(4).minimumScaleFactor(0.6)
        Spacer(minLength: 4 * u)
        HStack(spacing: 3 * u) {
          Capsule().fill(color.base).frame(width: 22 * u, height: 8 * u)
          Capsule().strokeBorder(Color(hex: 0xdedcd5), lineWidth: max(0.5, 1 * u)).frame(width: 22 * u, height: 8 * u)
        }
      }
      .foregroundStyle(Color(hex: 0x161616))
      .padding(7 * u)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(Color(hex: 0xf6f5f1), in: .rect(cornerRadius: 8 * u, style: .continuous))
    }
    .padding(5 * u)
    .background(color.base)
  }

  /// Newsprint in a border of their color: an italic nameplate over a double
  /// rule, the message as the headline, ruled answers.
  private func broadsheet(_ u: CGFloat) -> some View {
    let ink = Color(hex: 0x1b1813)
    return VStack(alignment: .leading, spacing: 3 * u) {
      Text(name).font(ThemeFont.font(ThemeFont.serifItalic, 15 * u)).lineLimit(1).minimumScaleFactor(0.5)
        .frame(maxWidth: .infinity)
      VStack(spacing: 1.2 * u) {
        Rectangle().fill(color.base).frame(height: 2.6 * u)
        Rectangle().fill(color.base).frame(height: 0.8 * u)
      }
      Text(message).font(ThemeFont.font(ThemeFont.serif, 17 * u)).lineSpacing(-2 * u)
        .lineLimit(4).minimumScaleFactor(0.6)
      Spacer(minLength: 2 * u)
      VStack(alignment: .leading, spacing: 0) {
        Text("On it").font(ThemeFont.font(ThemeFont.serif, 8 * u)).foregroundStyle(color.ink)
          .padding(.horizontal, 2.5 * u).frame(maxWidth: .infinity, alignment: .leading)
          .background(color.base)
        ForEach(["In ten minutes", "Write back"], id: \.self) { answer in
          Text(answer).font(ThemeFont.font(ThemeFont.serif, 8 * u)).padding(.horizontal, 2.5 * u)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Rectangle().fill(ink.opacity(0.35)).frame(height: max(0.5, 0.5 * u)) }
        }
      }
    }
    .foregroundStyle(ink)
    .padding(6 * u)
    .background(Color(hex: 0xf2ede1))
    .padding(5 * u)
    .background(color.base)
  }

  /// Their color edge to edge: a kicker, the message in poster capitals at
  /// the foot, three answer blocks.
  private func billboard(_ u: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 4 * u) {
      Text("Tap from \(name)".uppercased()).font(ThemeFont.font(ThemeFont.posterBold, 8 * u)).tracking(0.5 * u)
        .lineLimit(1).opacity(0.8)
      Spacer(minLength: 0)
      Text(message.uppercased()).font(ThemeFont.font(ThemeFont.poster, 24 * u)).lineSpacing(-6 * u)
        .lineLimit(4).minimumScaleFactor(0.5)
      HStack(spacing: 2.5 * u) {
        Rectangle().fill(color.ink).frame(height: 9 * u)
        Rectangle().strokeBorder(color.ink, lineWidth: max(0.5, 1 * u)).frame(height: 9 * u)
        Rectangle().strokeBorder(color.ink, lineWidth: max(0.5, 1 * u)).frame(height: 9 * u)
      }
    }
    .foregroundStyle(color.ink)
    .padding(7 * u)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(color.base)
  }

  /// A dark field tinted by their color, phosphor type, a status bar in
  /// their color, a bracketed menu and scanlines.
  private func terminal(_ u: CGFloat) -> some View {
    let phosphor = Color.mix(color.swatch.base, 0.38, 0xf1fff3)
    return VStack(alignment: .leading, spacing: 0) {
      Text(name.lowercased()).font(ThemeFont.font(ThemeFont.mono, 6 * u)).lineLimit(1)
        .foregroundStyle(color.ink)
        .padding(.horizontal, 4 * u).frame(maxWidth: .infinity, minHeight: 10 * u, alignment: .leading)
        .background(color.base)
      VStack(alignment: .leading, spacing: 3 * u) {
        Text("$ tap --from \(name.lowercased())").font(ThemeFont.font(ThemeFont.terminal, 8 * u)).lineLimit(1)
          .opacity(0.62)
        Text(message).font(ThemeFont.font(ThemeFont.terminal, 15 * u)).lineLimit(4).minimumScaleFactor(0.6)
        Spacer(minLength: 2 * u)
        Text("[1] on it\n[2] in 10 min").font(ThemeFont.font(ThemeFont.terminal, 8 * u))
        Rectangle().fill(phosphor).frame(width: 5 * u, height: 8 * u)
      }
      .foregroundStyle(phosphor)
      .padding(5 * u)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .background(Color.mix(color.swatch.base, 0.16, 0x060708))
    .overlay {
      Canvas { context, size in
        for y in stride(from: 0, to: size.height, by: max(2, 2 * u)) {
          context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: max(0.5, 0.6 * u))), with: .color(.black.opacity(0.22)))
        }
      }
      .allowsHitTesting(false)
    }
  }

  /// A cream sheet taped to a desk of their color, written by hand on ruled
  /// lines, signed, with a ticked answer under a highlighter.
  private func note(_ u: CGFloat) -> some View {
    let ink = Color(hex: 0x1d2742)
    return VStack(alignment: .leading, spacing: 2 * u) {
      Text(message).font(ThemeFont.font(ThemeFont.hand, 17 * u)).lineLimit(4).minimumScaleFactor(0.6)
      Text("— \(name)").font(ThemeFont.font(ThemeFont.hand, 11 * u)).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .trailing)
      Spacer(minLength: 2 * u)
      HStack(spacing: 3 * u) {
        Rectangle().strokeBorder(ink, lineWidth: max(0.5, 0.8 * u)).frame(width: 6 * u, height: 6 * u)
        Text("on it").font(ThemeFont.font(ThemeFont.hand, 10 * u))
          .padding(.horizontal, 1.5 * u)
          .background(color.base.opacity(0.45))
      }
    }
    .foregroundStyle(ink)
    .padding(8 * u)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background {
      Canvas { context, size in
        for y in stride(from: 16 * u, to: size.height, by: 10 * u) {
          context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: max(0.5, 0.4 * u))), with: .color(Color(hex: 0xc9d6ea)))
        }
      }
      .background(Color(hex: 0xfbf8ee))
    }
    .overlay(alignment: .top) {
      Rectangle().fill(.white.opacity(0.55)).frame(width: 24 * u, height: 6 * u).rotationEffect(.degrees(4))
        .offset(y: -3 * u)
    }
    .rotationEffect(.degrees(-2.5))
    .padding(9 * u)
    .background(color.base)
  }
}

/// How one person sees your taps: the Frame for Default, else the theme's card.
struct SeenAsPreview: View {
  let theme: TapTheme
  let name: String
  let color: PersonColor
  var message = "Dinner's ready"

  var body: some View {
    if theme == .default {
      TapPreview(name: name, color: color, message: message)
    } else {
      ThemeCard(theme: theme, name: name, color: color, message: message).frame(height: 200)
    }
  }
}

/// The five themes as cards. Default is free; the others are for patrons and
/// stay locked without a membership. In the US storefront a locked one offers
/// the patron page; elsewhere there's no link.
struct ThemePicker: View {
  @Binding var theme: TapTheme
  let name: String
  let color: PersonColor
  var message = "Dinner's ready"
  /// The locked theme last tapped, in the US storefront.
  @State private var wanted: TapTheme?
  @State private var opening = false
  @State private var error: String?
  @Environment(\.openURL) private var openURL

  private var patron: PatronStore { Stores.patron }
  private var canLink: Bool { USStorefront.shared.isUS && patron.checkoutEnabled }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 12) {
          ForEach(TapTheme.allCases, id: \.self) { option in card(option) }
        }
        .padding(6)
      }
      .scrollIndicators(.hidden)
      .padding(-6)
      if let wanted, !patron.active, canLink {
        Button("Become a patron to use \(wanted.label)") { Task { await becomePatron() } }
          .buttonStyle(PillStyle(color: color, small: true))
          .disabled(opening)
          .accessibilityIdentifier("become-patron")
      }
      if let error { Text(error).font(Bricolage.medium(14)).foregroundStyle(.red) }
    }
    .sensoryFeedback(.selection, trigger: theme)
  }

  private func locked(_ option: TapTheme) -> Bool { option != .default && !patron.active }

  private func card(_ option: TapTheme) -> some View {
    let selected = option == theme
    let locked = locked(option)
    return Button {
      if locked { withAnimation(.easeOut(duration: 0.2)) { wanted = option } } else { theme = option; wanted = nil }
    } label: {
      VStack(spacing: 6) {
        ThemeCard(theme: option, name: name, color: color, message: message)
          .frame(width: 84, height: 132)
          .opacity(locked ? 0.55 : 1)
          .overlay(alignment: .topTrailing) {
            if locked {
              Image(systemName: "lock.fill").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Paper.paper).padding(6).background(Paper.ink.opacity(0.8), in: .circle).padding(5)
            }
          }
          .padding(3)
          .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).strokeBorder(Paper.ink, lineWidth: 2).opacity(selected ? 1 : 0))
        VStack(spacing: 0) {
          Text(option.label).font(Bricolage.bold(13))
          Text(option == .default ? "Free" : locked ? "Patrons" : " ")
            .font(Bricolage.medium(12)).foregroundStyle(Paper.tone)
        }
      }
    }
    .buttonStyle(.plain)
    // Outside the US a locked theme leads nowhere.
    .disabled(locked && !canLink)
    .accessibilityLabel(locked ? "\(option.label), for patrons" : option.label)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("theme-\(option.rawValue)")
  }

  private func becomePatron() async {
    opening = true
    error = nil
    defer { opening = false }
    do { openURL(try await patronPage(account: Stores.account)) } catch { self.error = error.localizedDescription }
  }
}

/// Whether StoreKit says this is the US storefront, the only one where the
/// app links to the patron web page (docs/patrons.md, "iPhone purchase
/// boundary"). Never locale or IP; false until it knows.
@MainActor @Observable
final class USStorefront {
  static let shared = USStorefront()
  private(set) var isUS = false

  /// Follows storefront changes for as long as the caller's task runs.
  func watch() async {
    isUS = await Storefront.current?.countryCode == "USA"
    for await storefront in Storefront.updates {
      isUS = storefront.countryCode == "USA"
    }
  }
}

/// The website's account page for patron membership, with a one-time sign-in
/// code in the fragment so the browser opens signed in to this account. Never
/// opened without one: Safari may be signed in to someone else.
func patronPage(account: AccountStore) async throws -> URL {
  let page = Config.web.appending(path: "/account").appending(queryItems: [URLQueryItem(name: "intent", value: "patron")])
  let handoff = try await account.createQrSignIn()
  var components = URLComponents(url: page, resolvingAgainstBaseURL: false)
  components?.fragment = handoff.token
  guard let signedIn = components?.url else { throw URLError(.badURL) }
  return signedIn
}
