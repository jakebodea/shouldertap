import AppKit
import SwiftUI

/// How a theme sets its message: one face, a tight line height and tracking,
/// none of which SwiftUI's Text can express on macOS 14.
struct MessageStyle: Hashable {
  var fontName: String
  /// Line height as a multiple of the font size.
  var lineHeight: CGFloat
  /// Tracking in em.
  var tracking: CGFloat
  var color: NSColor
  var uppercase = false
  /// A soft glow drawn with the glyphs (Terminal's phosphor), as sRGB hex and
  /// a blur radius in em.
  var glow: (color: UInt32, radius: CGFloat)?

  static func == (a: Self, b: Self) -> Bool {
    a.fontName == b.fontName && a.lineHeight == b.lineHeight && a.tracking == b.tracking && a.color == b.color
      && a.uppercase == b.uppercase && a.glow?.color == b.glow?.color && a.glow?.radius == b.glow?.radius
  }

  func hash(into hasher: inout Hasher) {
    hasher.combine(fontName)
    hasher.combine(lineHeight)
    hasher.combine(tracking)
    hasher.combine(color)
    hasher.combine(uppercase)
    hasher.combine(glow?.color)
  }

  /// How far glyphs reach past a line box that is tighter than the font,
  /// above the first line and below the last.
  func overshoot(size: CGFloat) -> CGFloat {
    let font = NSFont(name: fontName, size: size) ?? .systemFont(ofSize: size)
    return ceil(max(0, (font.ascender - font.descender) - (size * lineHeight).rounded()) + size * 0.04)
  }

  /// `cursor` appends Terminal's block cursor (VT323 has no block glyph).
  func attributed(_ text: String, size: CGFloat, cursor: Bool = false) -> NSAttributedString {
    let font = NSFont(name: fontName, size: size) ?? .systemFont(ofSize: size, weight: .heavy)
    let paragraph = NSMutableParagraphStyle()
    let line = (size * lineHeight).rounded()
    paragraph.minimumLineHeight = line
    paragraph.maximumLineHeight = line
    // Words wrap; a word wider than the line (a long link) breaks inside it.
    paragraph.lineBreakMode = .byWordWrapping
    var attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .kern: tracking * size,
      .paragraphStyle: paragraph,
      .foregroundColor: color,
      // Center the glyphs in the tightened line box.
      .baselineOffset: (line - (font.ascender - font.descender)) / 2,
    ]
    if let glow {
      let shadow = NSShadow()
      shadow.shadowColor = NSColor(srgbHex: glow.color, alpha: 0.35)
      shadow.shadowBlurRadius = glow.radius * size
      shadow.shadowOffset = .zero
      attributes[.shadow] = shadow
    }
    let result = NSMutableAttributedString(string: uppercase ? text.uppercased() : text, attributes: attributes)
    if cursor {
      // 0.12em of space, then a 0.5em block.
      let gap = (size * 0.12).rounded()
      let block = CGSize(width: gap + (size * 0.5).rounded(), height: (size * 0.82).rounded())
      let image = NSImage(size: block, flipped: false) { rect in
        color.setFill()
        CGRect(x: gap, y: 0, width: rect.width - gap, height: rect.height).fill()
        return true
      }
      let attachment = NSTextAttachment()
      attachment.image = image
      attachment.bounds = CGRect(x: 0, y: -size * 0.06, width: block.width, height: block.height)
      let cursorRun = NSMutableAttributedString(attachment: attachment)
      cursorRun.addAttributes(attributes, range: NSRange(location: 0, length: cursorRun.length))
      result.append(cursorRun)
    }
    return result
  }
}

extension NSColor {
  convenience init(srgbHex hex: UInt32, alpha: CGFloat = 1) {
    self.init(
      srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
      blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
  }
}

/// Measures with the same TextKit stack the message is drawn with, so a fit
/// is a fit. Results are cached: SwiftUI re-runs bodies while you type a reply.
@MainActor
enum MessageFit {
  private struct Key: Hashable {
    var text: String
    var style: MessageStyle
    var width: CGFloat
    var height: CGFloat
    var preferred: CGFloat
    var minimum: CGFloat
  }
  private static var cache: [Key: CGFloat] = [:]

  /// The design curve shared with the Default overlay: biggest for a few
  /// words, smaller for a paragraph.
  static func preferred(_ text: String, max: CGFloat, min: CGFloat) -> CGFloat {
    let t = Swift.min(1, Swift.max(0, Double(text.count - 14) / 70))
    return (max - (max - min) * t.squareRoot()).rounded()
  }

