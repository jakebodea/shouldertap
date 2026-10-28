import ActivityKit
import ShouldertapCore
import SwiftUI
import WidgetKit

@main
struct ShouldertapWidgets: WidgetBundle {
  var body: some Widget {
    TapLiveActivity()
  }
}

/// A tap on a locked or busy iPhone: the sender's color frames the Lock
/// Screen card and accents the Dynamic Island, like the Mac overlay's frame.
struct TapLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TapActivityAttributes.self) { context in
      let tap = context.attributes
      LockScreenTap(attributes: tap, state: context.state)
        .activityBackgroundTint(tap.senderTheme == .terminal ? ThemeInk.screen(tap.senderColor) : tap.senderColor.base)
        .activitySystemActionForegroundColor(
          tap.senderTheme == .terminal ? ThemeInk.phosphor(tap.senderColor) : tap.senderColor.ink)
    } dynamicIsland: { context in
      let tap = context.attributes
      let state = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 8) {
            Initial(name: tap.senderName, color: tap.senderColor, size: 26)
            Text(tap.senderName)
              .font(Bricolage.bold(17))
              .lineLimit(1)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(tap.createdDate, style: .relative)
            .font(Bricolage.medium(13))
            .foregroundStyle(.white.opacity(0.6))
            .multilineTextAlignment(.trailing)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 10) {
            IslandMessage(theme: tap.senderTheme, color: tap.senderColor, message: state.body)
            Answers(tap: tap, state: state, look: .island(tap.senderTheme, tap.senderColor))
          }
          .padding(.horizontal, 4)
          .padding(.top, 2)
        }
      } compactLeading: {
        Initial(name: tap.senderName, color: tap.senderColor, size: 22)
      } compactTrailing: {
        Text(tap.senderName)
          .font(Bricolage.bold(14))
          .foregroundStyle(tap.senderColor.accent)
          .lineLimit(1)
          .frame(maxWidth: 64)
      } minimal: {
        Initial(name: tap.senderName, color: tap.senderColor, size: 22)
      }
      .keylineTint(tap.senderColor.accent)
      .widgetURL(URL(string: "shouldertap://tap/\(tap.tapId)"))
    }
  }
}

/// The Lock Screen card in the tap's theme. Default: name on the frame, the
/// message on a paper page, then the answers. The others are small takes on
/// their Mac compositions (docs/design.md, "Tap themes").
private struct LockScreenTap: View {
  let attributes: TapActivityAttributes
  let state: TapActivityAttributes.ContentState

  var body: some View {
    let color = attributes.senderColor
    switch attributes.senderTheme {
    case .default:
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline) {
          Text(attributes.senderName)
            .font(Bricolage.bold(17))
          Spacer()
          ago.font(Bricolage.medium(13)).opacity(0.75)
        }
        .foregroundStyle(color.ink)
        Text(state.body)
          .font(Bricolage.extraBold(24))
          .tracking(-0.8)
          .lineSpacing(-3)
          .lineLimit(3)
          .minimumScaleFactor(0.6)
          .foregroundStyle(WidgetPaper.ink)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .background(WidgetPaper.paper, in: .rect(cornerRadius: 16, style: .continuous))
        Answers(tap: attributes, state: state, look: .frame(color))
      }
      .padding(14)
    case .broadsheet:
      let ink = Color(hex: ThemeInk.news)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline) {
          Text(attributes.senderName).font(ThemeFont.font(ThemeFont.serifItalic, 24)).lineLimit(1)
          Spacer()
          ago.font(ThemeFont.font(ThemeFont.serif, 14)).opacity(0.7)
        }
        VStack(spacing: 2) {
          Rectangle().fill(color.base).frame(height: 2.5)
          Rectangle().fill(color.base).frame(height: 1)
        }
        Text(state.body)
          .font(ThemeFont.font(ThemeFont.serif, 28))
          .lineSpacing(-4)
          .lineLimit(2)
          .minimumScaleFactor(0.6)
          .frame(maxWidth: .infinity, alignment: .leading)
        Answers(tap: attributes, state: state, look: .broadsheet(color))
      }
      .foregroundStyle(ink)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(Color(hex: ThemeInk.newsprint), in: .rect(cornerRadius: 8, style: .continuous))
      .padding(8)
    case .billboard:
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline) {
          Text("Tap from \(attributes.senderName)".uppercased()).lineLimit(1)
          Spacer()
          ago.textCase(.uppercase)
        }
        .font(ThemeFont.font(ThemeFont.posterBold, 15))
        .tracking(0.8)
        .opacity(0.8)
        Text(state.body.uppercased())
          .font(ThemeFont.font(ThemeFont.poster, 40))
          .lineSpacing(-10)
          .lineLimit(2)
          .minimumScaleFactor(0.5)
          .frame(maxWidth: .infinity, alignment: .leading)
        Answers(tap: attributes, state: state, look: .billboard(color))
      }
      .foregroundStyle(color.ink)
      .padding(14)
    case .terminal:
      let phosphor = ThemeInk.phosphor(color)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 8) {
          Circle().fill(color.ink).frame(width: 6, height: 6)
          Text(attributes.senderName).lineLimit(1)
          Spacer()
          ago.textCase(.lowercase)
        }
        .font(ThemeFont.font(ThemeFont.mono, 12))
        .foregroundStyle(color.ink)
        .padding(.horizontal, 14)
        .frame(height: 26)
        .background(color.base)
        VStack(alignment: .leading, spacing: 6) {
          Text(state.body)
            .font(ThemeFont.font(ThemeFont.terminal, 30))
            .lineLimit(2)
            .minimumScaleFactor(0.6)
            .shadow(color: phosphor.opacity(0.45), radius: 6)
            .frame(maxWidth: .infinity, alignment: .leading)
          Answers(tap: attributes, state: state, look: .terminal(color))
        }
        .foregroundStyle(phosphor)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
      }
      .overlay { Scanlines() }
    case .note:
      let pen = Color(hex: ThemeInk.pen)
      VStack(alignment: .leading, spacing: 2) {
        Text(state.body)
          .font(ThemeFont.font(ThemeFont.hand, 30))
          .lineSpacing(-4)
          .lineLimit(2)
          .minimumScaleFactor(0.6)
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(alignment: .firstTextBaseline) {
          ago.opacity(0.6)
          Spacer()
          Text("— \(attributes.senderName)").lineLimit(1)
        }
        .font(ThemeFont.font(ThemeFont.hand, 19))
        Answers(tap: attributes, state: state, look: .note(color))
      }
      .foregroundStyle(pen)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background {
        Color(hex: ThemeInk.sheet)
          .overlay { RuledLines(top: 34, spacing: 26) }
          .rotationEffect(.degrees(-1))
      }
      .padding(10)
    }
  }

  private var ago: some View {
    Text(attributes.createdDate, style: .relative).multilineTextAlignment(.trailing)
  }
}

