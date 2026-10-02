import ShouldertapCore
import SwiftUI

struct HelpButton: View {
  let store: SenderStore
  @State private var showing = false
  /// Run once the sheet is gone, so a cover can present after it.
  @State private var then: (() -> Void)?

  var body: some View {
    Button { showing = true } label: {
      Image(systemName: "info.circle").font(.system(size: 19))
    }
    .buttonStyle(FrameButtonStyle(iconOnly: true))
    .accessibilityLabel("Help and privacy")
    .accessibilityIdentifier("help-button")
    .sheet(
      isPresented: $showing,
      onDismiss: {
        then?()
        then = nil
      }
    ) { HelpView(store: store, then: $then) }
  }
}

struct HelpView: View {
  let store: SenderStore
  @Binding var then: (() -> Void)?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.inboxActions) private var inboxActions
  @Environment(ReceiverStore.self) private var inbox
  @State private var deleting: SenderSession?
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      List {
        Section("How Shouldertap works") {
          Text("Send a tap from your iPhone to someone who has invited you from their Mac. Their answer appears here when you open Shouldertap.")
          NavigationLink("Try a sample tap") { SampleTapView() }
            .accessibilityIdentifier("sample-tap")
          Text("The recipient needs Shouldertap for Mac and an active trial or unlocked inbox. This iPhone app is free for senders. Replies do not send push notifications.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        Section {
          if inbox.phase == .ready {
            Button("Open your Shouldertap") {
              then = inboxActions.open
              dismiss()
            }
            .accessibilityIdentifier("help-open-inbox")
          } else {
            Button("Link this iPhone to your Mac") {
              then = inboxActions.link
              dismiss()
            }
            .accessibilityIdentifier("help-link")
          }
        } header: {
          Text("Your own Shouldertap")
        } footer: {
          Text("If people tap you on your Mac, link this iPhone to invite and remove them, see your devices, and see what's come in. Taps keep showing up on your Mac.")
        }
        Section("Support and privacy") {
          Link("Support", destination: URL(string: "https://shouldertap.app/support")!)
          Link("Privacy Policy", destination: URL(string: "https://shouldertap.app/privacy")!)
          Link("Terms of Use", destination: URL(string: "https://shouldertap.app/terms")!)
          NavigationLink("Report a problem or abuse") { ReportView() }
        }
        if !store.sessions.isEmpty {
          Section {
            ForEach(store.sessions) { person in
              Button("Delete my data with \(person.pairing.recipientName)", role: .destructive) {
                deleting = person
              }
              .disabled(busy)
            }
          } header: {
            Text("Delete sender data")
          } footer: {
            Text("Deletes your pairing, name, messages and replies from the server and this phone. Repeat for each person you are paired with. You will need a new invite to reconnect. Recovery copies may remain for up to 30 days.")
          }
        }
        Section {
          Text("Shouldertap 1.0 for iPhone")
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Help and privacy")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .confirmationDialog(
        "Delete your sender data?",
        isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
        titleVisibility: .visible, presenting: deleting
      ) { person in
        Button("Delete my data", role: .destructive) {
          busy = true
          Task {
            defer { busy = false }
            do { try await store.deleteData(id: person.id) }
            catch { self.error = error.localizedDescription }
          }
        }
      } message: { person in
        Text("This permanently deletes your messages and replies with \(person.pairing.recipientName), and ends the pairing. It cannot be undone.")
      }
      .alert("Couldn't delete your data", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
        Button("OK", role: .cancel) {}
      } message: { Text(error ?? "") }
    }
    // Sheets inherit the frame bar's ink; use the sheet's own appearance.
    .foregroundStyle(Color.primary)
  }
}

/// A public, local walkthrough. It never sends messages or pretends to
/// connect to a real Mac; the normal app uses the live service separately.
struct SampleTapView: View {
  @State private var message = "Dinner's ready"
  @State private var sent = false
  @State private var response: TapResponse?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Label("Sample · no message is sent", systemImage: "sparkles")
          .font(.subheadline).foregroundStyle(.secondary)
        Text("Tap Jamie").font(Bricolage.extraBold(34))
          .accessibilityIdentifier("sample-title")
        TextField("Your message", text: $message, axis: .vertical)
          .lineLimit(2...4).field()
          .accessibilityIdentifier("sample-message")
          .onChange(of: message) { _, value in
            if value.count > maxTapLength { message = String(value.prefix(maxTapLength)) }
          }
        Button("Send sample tap") { sent = true; response = nil }
          .buttonStyle(PillStyle(color: .cobalt))
          .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("sample-send")
        if sent {
          Track(reached: response == nil ? 2 : 3, color: .cobalt, note: response == nil ? "On the sample Mac screen" : "Sample answered")
          VStack(alignment: .leading, spacing: 18) {
            Label("Jamie's Mac · sample screen", systemImage: "desktopcomputer")
              .font(.subheadline)
            Text(message).font(Bricolage.bold(27))
            Text("On a real Mac, this appears over every connected display until Jamie answers.")
              .font(.footnote).foregroundStyle(.secondary)
            HStack {
              Button("On it") { response = .onIt }
              Button("In 10 min") { response = .in10 }
            }
            .buttonStyle(.bordered)
          }
          .padding(20).background(Paper.faint, in: .rect(cornerRadius: 20))
          if let response {
            Label(response.label, systemImage: "checkmark.circle.fill")
              .font(Bricolage.bold(22)).accessibilityIdentifier("sample-answer")
            Text("In the live app, the answer appears in your recent taps and dismisses the message across the recipient's Macs.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }
      }
      .padding(24)
    }
    .background(Paper.paper)
    .navigationTitle("Try a sample tap")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct ReportView: View {
  var context = ""
  @State private var details = ""

  private var report: String { "Shouldertap report\n\(context)\n\n\(details)" }
  private var email: URL {
    var url = URLComponents()
    url.scheme = "mailto"
    url.path = "support@shouldertap.app"
    url.queryItems = [URLQueryItem(name: "subject", value: "Shouldertap abuse or support report"), URLQueryItem(name: "body", value: report)]
    return url.url!
  }

  var body: some View {
    Form {
      Section {
        Text("Describe what happened. Include only the information you want to share with Shouldertap support.")
        if !context.isEmpty { Text(context).font(.footnote).textSelection(.enabled) }
        TextEditor(text: $details).frame(minHeight: 140)
          .accessibilityLabel("Report details")
        Link("Email report", destination: email)
        ShareLink("Share report", item: report)
      } footer: {
        Text("Choose Email report and send it from your mail app to support@shouldertap.app. If you have no mail app configured, use Share report or email that address from another device. A report is sent only when you send it.")
      }
      Section("Stop contact") {
        Text("On iPhone, choose the person's avatar, then Unpair to stop receiving their replies. On Mac, remove a sender under Can tap you to stop their messages. They cannot reconnect without a new invite.")
      }
    }
    .navigationTitle("Report a problem")
  }
}