  static func height(_ string: NSAttributedString, width: CGFloat) -> CGFloat {
    let storage = NSTextStorage(attributedString: string)
    let layout = NSLayoutManager()
    let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    layout.addTextContainer(container)
    storage.addLayoutManager(layout)
    layout.ensureLayout(for: container)
    return ceil(layout.usedRect(for: container).height)
  }

  /// The largest size from `preferred` down to `minimum` (in 2pt steps) at
  /// which the message fits `room`.
  static func size(
    _ text: String, style: MessageStyle, room: CGSize, preferred: CGFloat, minimum: CGFloat, cursor: Bool = false
  ) -> CGFloat {
    guard room.width > 1, room.height > 1 else { return minimum }
    let key = Key(
      text: cursor ? text + "\u{2588}" : text, style: style, width: room.width.rounded(), height: room.height.rounded(),
      preferred: preferred, minimum: minimum)
    if let size = cache[key] { return size }
    var size = preferred
    while size > minimum,
      height(style.attributed(text, size: size, cursor: cursor), width: room.width) + 2 * style.overshoot(size: size)
        > room.height
    {
      size -= 2
    }
    if cache.count > 64 { cache.removeAll() }
    cache[key] = max(size, minimum)
    return max(size, minimum)
  }
}

/// How a theme's words arrive. Every kind ends within about a second whatever
/// the length (staggers share a fixed budget), then the words are ordinary
/// selectable text. Reduced motion skips straight to the end.
enum WordEntrance: Equatable {
  /// Broadsheet: each word rises out of its own line mask.
  case rise
  /// Billboard: each word punches in, scaling down onto its final place.
  case punch
  /// Terminal: words print in steps; the trailing cursor blinks three times and stops.
  case print
  /// Note: each word is written left to right, line by line.
  case write

  var startDelay: Double {
    switch self {
    case .rise: 0.18
    case .punch: 0.26
    case .print: 0.30
    case .write: 0.36
    }
  }

  /// When the last word has finished arriving, for `count` words.
  func settled(count: Int, characters: Int) -> Double {
    switch self {
    case .rise: startDelay + Double(max(0, count - 1)) * stagger(count, 0.034, 0.42) + 0.56
    case .punch: startDelay + Double(max(0, count - 1)) * stagger(count, 0.07, 0.52) + 0.46
    case .print: startDelay + Double(max(0, count - 1)) * stagger(count, 0.055, 0.6)
    case .write: startDelay + min(0.9, Double(characters) * 0.022)
    }
  }
}

/// Spread a stagger over a fixed budget so long messages arrive as fast as short ones.
func stagger(_ count: Int, _ per: Double, _ budget: Double) -> Double {
  min(per, budget / Double(max(1, count - 1)))
}

/// The message as a non-editable, selectable NSTextView. On arrival each word
/// is drawn once into its own layer from this same layout and animated on the
/// render server (transform, opacity, mask bounds), so nothing is laid out per
/// frame and the settled text lands exactly where it was drawn.
struct ThemedMessage: NSViewRepresentable {
  let text: String
  let style: MessageStyle
  let size: CGFloat
  let entrance: WordEntrance
  let reduceMotion: Bool
  /// Terminal's block cursor after the words; not part of the spoken text.
  var cursor = false

  func makeNSView(context: Context) -> WordRevealView {
    let view = WordRevealView()
    view.setAccessibilityElement(true)
    view.setAccessibilityRole(.staticText)
    return view
  }

  func updateNSView(_ view: WordRevealView, context: Context) {
    view.setAccessibilityValue(text)
    view.setAccessibilityLabel(text)
    view.show(
      style.attributed(text, size: size, cursor: cursor), inset: style.overshoot(size: size),
      entrance: reduceMotion ? nil : entrance)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: WordRevealView, context: Context) -> CGSize? {
    let width = proposal.width ?? 1000
    return CGSize(
      width: width,
      height: MessageFit.height(style.attributed(text, size: size, cursor: cursor), width: width) + 2
        * style.overshoot(size: size))
  }
}

/// Draws the message itself from its own TextKit layout: a tight line box
/// would clip glyph tops inside an NSTextView. A clear-ink NSTextView with
/// the same layout sits on top, so the words can still be selected and copied.
final class WordRevealView: NSView {
  private let storage = NSTextStorage()
  private let ink = NSLayoutManager()
  private let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
  private let selectable: NSTextView
  private var shown: NSAttributedString?
  private var pending: WordEntrance?
  private var played = false
  /// While the words arrive as layers, the settled text isn't drawn.
  private var revealing = false
  private var words: CALayer?
  private var inset: CGFloat = 0