/// The message in the Dynamic Island, on its black: the theme's type in the
/// light colors that read there.
private struct IslandMessage: View {
  let theme: TapTheme
  let color: PersonColor
  let message: String

  var body: some View {
    text
      .lineLimit(3)
      .minimumScaleFactor(0.7)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private var text: some View {
    switch theme {
    case .default:
      Text(message).font(Bricolage.extraBold(22)).tracking(-0.6).lineSpacing(-2).foregroundStyle(.white)
    case .broadsheet:
      Text(message).font(ThemeFont.font(ThemeFont.serif, 28)).lineSpacing(-4).foregroundStyle(Color(hex: ThemeInk.newsprint))
    case .billboard:
      Text(message.uppercased()).font(ThemeFont.font(ThemeFont.poster, 32)).lineSpacing(-8).foregroundStyle(color.accent)
    case .terminal:
      Text(message).font(ThemeFont.font(ThemeFont.terminal, 28)).foregroundStyle(ThemeInk.phosphor(color))
    case .note:
      Text(message).font(ThemeFont.font(ThemeFont.hand, 28)).lineSpacing(-4).foregroundStyle(Color(hex: ThemeInk.sheet))
    }
  }
}

/// How a surface draws the answers: type, the first answer's fill, the
/// others' fill or outline, and the shape.
struct AnswerLook {
  var font: Font
  var primary: (text: Color, fill: Color)
  var secondary: (text: Color, fill: Color)
  /// Outline the other answers in `secondary.fill` instead of filling them.
  var outlined = false
  var square = false
  var height: CGFloat = 34
  var label: (String) -> String = { $0 }
  /// The answer once given.
  var answered: Color

  static func frame(_ color: PersonColor) -> AnswerLook {
    AnswerLook(
      font: Bricolage.bold(14), primary: (color.base, color.ink), secondary: (color.ink, color.ink.opacity(0.16)),
      answered: color.ink)
  }

  static func broadsheet(_ color: PersonColor) -> AnswerLook {
    let ink = Color(hex: ThemeInk.news)
    return AnswerLook(
      font: ThemeFont.font(ThemeFont.serif, 18), primary: (color.ink, color.base), secondary: (ink, ink.opacity(0.4)),
      outlined: true, square: true, height: 30, answered: ink)
  }

  static func billboard(_ color: PersonColor) -> AnswerLook {
    AnswerLook(
      font: ThemeFont.font(ThemeFont.poster, 18), primary: (color.base, color.ink), secondary: (color.ink, color.ink),
      outlined: true, square: true, label: { $0.uppercased() }, answered: color.ink)
  }

  static func terminal(_ color: PersonColor) -> AnswerLook {
    let phosphor = ThemeInk.phosphor(color)
    return AnswerLook(
      font: ThemeFont.font(ThemeFont.terminal, 22), primary: (ThemeInk.screen(color), phosphor),
      secondary: (phosphor, phosphor.opacity(0.14)), square: true, height: 30, label: { $0.lowercased() },
      answered: phosphor)
  }

