import ShouldertapCore
import SwiftUI

/// Redeem a sender invite: the link (pasted or opened), your name, and the
/// color that frames your taps on their Mac. Mirrors apps/web/src/routes/join.tsx.
struct PairView: View {
  let store: SenderStore
  var isSheet = false
  let onPaired: (SenderSession) -> Void

  @State private var inviteText: String
  @State private var name: String
  @State private var color: PersonColor = .cobalt
  @State private var pending = false
  @State private var error: String?
  @State private var scanning = false
  @Environment(\.dismiss) private var dismiss

  init(store: SenderStore, invite: String, isSheet: Bool = false, onPaired: @escaping (SenderSession) -> Void) {
    self.store = store
    self.isSheet = isSheet
    self.onPaired = onPaired
    _inviteText = State(initialValue: invite)
    // Pairing with another person reuses the name you gave the first.
    _name = State(initialValue: store.sessions.last?.pairing.senderName ?? "")
  }

  private var code: String? { inviteCode(from: inviteText) }
  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var canSubmit: Bool { code != nil && !trimmedName.isEmpty && !pending }

  var body: some View {
    Frame(color: color) {
      HStack {
        MarkView(size: 36)
        Spacer()
        if isSheet {
          Button("Cancel") { dismiss() }
            .buttonStyle(PillStyle(small: true))
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        Text(code == nil ? "Pair with someone" : "You're invited")
          .font(Bricolage.extraBold(34))
          .tracking(-1.2)
        Text(
          code == nil
            ? "Scan the invite QR code on their Mac, or paste the invite link they sent you. Your taps cover their Mac screens until they answer."
            : "Pair this phone to send taps. They cover the other person's Mac screens until they answer."
        )
        .font(Bricolage.medium(17))
        .foregroundStyle(Paper.tone)
      }

      if code == nil {
        if scanning {
          VStack(spacing: 12) {
            QRScanner(onScan: scanned)
            Button("Cancel") { scanning = false }
              .buttonStyle(PillStyle())
              .accessibilityIdentifier("scan-cancel")
          }
        } else {
          Button {
            scanning = true
          } label: {
            Label("Scan QR code", systemImage: "qrcode.viewfinder")
          }
          .buttonStyle(PillStyle(color: .graphite))
          .accessibilityIdentifier("scan-button")
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("Invite link").font(Bricolage.bold(14, relativeTo: .subheadline))
        HStack(spacing: 8) {
          TextField("shouldertap.app/join#…", text: $inviteText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .accessibilityIdentifier("invite-field")
            .field()
          PasteButton(payloadType: String.self) { strings in
            if let first = strings.first { inviteText = first }
          }
          .labelStyle(.iconOnly)
          .buttonBorderShape(.capsule)
          .tint(color.base)
        }
        if !inviteText.isEmpty && code == nil {
          Text("That doesn't look like a Shouldertap invite link.")
            .font(Bricolage.medium(14)).foregroundStyle(.red)
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("Your name").font(Bricolage.bold(14, relativeTo: .subheadline))
        TextField("e.g. Sam", text: $name)
          .textContentType(.givenName)
          .submitLabel(.done)
          .onChange(of: name) { _, value in
            if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
          }
          .accessibilityIdentifier("name-field")
          .field()
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Your color").font(Bricolage.bold(14, relativeTo: .subheadline))
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 10) {
          ForEach(PersonColor.allCases, id: \.self) { option in
            Button {
              withAnimation(.easeInOut(duration: 0.3)) { color = option }
            } label: {
              Circle()
                .fill(option.base)
                .overlay {
                  if option == color {
                    IconView(icon: .onIt, size: 22).foregroundStyle(option.ink)
                  }
                }
                .overlay(Circle().strokeBorder(Paper.ink.opacity(option == color ? 0.9 : 0), lineWidth: 2).padding(-4))
                .frame(height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(option.label)
            .accessibilityAddTraits(option == color ? .isSelected : [])
            .accessibilityIdentifier("color-\(option.rawValue)")
          }
        }
        Text("Frames your taps on their screen, so they know it's you from across the room.")
          .font(Bricolage.medium(14)).foregroundStyle(Paper.tone)
      }

      Preview(name: trimmedName.isEmpty ? "You" : trimmedName, color: color)

      if let error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }

      Button {
        Task { await pair() }
      } label: {
        if pending { ProgressView().tint(color.ink) } else { Text("Pair this phone") }
      }
      .buttonStyle(PillStyle(color: color))
      .disabled(!canSubmit)
      .accessibilityIdentifier("pair-button")
    }
  }

  /// Takes a scanned invite link (https://shouldertap.app/join#… or
  /// shouldertap://join#…); any other QR code is rejected.
  private func scanned(_ value: String) -> Bool {
    guard let url = URL(string: value), url.path == "/join" || url.host == "join",
      inviteCode(from: value) != nil
    else { return false }
    inviteText = value
    scanning = false
    return true
  }

  private func pair() async {
    pending = true
    error = nil
    defer { pending = false }
    do {
      let session = try await store.pair(invite: inviteText, name: trimmedName, color: color)
      onPaired(session)
    } catch let failure as APIError where failure.code != .network {
      error = failure.message
    } catch let failure as APIError {
      error = failure.errorDescription
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// How a tap from you looks on their Mac: your color as the frame.
private struct Preview: View {
  let name: String
  let color: PersonColor

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(name).font(Bricolage.bold(13)).foregroundStyle(color.ink).padding(.horizontal, 6)
      Text("Dinner's ready")
        .font(Bricolage.extraBold(26))
        .tracking(-1)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(14)
        .background(Paper.paper, in: .rect(cornerRadius: 14, style: .continuous))
        .foregroundStyle(Paper.ink)
    }
    .padding(8)
    .background(color.base, in: .rect(cornerRadius: 20, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Preview of a tap from \(name)")
  }
}
