import SwiftUI
import ShouldertapCore
import StoreKit

/// Your account: who you're signed in as, signing out, and deleting it.
/// Signing out keeps this iPhone's connections; the app asks you to sign in
/// again before going on.
struct AccountView: View {
  let account: AccountStore
  @State private var usStorefront = false
  @State private var confirmDeletion = false
  @State private var signingInComputer = false

  var body: some View {
    Form {
      Section("Signed in as") {
        Text(account.email ?? "Your account")
          .accessibilityIdentifier("account-email")
        Button("Sign out") { Task { await account.signOut() } }
          .accessibilityIdentifier("sign-out")
      }
      if account.signedIn {
        Section {
          Button {
            signingInComputer = true
          } label: {
            Label("Sign in on a computer", systemImage: "qrcode.viewfinder")
          }
          .accessibilityIdentifier("sign-in-computer")
        } footer: {
          Text("On your Mac, PC or browser, choose “Sign in with your phone” and scan the code it shows.")
        }
      }
      if usStorefront, account.checkoutEnabled {
        // Purchases happen on the web; this only opens the account page.
        Section("Patron") {
          Link("Become a patron or manage your membership",
            destination: account.server.appending(path: "/account").appending(queryItems: [URLQueryItem(name: "section", value: "patron")]))
        }
      }
      Section {
        Button("Delete account", role: .destructive) { confirmDeletion = true }
          .disabled(account.busy)
      } footer: {
        if let error = account.error { Text(error).foregroundStyle(.red) }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Paper.paper)
    .fullScreenCover(isPresented: $signingInComputer) {
      ComputerSignIn(account: account, color: account.me?.profile?.color ?? .cobalt) { signingInComputer = false }
    }
    .task {
      await account.refresh()
      usStorefront = await Storefront.current?.countryCode == "USA"
      for await storefront in Storefront.updates {
        usStorefront = storefront.countryCode == "USA"
      }
    }
    .confirmationDialog("Delete your account?", isPresented: $confirmDeletion, titleVisibility: .visible) {
      Button("Delete account", role: .destructive) { Task { await account.deleteAccount() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Deletes your account. The people you tap and your inbox stay on this iPhone until you remove them. Cancel an active membership first.")
    }
  }
}

/// Account, on the frame's top edge: a quiet ink icon like Help.
struct AccountButton: View {
  @Environment(\.inboxActions) private var actions

  var body: some View {
    Button(action: actions.account) {
      Image(systemName: "person.crop.circle").font(.system(size: 19))
    }
    .buttonStyle(FrameButtonStyle(iconOnly: true))
    .accessibilityLabel("Account")
    .accessibilityIdentifier("account-button")
  }
}
