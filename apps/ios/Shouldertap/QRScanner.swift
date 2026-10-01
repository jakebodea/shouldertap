@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// A live camera view that decodes QR codes, asking for camera access first.
/// `onScan` gets each new decoded value and returns whether it was accepted;
/// rejected values (some other QR code) keep the camera running.
/// Mirrors apps/web/src/components/qr-scanner.tsx.
struct QRScanner: View {
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
          notice("This device has no camera. Paste the invite link instead.")
        case .notDetermined:
          ProgressView().tint(.white)
            .task {
              let granted = await AVCaptureDevice.requestAccess(for: .video)
              access = granted ? .authorized : .denied
            }
        default:
          VStack(spacing: 14) {
            notice("Camera access is off. Turn it on in Settings, or paste the invite link instead.")
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
      .accessibilityLabel("Camera view for scanning the invite QR code")

      if live {
        Text(rejected ? "That QR code isn't a Shouldertap invite." : "Point the camera at the QR code on their Mac.")
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
    private let queue = DispatchQueue(label: "app.shouldertap.ios.camera")

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
