import ShouldertapCore
import SwiftUI

// Signing a computer in from this iPhone (docs/onboarding.md, "Phone →
// computer"): a signed-out Mac, PC or browser shows a QR code of its device
// sign-in link; this phone scans it, says which kind of device it is and
// shows the code so you can check it against the screen, then approves.

/// Scanning a computer's code (when `scanned` is nil) and confirming it, in
/// your own color. Account → "Sign in on a computer", or any in-app scanner
/// that read one.
struct ComputerSignIn: View {
  let account: AccountStore
  let color: PersonColor
  /// The scanned `https://…/account/device?user_code=…`; nil scans first.
  var scanned: String?
  let onClose: () -> Void

  @State private var userCode: String?

  var body: some View {
    Group {
      if let userCode {
        ConfirmComputer(account: account, color: color, userCode: userCode, onClose: onClose)
          .transition(.opacity)
      } else {
        ScanScreen(color: color, copy: .computer, accepts: { deviceSignInCode(from: $0) != nil }) { value in
          withAnimation(.outExpo(0.5)) { userCode = deviceSignInCode(from: value) }
        }
        .transition(.opacity)
      }
    }
    .onAppear { userCode = scanned.flatMap(deviceSignInCode(from:)) }
  }
}

/// "Sign in on your Mac?" with the code, Approve and Cancel (which turns the
/// computer away).
private struct ConfirmComputer: View {
  let account: AccountStore
  let color: PersonColor
  let userCode: String
  let onClose: () -> Void

  private enum Phase: Equatable {
    case loading
    case asking(DeviceSignInReview)
    case approved(SignInDevice?)
    /// Expired, already answered, or not a code this account can see.
    case stale
  }

  @State private var phase = Phase.loading
  @State private var pending = false
  @State private var error: String?

  var body: some View {
    Frame(color: color) {
      VStack(spacing: 0) {
        FrameBar {
          Wordmark()
        } trailing: {
          Button(action: cancel) { IconView(icon: .close, size: 18) }
            .buttonStyle(FrameButtonStyle(iconOnly: true))
            .accessibilityLabel("Close")
            .accessibilityIdentifier("close-button")
        }
        page.onPaper()
      }
    }
    .task { await load() }
  }

  private var page: some View {
    Page {
      switch phase {
      case .loading:
        ProgressView().frame(maxWidth: .infinity, minHeight: 240)
      case .asking(let review):
        StepHeader(
          title: "Sign in on your \(name(review.device))?",
          text: "It will use your account, \(account.email ?? "this account"). Only continue if this code matches the screen in front of you.")
        Text(review.userCode)
          .font(Bricolage.extraBold(44).monospaced())
          .tracking(2)
          .frame(maxWidth: .infinity, minHeight: 96)
          .background(Paper.faint, in: .rect(cornerRadius: 20, style: .continuous))
          .accessibilityLabel("Code \(review.userCode.map(String.init).joined(separator: " "))")
          .accessibilityIdentifier("device-user-code")
      case .approved(let device):
        StepHeader(
          title: "Signed in on your \(name(device))",
          text: "It’s using your account now. You can put your phone away.")
      case .stale:
        StepHeader(
          title: "That code expired",
          text: "Show a new code on your computer and scan again.")
      }
      if let error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }
    } actions: {
      switch phase {
      case .asking:
        Button(action: approve) {
          if pending { ProgressView().tint(color.ink) } else { Text("Approve") }
        }
        .buttonStyle(PillStyle(color: color))
        .disabled(pending)
        .accessibilityIdentifier("device-approve")
        Button("Cancel", action: cancel)
          .buttonStyle(QuietStyle())
          .disabled(pending)
          .accessibilityIdentifier("device-cancel")
      case .approved, .stale:
        Button("Done", action: onClose)
          .buttonStyle(PillStyle(color: color))
          .accessibilityIdentifier("device-done")
      case .loading:
        EmptyView()
      }
    }
    .animation(.outExpo(0.5), value: phase)
  }

  private func name(_ device: SignInDevice?) -> String { device?.rawValue ?? "computer" }

  private func load() async {
    do {
      let review = try await account.reviewDeviceSignIn(userCode: userCode)
      phase = review.pending ? .asking(review) : .stale
    } catch let failure as AccountError where failure.status == 400 || failure.status == 404 {
      phase = .stale
    } catch {
      self.error = error.localizedDescription
      phase = .stale
    }
  }

  private func approve() {
    guard case .asking(let review) = phase else { return }
    pending = true
    error = nil
    Task {
      defer { pending = false }
      do {
        try await account.approveDeviceSignIn(userCode: review.userCode)
        phase = .approved(review.device)
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// Turns the computer away when it was asking; then closes either way.
  private func cancel() {
    if case .asking(let review) = phase {
      Task { try? await account.denyDeviceSignIn(userCode: review.userCode) }
    }
    onClose()
  }
}