  override init(frame: NSRect) {
    container.lineFragmentPadding = 0
    ink.addTextContainer(container)
    storage.addLayoutManager(ink)
    selectable = NSTextView(frame: frame)
    selectable.isEditable = false
    selectable.isSelectable = true
    selectable.drawsBackground = false
    selectable.textContainer?.lineFragmentPadding = 0
    selectable.textContainerInset = .zero
    selectable.isVerticallyResizable = false
    selectable.isHorizontallyResizable = false
    selectable.setAccessibilityElement(false)
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .onSetNeedsDisplay
    addSubview(selectable)
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  func show(_ string: NSAttributedString, inset: CGFloat, entrance: WordEntrance?) {
    if self.inset != inset {
      self.inset = inset
      selectable.textContainerInset = CGSize(width: 0, height: inset)
      needsDisplay = true
    }
    if shown != string {
      shown = string
      storage.setAttributedString(string)
      selectable.textStorage?.setAttributedString(Self.clearInk(string))
      needsDisplay = true
    }
    // The entrance plays once per message; later updates (a resize, a reply
    // being typed elsewhere) just show the settled text.
    if !played {
      pending = entrance
      needsLayout = true
    }
  }

  /// The same text with invisible ink and no cursor: only selection shows.
  private static func clearInk(_ string: NSAttributedString) -> NSAttributedString {
    let copy = NSMutableAttributedString(attributedString: string)
    let attachments = (copy.string as NSString).range(of: "\u{FFFC}")
    if attachments.location != NSNotFound { copy.deleteCharacters(in: attachments) }
    let all = NSRange(location: 0, length: copy.length)
    copy.addAttribute(.foregroundColor, value: NSColor.clear, range: all)
    copy.removeAttribute(.shadow, range: all)
    return copy
  }

  override func layout() {
    super.layout()
    selectable.frame = bounds
    selectable.textContainer?.size = CGSize(width: bounds.width, height: .greatestFiniteMagnitude)
    if container.size.width != bounds.width {
      container.size = CGSize(width: bounds.width, height: .greatestFiniteMagnitude)
      needsDisplay = true
    }
    guard !played, bounds.width > 0, window != nil else { return }
    played = true
    if let pending { play(pending) }
  }

  override func draw(_ dirtyRect: NSRect) {
    guard !revealing else { return }
    ink.drawGlyphs(forGlyphRange: ink.glyphRange(for: container), at: CGPoint(x: 0, y: inset))
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    needsLayout = true
  }

  private func play(_ entrance: WordEntrance) {
    guard let layer else { return }
    let string = storage.string
    let layout = ink
    layout.ensureLayout(for: container)
    let scale = window?.backingScaleFactor ?? 2
    let holder = CALayer()
    holder.frame = bounds
    layer.addSublayer(holder)
    words = holder

    let ranges = wordRanges(in: string)
    let count = ranges.count
    let characters = string.count
    let now = CACurrentMediaTime()
    var writeAt = entrance.startDelay
    let writeScale = min(1, 0.9 / max(0.001, Double(ranges.reduce(0) { $0 + $1.length + 1 }) * 0.022))

    for (index, range) in ranges.enumerated() {
      let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
      // In view coordinates, grown to take in glyphs that reach past the line box.
      var rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        .offsetBy(dx: 0, dy: inset).insetBy(dx: -2, dy: -inset).integral
      rect = rect.intersection(bounds.insetBy(dx: -4, dy: 0))
      guard rect.width > 0, rect.height > 0 else { continue }
      let origin = CGPoint(x: -rect.minX, y: inset - rect.minY)
      let image = NSImage(size: rect.size, flipped: true) { _ in
        layout.drawGlyphs(forGlyphRange: glyphs, at: origin)
        return true
      }
      let word = CALayer()
      word.contents = image.layerContents(forContentsScale: scale)
      word.contentsScale = scale
      word.frame = rect
      let begin = now + entrance.startDelay

      switch entrance {
      case .rise:
        // Its own line mask: the word slides up into a clipped box.
        let clip = CALayer()
        clip.frame = rect.insetBy(dx: 0, dy: -rect.height * 0.07)
        clip.masksToBounds = true
        word.frame = CGRect(origin: CGPoint(x: 0, y: rect.height * 0.07), size: rect.size)
        clip.addSublayer(word)
        holder.addSublayer(clip)
        let rise = CABasicAnimation(keyPath: "transform.translation.y")
        rise.fromValue = rect.height * 1.08
        rise.toValue = 0
        rise.duration = 0.56
        rise.beginTime = begin + Double(index) * stagger(count, 0.034, 0.42)
        rise.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
        rise.fillMode = .backwards
        word.add(rise, forKey: "rise")
      case .punch:
        holder.addSublayer(word)
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0, 1, 1]
        fade.keyTimes = [0, 0.35, 1]
        let scaleDown = CABasicAnimation(keyPath: "transform.scale")
        scaleDown.fromValue = 1.12
        scaleDown.toValue = 1
        let drop = CABasicAnimation(keyPath: "transform.translation.y")
        drop.fromValue = rect.height * 0.24
        drop.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [fade, scaleDown, drop]
        group.duration = 0.46
        group.beginTime = begin + Double(index) * stagger(count, 0.07, 0.52)
        group.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
        group.fillMode = .backwards
        word.add(group, forKey: "punch")
      case .print:
        holder.addSublayer(word)
        let hidden = CABasicAnimation(keyPath: "opacity")
        hidden.fromValue = 0
        hidden.toValue = 0
        hidden.duration = 0.001
        hidden.beginTime = begin + Double(index) * stagger(count, 0.055, 0.6)
        hidden.fillMode = .backwards
        word.add(hidden, forKey: "print")
      case .write:
        // Written left to right: a mask widens across the word.
        let mask = CALayer()
        mask.backgroundColor = NSColor.black.cgColor
        mask.anchorPoint = CGPoint(x: 0, y: 0.5)
        mask.frame = CGRect(origin: .zero, size: rect.size)
        word.mask = mask
        holder.addSublayer(word)
        let duration = max(0.04, Double(range.length + 1) * 0.022) * writeScale
        let write = CABasicAnimation(keyPath: "transform.scale.x")
        write.fromValue = 0
        write.toValue = 1
        write.duration = duration
        write.beginTime = now + writeAt
        write.fillMode = .backwards
        mask.add(write, forKey: "write")
        writeAt += duration
      }
    }

    var settled = entrance.settled(count: count, characters: characters)
    if entrance == .print, let cursor = holder.sublayers?.last {
      // Three blinks, then the cursor stays lit: it never loops for attention.
      let blink = CAKeyframeAnimation(keyPath: "opacity")
      blink.values = [1, 0, 0, 1]
      blink.keyTimes = [0, 0.5, 0.99, 1]
      blink.calculationMode = .discrete
      blink.duration = 0.9
      blink.repeatCount = 3
      blink.beginTime = now + settled
      cursor.add(blink, forKey: "blink")
      settled += 2.7
    }
    revealing = true
    needsDisplay = true
    DispatchQueue.main.asyncAfter(deadline: .now() + settled + 0.05) { [weak self] in
      guard let self else { return }
      self.revealing = false
      self.needsDisplay = true
      self.words?.removeFromSuperlayer()
      self.words = nil
    }
  }

  /// Runs of non-whitespace, as character ranges.
  private func wordRanges(in string: String) -> [NSRange] {
    let ns = string as NSString
    var ranges: [NSRange] = []
    var start: Int?
    for index in 0..<ns.length {
      let unit = ns.character(at: index)
      // An attachment (Terminal's cursor) is a word of its own.
      if unit == 0xFFFC {
        if let begin = start { ranges.append(NSRange(location: begin, length: index - begin)) }
        ranges.append(NSRange(location: index, length: 1))
        start = nil
        continue
      }
      // A surrogate half is part of a word (emoji), never a space.
      let isSpace = UnicodeScalar(unit).map(CharacterSet.whitespacesAndNewlines.contains) ?? false
      if isSpace {
        if let begin = start { ranges.append(NSRange(location: begin, length: index - begin)) }
        start = nil
      } else if start == nil {
        start = index
      }
    }
    if let begin = start { ranges.append(NSRange(location: begin, length: ns.length - begin)) }
    return ranges
  }
}
