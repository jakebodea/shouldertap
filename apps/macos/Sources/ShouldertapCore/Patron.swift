import Foundation
import Observation

// The sender's patron membership on this device (docs/patrons.md): optional
// support that lets the taps they send use a theme. Core use stays free.

/// `GET /account/patron/status`.
public struct AccountPatrons: Decodable, Sendable, Equatable {
  public struct Membership: Decodable, Sendable, Equatable {
    public struct Billing: Decodable, Sendable, Equatable {
      public var active: Bool
      /// `active`, `ending`, `payment_issue`, `none`, …
      public var status: String
      public var paidUntil: Timestamp?
    }
    public struct Status: Decodable, Sendable, Equatable { public var patron: Billing }
    public var id: String
    public var status: Status
  }
  public var memberships: [Membership]
  public var checkoutEnabled: Bool

  /// The membership that's paid up right now, if any.
  public var active: Membership? { memberships.first { $0.status.patron.active } }
}

/// When to mention membership after sending: after a few taps, then a while
/// later, then once more, and never for a patron or before checkout opens.
public enum PatronNudge {
  /// Taps sent from this device before each mention.
  public static let milestones = [5, 20, 50]

  public static func due(sent: Int, shown: Int, patron: Bool, checkoutEnabled: Bool) -> Bool {
    guard !patron, checkoutEnabled, milestones.indices.contains(shown) else { return false }
    return sent >= milestones[shown]
  }
}

/// This device's membership, chosen theme and the nudge counters. The key is
/// minted per device from the account (`/account/restore`) and kept in the
/// vault; the server checks it on every send.
@MainActor @Observable
public final class PatronStore {
  public private(set) var status: AccountPatrons?
  /// This device's own theme for new taps, to everyone with no theme chosen
  /// for them on the account (`choose(_:for:senders:)`). It only goes out
  /// while `active`.
  public var theme: TapTheme {
    didSet { defaults.set(theme.rawValue, forKey: Self.themeKey) }
  }
  public private(set) var sent: Int
  public private(set) var nudgesShown: Int
  public private(set) var busy = false
  public var error: String?

  public var active: Bool { status?.active != nil && key != nil }
  public var checkoutEnabled: Bool { status?.checkoutEnabled ?? account.checkoutEnabled }
  public var nudgeDue: Bool {
    PatronNudge.due(sent: sent, shown: nudgesShown, patron: active, checkoutEnabled: checkoutEnabled)
  }
  /// What the next tap carries. A held key goes along until status says the
  /// membership isn't active (the server checks it on every send), so taps
  /// sent at launch, before status loads, keep their theme.
  public var style: SendStyle {
    themesUnlocked ? SendStyle(theme: theme, patronKey: key) : SendStyle()
  }

  /// Paid themes can be chosen and sent: a held key counts until status says
  /// the membership isn't active.
  public var themesUnlocked: Bool { key != nil && (status == nil || active) }

  /// What taps to this person go in from here: the theme chosen for them on
  /// the account, else this device's own; Default while not a patron.
  public func theme(for pairing: SenderPairing) -> TapTheme {
    themesUnlocked ? (pairing.theme ?? theme) : .default
  }

  /// Chooses the theme new taps to one person go in, on every device on the
  /// account, keeping how they see you. Signed out, or for a person the
  /// account doesn't hold (an old pairing it never had), this device's own
  /// theme changes instead, as before themes were per person.
  public func choose(_ theme: TapTheme, for id: String, senders: SenderStore) async throws {
    guard let pairing = senders.session(id: id)?.pairing else { return }
    guard account.signedIn else { self.theme = theme; return }
    do {
      try await account.updateSendProfile(
        id, name: pairing.senderName, color: pairing.swatchColor, theme: theme, senders: senders)
    } catch let failure as AccountError where failure.status == 404 {
      self.theme = theme
    }
  }

  @ObservationIgnored private let account: AccountStore
  @ObservationIgnored private let vault: any CredentialVault
  @ObservationIgnored private let defaults: UserDefaults
  private var key: String?
  /// Bumped when the key is forgotten, so a refresh still in flight can't
  /// bring it back.
  private var generation = 0
  @ObservationIgnored private var refreshing: Task<Void, Never>?
  /// A refresh asked for while one ran: that one goes again after.
  @ObservationIgnored private var again = false

  private static let themeKey = "patron.theme"
  private static let sentKey = "patron.sent"
  private static let shownKey = "patron.nudgesShown"

  public init(account: AccountStore, vault: any CredentialVault, defaults: UserDefaults = .standard) {
    self.account = account
    self.vault = vault
    self.defaults = defaults
    key = vault.read()
    theme = defaults.string(forKey: Self.themeKey).flatMap(TapTheme.init(rawValue:)) ?? .default
    sent = defaults.integer(forKey: Self.sentKey)
    nudgesShown = defaults.integer(forKey: Self.shownKey)
    // The key is the account's: the next account to sign in here gets its own.
    account.whenSignedOut { [weak self] in self?.forgetKey() }
  }

  private func forgetKey() {
    generation += 1
    // Revoked too, or each sign-out would leave a live key toward the cap.
    if let key { revoke(key) }
    vault.delete()
    key = nil
    status = nil
  }

  /// Reads the account's memberships; a paid-up one without a key on this
  /// device gets one. Calls made while one runs wait for it, and it goes
  /// again, so a sign-in mid-refresh still gets its key.
  public func refresh() async {
    if let refreshing {
      again = true
      return await refreshing.value
    }
    // Cleared inside the task, right after its last check of `again`, so a
    // call arriving after that starts a new one.
    let task = Task {
      repeat {
        again = false
        await load()
      } while again
      refreshing = nil
    }
    refreshing = task
    await task.value
  }

  private func load() async {
    // Signed out, a key is a previous account's (or left from before sign-out
    // forgot keys).
    guard account.signedIn else { forgetKey(); return }
    let started = generation
    do {
      let current = try await account.patronStatus()
      guard generation == started else { return }
      if let membership = current.active, key == nil {
        let minted = try await account.restorePatronKey(id: membership.id)
        guard generation == started else { return revoke(minted) }
        try vault.write(minted)
        key = minted
      }
      status = current
    } catch is CancellationError {
    } catch {
      guard generation == started else { return }
      self.error = error.localizedDescription
    }
  }

  private func revoke(_ key: String) {
    let account = account
    Task { await account.forgetPatronKey(key) }
  }

  /// The checkout page, to open in the browser.
  public func checkoutURL() async -> URL? {
    await run { try await self.account.patronCheckout() }
  }

  public func manageURL() async -> URL? {
    await run { try await self.account.patronManage() }
  }

  /// The server accepted a tap from this device.
  public func recordSend() {
    sent += 1
    defaults.set(sent, forKey: Self.sentKey)
  }

  /// The nudge was answered either way; the next waits for its milestone.
  public func nudgeHandled() {
    nudgesShown += 1
    defaults.set(nudgesShown, forKey: Self.shownKey)
  }

  private func run<T>(_ action: @escaping () async throws -> T) async -> T? {
    guard !busy else { return nil }
    busy = true
    error = nil
    defer { busy = false }
    do { return try await action() } catch is CancellationError { return nil } catch {
      self.error = error.localizedDescription
      return nil
    }
  }
}
