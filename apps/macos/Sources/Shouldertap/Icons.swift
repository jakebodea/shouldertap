import SwiftUI

/// The standard glyphs (docs/design.md, "Icons"): Hugeicons stroke icons,
/// drawn from their original 24×24 path data so they match the web exactly
/// without shipping an icon library.
enum Icon: CaseIterable {
  case onIt, in10, reply, send, back, invite, mac, addMac, remove, copy, close

  fileprivate var svg: [String] {
    switch self {
    case .onIt: ["M5 14L8.5 17.5L19 6.5"]
    case .in10: ["circle 12 12 10", "M12 8V12L14 14"]
    case .reply:
      [
        "M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12Z",
        "M12.1257 12H12.0007M8.125 12H8M16.125 12H16",
      ]
    case .send:
      [
        "M21.0477 3.05293C18.8697 0.707363 2.48648 6.4532 2.50001 8.551C2.51535 10.9299 8.89809 11.6617 10.6672 12.1581C11.7311 12.4565 12.016 12.7625 12.2613 13.8781C13.3723 18.9305 13.9301 21.4435 15.2014 21.4996C17.2278 21.5892 23.1733 5.342 21.0477 3.05293Z",
        "M11.4999 12.5L14.9999 9",
      ]
    case .back: ["M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18"]
    case .invite:
      [
        "M3 20.5002C3.28417 16.8058 6.3 13.7193 10.0008 13.5379C10.3134 13.5226 10.6446 13.5097 11 13.5L11.995 13.5663C12.6939 13.6129 13.3665 13.7543 14 13.9777",
        "M18 15.5V21.5M21 18.5L15 18.5",
        "circle 11 6.5 4",
      ]
    case .mac:
      [
        "M14 21H16M14 21C13.1716 21 12.5 20.3284 12.5 19.5V17L12 17M14 21H10M10 21H8M10 21C10.8284 21 11.5 20.3284 11.5 19.5V17L12 17M12 17V21",
        "M16 3H8C5.17157 3 3.75736 3 2.87868 3.87868C2 4.75736 2 6.17157 2 9V11C2 13.8284 2 15.2426 2.87868 16.1213C3.75736 17 5.17157 17 8 17H16C18.8284 17 20.2426 17 21.1213 16.1213C22 15.2426 22 13.8284 22 11V9C22 6.17157 22 4.75736 21.1213 3.87868C20.2426 3 18.8284 3 16 3Z",
      ]
    case .addMac:
      [
        "M9.14339 10.691L9.35031 10.4841C11.329 8.50532 14.5372 8.50532 16.5159 10.4841C18.4947 12.4628 18.4947 15.671 16.5159 17.6497L13.6497 20.5159C11.671 22.4947 8.46279 22.4947 6.48405 20.5159C4.50532 18.5372 4.50532 15.329 6.48405 13.3503L6.9484 12.886",
        "M17.0516 11.114L17.5159 10.6497C19.4947 8.67095 19.4947 5.46279 17.5159 3.48405C15.5372 1.50532 12.329 1.50532 10.3503 3.48405L7.48405 6.35031C5.50532 8.32904 5.50532 11.5372 7.48405 13.5159C9.46279 15.4947 12.671 15.4947 14.6497 13.5159L14.8566 13.309",
      ]
    case .remove:
      [
        "M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5",
        "M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5",
        "M9.5 16.5L9.5 10.5",
        "M14.5 16.5L14.5 10.5",
      ]
    case .copy:
      [
        "M7.5 14.5C7.5 11.2002 7.5 9.55025 8.52513 8.52513C9.55025 7.5 11.2002 7.5 14.5 7.5C17.7998 7.5 19.4497 7.5 20.4749 8.52513C21.5 9.55025 21.5 11.2002 21.5 14.5C21.5 17.7998 21.5 19.4497 20.4749 20.4749C19.4497 21.5 17.7998 21.5 14.5 21.5C11.2002 21.5 9.55025 21.5 8.52513 20.4749C7.5 19.4497 7.5 17.7998 7.5 14.5Z",
        "M7.5 16.5C6.10355 16.5 5.40533 16.5 4.84402 16.3036C3.83866 15.9518 3.0482 15.1613 2.69641 14.156C2.5 13.5947 2.5 12.8964 2.5 11.5V9.5C2.5 6.20017 2.5 4.55025 3.52513 3.52513C4.55025 2.5 6.20017 2.5 9.5 2.5H11.5C12.8964 2.5 13.5947 2.5 14.156 2.69641C15.1613 3.0482 15.9518 3.83866 16.3036 4.84402C16.5 5.40533 16.5 6.10355 16.5 7.5",
      ]
    case .close: ["M19 5L5 19M5 5L19 19"]
    }
  }

