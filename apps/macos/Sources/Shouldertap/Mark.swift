import AppKit

/// The Shouldertap mark (DESIGN.md, "The mark"): a frame whose top-right
/// corner is one big round shoulder, with three knock marks landing on it.
/// Drawn natively from the SVG geometry so it stays crisp at any size.
enum ShouldertapMark {
  static let frameWidth: CGFloat = 5
  static let knockWidth: CGFloat = 3.75

  /// Everything the strokes touch, in the SVG's units (y down), including the
  /// round caps. Fitting this box keeps the frame in the same place whether or
  /// not the knock marks are drawn.
  static let bounds = NSRect(x: -2.5, y: -11.525, width: 44.025, height: 46.025)

  /// The shoulder point the knock marks radiate from; they scale around it.
  static let knockOrigin = NSPoint(x: 23.21, y: 6.79)

  static let knocks: [(from: NSPoint, to: NSPoint)] = [
    (NSPoint(x: 26.8, y: -3.08), NSPoint(x: 29.19, y: -9.65)),
    (NSPoint(x: 30.63, y: -0.63), NSPoint(x: 35.58, y: -5.58)),
    (NSPoint(x: 33.08, y: 3.2), NSPoint(x: 39.65, y: 0.81)),
  ]

  static func framePath() -> NSBezierPath {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: 4, y: 0))
    path.curve(
      to: NSPoint(x: 30, y: 27.5), controlPoint1: NSPoint(x: 23.59, y: 0),
      controlPoint2: NSPoint(x: 30, y: 6.41))
    path.line(to: NSPoint(x: 30, y: 28))
    path.curve(
      to: NSPoint(x: 26, y: 32), controlPoint1: NSPoint(x: 30, y: 31.07),
      controlPoint2: NSPoint(x: 29.07, y: 32))
    path.line(to: NSPoint(x: 4, y: 32))
    path.curve(
      to: NSPoint(x: 0, y: 28), controlPoint1: NSPoint(x: 0.93, y: 32),
      controlPoint2: NSPoint(x: 0, y: 31.07))
    path.line(to: NSPoint(x: 0, y: 4))
    path.curve(
      to: NSPoint(x: 4, y: 0), controlPoint1: NSPoint(x: 0, y: 0.93),
      controlPoint2: NSPoint(x: 0.93, y: 0))
    path.close()
    return path
  }

  /// One knock mark's state: `scale` around `knockOrigin` and `opacity`.
  struct Knock {
    var scale: CGFloat = 1
    var opacity: CGFloat = 1

    static let shown = Knock()
    static let hidden = Knock(scale: 0.4, opacity: 0)
  }

  /// Draws the mark into `rect` of a context whose y axis points down
  /// (a flipped view or `NSImage(size:flipped: true)`).
  static func draw(in rect: NSRect, color: NSColor, knocks states: [Knock]) {
    let scale = min(rect.width / bounds.width, rect.height / bounds.height)
    let transform = affine(
      CGAffineTransform(translationX: rect.midX, y: rect.midY)
        .scaledBy(x: scale, y: scale)
        .translatedBy(x: -bounds.midX, y: -bounds.midY))

    color.setStroke()
    let frame = framePath()
    frame.transform(using: transform)
    frame.lineWidth = frameWidth * scale
    frame.lineCapStyle = .round
    frame.lineJoinStyle = .round
    frame.stroke()

    for (index, knock) in knocks.enumerated() {
      let state = index < states.count ? states[index] : .shown
      guard state.opacity > 0.001 else { continue }
      let line = NSBezierPath()
      line.move(to: knock.from)
      line.line(to: knock.to)
      let around = affine(
        CGAffineTransform(translationX: knockOrigin.x, y: knockOrigin.y)
          .scaledBy(x: state.scale, y: state.scale)
          .translatedBy(x: -knockOrigin.x, y: -knockOrigin.y))
      line.transform(using: around)
      line.transform(using: transform)
      line.lineWidth = knockWidth * scale * state.scale
      line.lineCapStyle = .round
      color.withAlphaComponent(state.opacity).setStroke()
      line.stroke()
    }
  }

  private static func affine(_ t: CGAffineTransform) -> AffineTransform {
    AffineTransform(m11: t.a, m12: t.b, m21: t.c, m22: t.d, tX: t.tx, tY: t.ty)
  }

  /// A template image for the menu bar (18pt), optionally with knock marks.
  static func templateImage(size: CGFloat = 18, knocks states: [Knock]) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      // A hair of inset keeps round caps off the image edge.
      draw(in: rect.insetBy(dx: 0.5, dy: 0.5), color: .black, knocks: states)
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Shouldertap"
    return image
  }

  /// The knock (DESIGN.md, "Motion"): each mark pops in twice over 900ms,
  /// staggered 60ms. `elapsed` is seconds since the knock started.
  static func knockStates(elapsed: TimeInterval) -> [Knock] {
    (0..<knocks.count).map { index in
      let t = (elapsed - Double(index) * 0.06) / 0.9
      return knockFrame(t)
    }
  }

  static let knockDuration: TimeInterval = 0.9 + 0.06 * 2

  // Keyframes: hidden at 0% and 44%, shown at 14–30% and from 58%.
  private static func knockFrame(_ t: Double) -> Knock {
    switch t {
    case ..<0: return .hidden
    case ..<0.14: return pop(t / 0.14)
    case ..<0.30: return .shown
    case ..<0.44: return fade(1 - (t - 0.30) / 0.14)
    case ..<0.58: return pop((t - 0.44) / 0.14)
    default: return .shown
    }
  }

  /// Hidden to shown with a little overshoot, like cubic-bezier(.2, .9, .3, 1.2).
  private static func pop(_ p: Double) -> Knock {
    let c1 = 1.70158 * 0.6
    let c3 = c1 + 1
    let eased = 1 + c3 * pow(p - 1, 3) + c1 * pow(p - 1, 2)
    return Knock(scale: 0.4 + 0.6 * CGFloat(eased), opacity: CGFloat(min(1, p * 1.6)))
  }

  private static func fade(_ p: Double) -> Knock {
    Knock(scale: 0.4 + 0.6 * CGFloat(p), opacity: CGFloat(p))
  }
}
