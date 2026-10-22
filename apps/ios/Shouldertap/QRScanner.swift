@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// A live camera view that decodes QR codes, asking for camera access first.
/// `onScan` gets each new decoded value and returns whether it was accepted;
/// rejected values (some other QR code) keep the camera running.
/// Mirrors apps/web/src/components/qr-scanner.tsx.
struct QRScanner: View {
  var copy = ScanCopy.invite
  let onScan: (String) -> Bool

  @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
  @State private var rejected = false
  @Environment(\.openURL) private var openURL

  private var live: Bool { access == .authorized && AVCaptureDevice.default(for: .video) != nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack {
        Color.black
        switch access {
        case .authorized where live:
          CameraView { value in
            let accepted = onScan(value)
            rejected = !accepted
            if accepted { UINotificationFeedbackGenerator().notificationOccurred(.success) }
          }
          RoundedRectangle(cornerRadius: 24, style: .continuous)
            .strokeBorder(.white.opacity(0.85), lineWidth: 3)
            .padding(48)
            .allowsHitTesting(false)
        case .authorized:
          notice(copy.noCamera)
        case .notDetermined:
          ProgressView().tint(.white)
            .task {
              let granted = await AVCaptureDevice.requestAccess(for: .video)
              access = granted ? .authorized : .denied
            }
        default:
          VStack(spacing: 14) {
            notice(copy.cameraOff)
            Button("Open Settings") {
              if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .font(Bricolage.bold(15))
            .foregroundStyle(.black)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(.white, in: .capsule)
          }
        }
      }
      .aspectRatio(1, contentMode: .fit)
      .clipShape(.rect(cornerRadius: 20, style: .continuous))
      .accessibilityElement(children: .contain)
      .accessibilityLabel(copy.cameraLabel)

      if live {
        Text(rejected ? copy.rejected : copy.hint)
          .font(Bricolage.medium(14))
          .foregroundStyle(rejected ? .red : Paper.tone)
      }
    }
  }

  private func notice(_ text: String) -> some View {
    Text(text)
      .font(Bricolage.medium(15))
      .foregroundStyle(.white)
      .multilineTextAlignment(.center)
      .padding(24)
  }
}

/// What the scanner says, for what it's scanning.
struct ScanCopy {
  /// On the frame's top edge.
  let title: String
  let hint: String
  /// Some other QR code.
  let rejected: String
  let noCamera: String
  let cameraOff: String
  let cameraLabel: String

  /// Someone's invite, or a computer's sign-in code (routed to its confirmation).
  static let invite = ScanCopy(
    title: "Scan their invite",
    hint: "Point the camera at the QR code on their Mac.",
    rejected: "That QR code isn't a Shouldertap invite.",
    noCamera: "This device has no camera. Paste the invite link instead.",
    cameraOff: "Camera access is off. Turn it on in Settings, or paste the invite link instead.",
    cameraLabel: "Camera view for scanning the invite QR code")

  /// Signed out: the code a signed-in computer shows under "Sign in on your phone".
  static let signIn = ScanCopy(
    title: "Scan from your computer",
    hint: "Point the camera at the QR code on your computer.",
    rejected: "That QR code isn't a Shouldertap sign-in code.",
    noCamera: "This device has no camera. Sign in with your email instead.",
    cameraOff: "Camera access is off. Turn it on in Settings, or sign in with your email instead.",
    cameraLabel: "Camera view for scanning the sign-in QR code")

  /// Signed in: the code a signed-out computer shows under "Sign in with your phone".
  static let computer = ScanCopy(
    title: "Sign in on a computer",
    hint: "Point the camera at the QR code on your computer.",
    rejected: "That QR code isn't a Shouldertap sign-in code.",
    noCamera: "This device has no camera. Sign in on the computer with your email instead.",
    cameraOff: "Camera access is off. Turn it on in Settings, or sign in on the computer with your email instead.",
    cameraLabel: "Camera view for scanning the computer's QR code")
}

/// The capture session behind `QRScanner`: back camera in, QR metadata out.
private struct CameraView: UIViewRepresentable {
  let onValue: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onValue: onValue) }

  func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    view.previewLayer.session = context.coordinator.session
    view.previewLayer.videoGravity = .resizeAspectFill
    context.coordinator.start()
    return view
  }

  func updateUIView(_ view: PreviewView, context: Context) {
    context.coordinator.onValue = onValue
  }

  static func dismantleUIView(_ view: PreviewView, coordinator: Coordinator) {
    coordinator.stop()
  }

  final class PreviewView: UIView {
    override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
  }

  final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    let session = AVCaptureSession()
    var onValue: (String) -> Void
    private var last: String?
    // startRunning and stopRunning block, so they run off the main thread.
    private let queue = DispatchQueue(label: "app.shouldertap.iphone.camera")

    init(onValue: @escaping (String) -> Void) {
      self.onValue = onValue
      super.init()
      guard let camera = AVCaptureDevice.default(for: .video),
        let input = try? AVCaptureDeviceInput(device: camera),
        session.canAddInput(input)
      else { return }
      session.addInput(input)
      let output = AVCaptureMetadataOutput()
      guard session.canAddOutput(output) else { return }
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]
    }

    func start() { queue.async { [session] in session.startRunning() } }
    func stop() { queue.async { [session] in session.stopRunning() } }

    nonisolated func metadataOutput(
      _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection
    ) {
      let values = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
      MainActor.assumeIsolated {
        // The same code is reported every frame; only pass along new ones.
        guard let value = values.first, value != last else { return }
        last = value
        onValue(value)
      }
    }
  }
}
