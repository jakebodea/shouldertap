// Draws the DMG window background: paper, a line of instruction, and a
// cobalt arrow from the app to Applications (docs/design.md). Writes
// background.png and background@2x.png into the given directory; the release
// script combines them into one HiDPI TIFF. Used by scripts/release-mac.sh.
//
//   swift scripts/dmg-background.swift <out-dir>
//
// Keep `size` and the icon centers in step with the Finder layout in
// scripts/release-mac.sh.
import AppKit

let size = NSSize(width: 660, height: 400)
let appCenter = NSPoint(x: 170, y: 214)
let applicationsCenter = NSPoint(x: 490, y: 214)

let paper = NSColor(srgbRed: 0xf6 / 255, green: 0xf5 / 255, blue: 0xf1 / 255, alpha: 1)
let tone = NSColor(srgbRed: 0x6f / 255, green: 0x6e / 255, blue: 0x69 / 255, alpha: 1)
let ink = NSColor(srgbRed: 0x16 / 255, green: 0x16 / 255, blue: 0x16 / 255, alpha: 1)
let cobalt = NSColor(srgbRed: 0x23 / 255, green: 0x40 / 255, blue: 0xc8 / 255, alpha: 1)

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
for name in ["BricolageGrotesque-Bold", "BricolageGrotesque-Medium"] {
  let url = here.appending(path: "../Resources/Fonts/\(name).ttf").standardizedFileURL
  CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
}

func font(_ name: String, _ size: CGFloat) -> NSFont {
  NSFont(name: name, size: size) ?? .systemFont(ofSize: size, weight: .bold)
}

func drawCentered(_ string: String, font: NSFont, color: NSColor, tracking: CGFloat, y: CGFloat) {
  let text = NSAttributedString(
    string: string, attributes: [.font: font, .foregroundColor: color, .kern: tracking * font.pointSize])
  let width = text.size().width
  text.draw(at: NSPoint(x: (size.width - width) / 2, y: y))
}

func render(scale: CGFloat) -> Data {
  let pixels = NSSize(width: size.width * scale, height: size.height * scale)
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(pixels.width), pixelsHigh: Int(pixels.height),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = size
  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  NSGraphicsContext.current = context
  // Finder places icons from the top left, so draw with y pointing down.
  context.cgContext.translateBy(x: 0, y: size.height)
  context.cgContext.scaleBy(x: 1, y: -1)
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context.cgContext, flipped: true)

  paper.setFill()
  NSRect(origin: .zero, size: size).fill()

  drawCentered(
    "Drag Shouldertap into Applications", font: font("BricolageGrotesque-Bold", 24), color: ink,
    tracking: -0.02, y: 44)

  // The arrow: a shallow arc between the icons, its head in round joins like the mark.
  let from = NSPoint(x: appCenter.x + 92, y: appCenter.y - 4)
  let to = NSPoint(x: applicationsCenter.x - 92, y: applicationsCenter.y - 4)
  let arc = NSBezierPath()
  arc.move(to: from)
  arc.curve(
    to: to, controlPoint1: NSPoint(x: from.x + 40, y: from.y - 34),
    controlPoint2: NSPoint(x: to.x - 40, y: to.y - 34))
  arc.lineWidth = 5
  arc.lineCapStyle = .round
  cobalt.setStroke()
  arc.stroke()
  // Barbs 18pt long, 38° either side of the curve's direction where it lands.
  let heading = atan2(34.0, 40.0)
  let barb = { (turn: Double) in
    NSPoint(x: to.x - 18 * cos(heading + turn), y: to.y - 18 * sin(heading + turn))
  }
  let head = NSBezierPath()
  head.move(to: barb(0.66))
  head.line(to: to)
  head.line(to: barb(-0.66))
  head.lineWidth = 5
  head.lineCapStyle = .round
  head.lineJoinStyle = .round
  head.stroke()

  drawCentered(
    "Then open it. It lives in your menu bar.", font: font("BricolageGrotesque-Medium", 14), color: tone,
    tracking: 0, y: 336)

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

let out = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try render(scale: 1).write(to: out.appending(path: "background.png"))
try render(scale: 2).write(to: out.appending(path: "background@2x.png"))
