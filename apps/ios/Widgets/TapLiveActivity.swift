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
      LockScreenTap(attributes: context.attributes, state: context.state)
        .activityBackgroundTint(context.attributes.senderColor.base)
        .activitySystemActionForegroundColor(context.attributes.senderColor.ink)
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
            Text(state.body)
              .font(Bricolage.extraBold(22))
              .tracking(-0.6)
              .lineSpacing(-2)
              .lineLimit(3)
              .minimumScaleFactor(0.7)
              .foregroundStyle(.white)
              .frame(maxWidth: .infinity, alignment: .leading)
            Answers(tap: tap, answer: state.answer, onDark: true)
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

/// The Lock Screen card: name on the frame, the message on a paper page,
/// then the answers.
private struct LockScreenTap: View {
  let attributes: TapActivityAttributes
  let state: TapActivityAttributes.ContentState

  var body: some View {
    let color = attributes.senderColor
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(attributes.senderName)
          .font(Bricolage.bold(17))
        Spacer()
        Text(attributes.createdDate, style: .relative)
          .font(Bricolage.medium(13))
          .opacity(0.75)
          .multilineTextAlignment(.trailing)
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
      Answers(tap: attributes, answer: state.answer, onDark: false)
    }
    .padding(14)
  }
}

/// On it and In 10 min run in place; Reply opens the app to type.
/// Once answered, the answer replaces the buttons.
private struct Answers: View {
  let tap: TapActivityAttributes
  let answer: String?
  let onDark: Bool

  var body: some View {
    let color = tap.senderColor
    if let answer {
      HStack(spacing: 6) {
        IconView(icon: .onIt, size: 16)
        Text(answer)
      }
      .font(Bricolage.bold(14))
      .foregroundStyle(onDark ? color.accent : color.ink)
      .frame(height: 34)
    } else {
      HStack(spacing: 6) {
        Button(intent: AnswerTapIntent(tapId: tap.tapId, response: .onIt)) {
          AnswerLabel(icon: .onIt, text: "On it")
            .foregroundStyle(onDark ? color.ink : color.base)
            .background(onDark ? color.base : color.ink, in: .capsule)
        }
        Button(intent: AnswerTapIntent(tapId: tap.tapId, response: .in10)) {
          AnswerLabel(icon: .in10, text: "In 10 min")
            .foregroundStyle(onDark ? .white : color.ink)
            .background((onDark ? Color.white : color.ink).opacity(0.16), in: .capsule)
        }
        Link(destination: URL(string: "shouldertap://tap/\(tap.tapId)?reply=1")!) {
          AnswerLabel(icon: .reply, text: "Reply")
            .foregroundStyle(onDark ? .white : color.ink)
            .background((onDark ? Color.white : color.ink).opacity(0.16), in: .capsule)
        }
      }
      .buttonStyle(.plain)
    }
  }
}

private struct AnswerLabel: View {
  let icon: Icon
  let text: String

  var body: some View {
    HStack(spacing: 5) {
      IconView(icon: icon, size: 15)
      Text(text).lineLimit(1)
    }
    .font(Bricolage.bold(14))
    .padding(.horizontal, 12)
    .frame(height: 34)
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