  /// Parsed once per icon, in the 24×24 design space.
  @MainActor fileprivate static var cache: [Icon: Path] = [:]

  @MainActor fileprivate var path: Path {
    if let cached = Self.cache[self] { return cached }
    var path = Path()
    for element in svg { SVGPath.append(element, to: &path) }
    Self.cache[self] = path
    return path
  }
}

/// A Hugeicons glyph at `size` points, 1.5 stroke at the 24pt design size.
struct IconView: View {
  let icon: Icon
  var size: CGFloat = 20

  var body: some View {
    IconShape(path: icon.path)
      .stroke(style: StrokeStyle(lineWidth: 1.5 * size / 24, lineCap: .round, lineJoin: .round))
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

private struct IconShape: Shape {
  let path: Path

  func path(in rect: CGRect) -> Path {
    let scale = min(rect.width, rect.height) / 24
    return path.applying(
      CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: scale, y: scale))
  }
}

/// The small subset of SVG path syntax Hugeicons uses: absolute M, L, H, V,
/// C and Z, plus `circle cx cy r` for their circle elements.
private enum SVGPath {
  static func append(_ source: String, to path: inout Path) {
    if source.hasPrefix("circle ") {
      let n = source.split(separator: " ").dropFirst().compactMap { Double($0) }
      path.addEllipse(in: CGRect(x: n[0] - n[2], y: n[1] - n[2], width: n[2] * 2, height: n[2] * 2))
      return
    }
    var scanner = Tokens(source)
    var current = CGPoint.zero
    var start = CGPoint.zero
    var command: Character = "M"
    while let token = scanner.next() {
      if case let .command(c) = token { command = c } else { scanner.pushBack(token) }
      switch command {
      case "M":
        current = CGPoint(x: scanner.number(), y: scanner.number())
        start = current
        path.move(to: current)
        command = "L"  // Implicit lineto after a moveto's first pair.
      case "L":
        current = CGPoint(x: scanner.number(), y: scanner.number())
        path.addLine(to: current)
      case "H":
        current.x = scanner.number()
        path.addLine(to: current)
      case "V":
        current.y = scanner.number()
        path.addLine(to: current)
      case "C":
        let c1 = CGPoint(x: scanner.number(), y: scanner.number())
        let c2 = CGPoint(x: scanner.number(), y: scanner.number())
        current = CGPoint(x: scanner.number(), y: scanner.number())
        path.addCurve(to: current, control1: c1, control2: c2)
      case "Z":
        path.closeSubpath()
        current = start
      default:
        return
      }
    }
  }

  private enum Token {
    case command(Character)
    case number(Double)
  }

  private struct Tokens {
    private let chars: [Character]
    private var index = 0
    private var pending: Token?

    init(_ source: String) { chars = Array(source) }

    mutating func pushBack(_ token: Token) { pending = token }

    mutating func number() -> Double {
      if case let .number(value)? = next() { return value }
      return 0
    }

    mutating func next() -> Token? {
      if let pending {
        self.pending = nil
        return pending
      }
      while index < chars.count, chars[index] == " " || chars[index] == "," { index += 1 }
      guard index < chars.count else { return nil }
      let c = chars[index]
      if c.isLetter {
        index += 1
        return .command(c)
      }
      var end = index + 1
      while end < chars.count, chars[end].isNumber || chars[end] == "." { end += 1 }
      defer { index = end }
      return .number(Double(String(chars[index..<end])) ?? 0)
    }
  }
}
