// Stamps an orange "DEBUG" band across each PNG in an iconset, in place, so
// debug builds never look like the installed app. Used by build.sh.
import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
for file in files where file.pathExtension == "png" {
  guard let source = NSImage(contentsOf: file),
    let rep = source.representations.first
  else { continue }
  let size = NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
  let image = NSImage(size: size, flipped: false) { rect in
    source.draw(in: rect)
    // macOS icon grid: an 824/1024 rounded square, centred. Keep the band in it.
    let body = rect.insetBy(dx: rect.width * 100 / 1024, dy: rect.height * 100 / 1024)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.height * 0.225).addClip()
    let band = NSRect(x: body.minX, y: body.minY, width: body.width, height: body.height * 0.26)
    NSColor.systemOrange.setFill()
    band.fill()
    let font = NSFont.systemFont(ofSize: band.height * 0.5, weight: .heavy)
    let text = NSAttributedString(string: "DEBUG", attributes: [.font: font, .foregroundColor: NSColor.white])
    let textSize = text.size()
    text.draw(at: NSPoint(x: rect.midX - textSize.width / 2, y: band.midY - textSize.height / 2))
    NSGraphicsContext.restoreGraphicsState()
    return true
  }
  guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
  else { continue }
  try png.write(to: file)
}
