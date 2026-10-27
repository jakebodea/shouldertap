import CoreGraphics
import Foundation

// Prints the id of the on-screen window that process <pid> owns at <width> × <height> points,
// so capture-pc.sh can `screencapture -l` that window alone.
let arguments = CommandLine.arguments
guard arguments.count == 4, let pid = Int(arguments[1]), let width = Double(arguments[2]), let height = Double(arguments[3]) else {
  FileHandle.standardError.write("usage: window-id <pid> <width> <height>\n".data(using: .utf8)!)
  exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows where window[kCGWindowOwnerPID as String] as? Int == pid {
  guard let bounds = window[kCGWindowBounds as String] as? [String: Double],
    abs((bounds["Width"] ?? 0) - width) < 1, abs((bounds["Height"] ?? 0) - height) < 1,
    let id = window[kCGWindowNumber as String] as? Int
  else { continue }
  print(id)
  exit(0)
}
exit(1)