  static func note(_ color: PersonColor) -> AnswerLook {
    let pen = Color(hex: ThemeInk.pen)
    return AnswerLook(
      font: ThemeFont.font(ThemeFont.hand, 21), primary: (pen, color.base.opacity(ThemeInk.highlight(color))),
      secondary: (pen, pen.opacity(0.5)), outlined: true, square: true, height: 30, answered: pen)
  }

  /// On the Dynamic Island's black, whatever the theme: its type, the
  /// sender's color as the first answer.
  static func island(_ theme: TapTheme, _ color: PersonColor) -> AnswerLook {
    var look = AnswerLook(
      font: Bricolage.bold(14), primary: (color.ink, color.base), secondary: (.white, .white.opacity(0.16)),
      answered: color.accent)
    switch theme {
    case .default: break
    case .broadsheet: look.font = ThemeFont.font(ThemeFont.serif, 18)
    case .billboard:
      look.font = ThemeFont.font(ThemeFont.poster, 18)
      look.label = { $0.uppercased() }
      look.square = true
    case .terminal:
      let phosphor = ThemeInk.phosphor(color)
      look.font = ThemeFont.font(ThemeFont.terminal, 22)
      look.label = { $0.lowercased() }
      look.square = true
      look.primary = (.black, phosphor)
      look.secondary = (phosphor, phosphor.opacity(0.16))
      look.answered = phosphor
    case .note: look.font = ThemeFont.font(ThemeFont.hand, 21)
    }
    return look
  }
}

/// On it and In 10 min (or the sender's own answers) run in place; Reply
/// opens the app to type. Once answered, the answer replaces the buttons.
private struct Answers: View {
  let tap: TapActivityAttributes
  let state: TapActivityAttributes.ContentState
  let look: AnswerLook

  var body: some View {
    let options = state.quickReplies
    // A sender's own words get no icon: a tick or a clock might not fit them.
    let custom = state.replies != nil
    if let answer = state.answer {
      HStack(spacing: 6) {
        IconView(icon: .onIt, size: 16)
        Text(look.label(answer))
      }
      .font(look.font)
      .foregroundStyle(look.answered)
      .frame(height: look.height)
    } else {
      HStack(spacing: 6) {
        Button(intent: AnswerTapIntent(tapId: tap.tapId, response: options[0].response)) {
          answer(custom ? nil : .onIt, options[0].label, primary: true)
        }
        Button(intent: AnswerTapIntent(tapId: tap.tapId, response: options[1].response)) {
          answer(custom ? nil : .in10, options[1].label, primary: false)
        }
        Link(destination: URL(string: "shouldertap://tap/\(tap.tapId)?reply=1")!) {
          answer(.reply, "Reply", primary: false)
        }
      }
      .buttonStyle(.plain)
    }
  }

  private func answer(_ icon: Icon?, _ text: String, primary: Bool) -> some View {
    let colors = primary ? look.primary : look.secondary
    let shape = look.square ? AnyShape(.rect) : AnyShape(.capsule)
    return HStack(spacing: 5) {
      if let icon { IconView(icon: icon, size: 15) }
      Text(look.label(text)).lineLimit(1).minimumScaleFactor(0.7)
    }
    .font(look.font)
    .padding(.horizontal, 12)
    .frame(height: look.height)
    .foregroundStyle(colors.text)
    .background {
      if !primary && look.outlined {
        shape.stroke(colors.fill, lineWidth: 1.5)
      } else {
        shape.fill(colors.fill)
      }
    }
  }
}

/// The sender's initial in their color.
private struct Initial: View {
  let name: String
  let color: PersonColor
  let size: CGFloat

  var body: some View {
    Circle()
      .fill(color.base)
      .overlay {
        Text(name.first.map { String($0).uppercased() } ?? "")
          .font(Bricolage.bold(size * 0.5))
          .foregroundStyle(color.ink)
      }
      .frame(width: size, height: size)
  }
}

// MARK: - Theme (the bits of the app's Theme.swift the extension needs)

enum WidgetPaper {
  static let paper = Color(hex: 0xf6f5f1)
  static let ink = Color(hex: 0x161616)
}

enum Bricolage {
  static func medium(_ size: CGFloat) -> Font { .custom("BricolageGrotesque-Medium", fixedSize: size) }
  static func bold(_ size: CGFloat) -> Font { .custom("BricolageGrotesque-Bold", fixedSize: size) }
  static func extraBold(_ size: CGFloat) -> Font { .custom("BricolageGrotesque-ExtraBold", fixedSize: size) }
}

extension PersonColor {
  var base: Color { Color(hex: swatch.base) }
  var ink: Color { Color(hex: swatch.ink) }
  /// The color as text or a keyline on the Dynamic Island's black: dark
  /// swatches use their light ink instead so they stay legible.
  var accent: Color {
    switch self {
    case .moss, .cobalt, .plum, .graphite: ink
    default: base
    }
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255)
  }
}
