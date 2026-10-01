import SwiftUI

/// The Shouldertap mark (docs/design.md, "The mark"), drawn from the SVG
/// geometry like apps/macos/Sources/Shouldertap/Mark.swift. Changing `knock`
/// pops the knock marks twice: each scales from 0.4 and fades in, staggered
/// 60ms ("The knock" in docs/design.md, "Motion").
struct MarkView: View {
  var size: CGFloat = 36
  var knock = 0

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let scale = size / MarkGeometry.viewBox
    ZStack {
      MarkFrame()
        .stroke(style: StrokeStyle(lineWidth: 5 * scale, lineCap: .round, lineJoin: .round))
      ForEach(0..<MarkGeometry.knocks.count, id: \.self) { index in
        Knock(index: index)
          .stroke(style: StrokeStyle(lineWidth: 3.75 * scale, lineCap: .round))
          .keyframeAnimator(initialValue: KnockFrame(), trigger: knock) { content, frame in
            content
              .scaleEffect(reduceMotion ? 1 : frame.scale, anchor: MarkGeometry.anchor(of: index))
              .opacity(frame.opacity)
          } keyframes: { _ in
            let stagger = Double(index) * 0.06
            let pop = Spring.bouncy(duration: 0.4, extraBounce: 0.15)
            KeyframeTrack(\.scale) {
              LinearKeyframe(1, duration: stagger)
              MoveKeyframe(0.4)
              SpringKeyframe(1, duration: 0.45, spring: pop)
              MoveKeyframe(0.4)
              SpringKeyframe(1, duration: 0.45, spring: pop)
            }
            KeyframeTrack(\.opacity) {
              LinearKeyframe(1, duration: stagger)
              MoveKeyframe(0)
              LinearKeyframe(1, duration: 0.14)
              LinearKeyframe(1, duration: 0.31)
              MoveKeyframe(0)
              LinearKeyframe(1, duration: 0.14)
            }
          }
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

private struct KnockFrame {
  var scale: CGFloat = 1
  var opacity: Double = 1
}

nonisolated private enum MarkGeometry {
  /// viewBox -2.5 -8.65 44.65 44.65
  static let viewBox: CGFloat = 44.65
  static let origin = CGPoint(x: 2.5, y: 8.65)
  static let knocks: [(CGPoint, CGPoint)] = [
    (CGPoint(x: 26.8, y: -3.08), CGPoint(x: 29.19, y: -9.65)),
    (CGPoint(x: 30.63, y: -0.63), CGPoint(x: 35.58, y: -5.58)),
    (CGPoint(x: 33.08, y: 3.2), CGPoint(x: 39.65, y: 0.81)),
  ]

  static func transform(in rect: CGRect) -> CGAffineTransform {
    let scale = min(rect.width, rect.height) / viewBox
    return CGAffineTransform(translationX: rect.minX, y: rect.minY)
      .scaledBy(x: scale, y: scale)
      .translatedBy(x: origin.x, y: origin.y)
  }

  /// Each knock grows out from the end nearest the frame.
  static func anchor(of index: Int) -> UnitPoint {
    let base = knocks[index].0
    return UnitPoint(x: (base.x + origin.x) / viewBox, y: (base.y + origin.y) / viewBox)
  }
}

private struct MarkFrame: Shape {
  func path(in rect: CGRect) -> Path {
    var frame = Path()
    frame.move(to: CGPoint(x: 4, y: 0))
    frame.addCurve(to: CGPoint(x: 30, y: 27.5), control1: CGPoint(x: 23.59, y: 0), control2: CGPoint(x: 30, y: 6.41))
    frame.addLine(to: CGPoint(x: 30, y: 28))
    frame.addCurve(to: CGPoint(x: 26, y: 32), control1: CGPoint(x: 30, y: 31.07), control2: CGPoint(x: 29.07, y: 32))
    frame.addLine(to: CGPoint(x: 4, y: 32))
    frame.addCurve(to: CGPoint(x: 0, y: 28), control1: CGPoint(x: 0.93, y: 32), control2: CGPoint(x: 0, y: 31.07))
    frame.addLine(to: CGPoint(x: 0, y: 4))
    frame.addCurve(to: CGPoint(x: 4, y: 0), control1: CGPoint(x: 0, y: 0.93), control2: CGPoint(x: 0.93, y: 0))
    frame.closeSubpath()
    return frame.applying(MarkGeometry.transform(in: rect))
  }
}

private struct Knock: Shape {
  let index: Int

  func path(in rect: CGRect) -> Path {
    let (from, to) = MarkGeometry.knocks[index]
    var path = Path()
    path.move(to: from)
    path.addLine(to: to)
    return path.applying(MarkGeometry.transform(in: rect))
  }
}
