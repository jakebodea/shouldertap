import SwiftUI

/// The Shouldertap mark (docs/design.md, "The mark"), drawn from the SVG
/// geometry like apps/macos/Sources/Shouldertap/Mark.swift.
struct MarkView: View {
  var size: CGFloat = 36

  var body: some View {
    Canvas { context, canvas in
      // viewBox -2.5 -8.65 44.65 44.65
      let scale = min(canvas.width, canvas.height) / 44.65
      context.translateBy(x: 2.5 * scale, y: 8.65 * scale)
      context.scaleBy(x: scale, y: scale)
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
      let shading = GraphicsContext.Shading.style(.foreground)
      context.stroke(frame, with: shading, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
      var knocks = Path()
      for (from, to) in [((26.8, -3.08), (29.19, -9.65)), ((30.63, -0.63), (35.58, -5.58)), ((33.08, 3.2), (39.65, 0.81))] {
        knocks.move(to: CGPoint(x: from.0, y: from.1))
        knocks.addLine(to: CGPoint(x: to.0, y: to.1))
      }
      context.stroke(knocks, with: shading, style: StrokeStyle(lineWidth: 3.75, lineCap: .round))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
