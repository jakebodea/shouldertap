//! Patron themes from this PC (docs/design.md, "Tap themes"): a sender who
//! chips in sends their taps in Broadsheet, Billboard, Terminal or Note. The
//! membership belongs to the account; each device proves it with its own
//! patron key, restored once the account says the membership is active. The
//! Rust twin of the Mac's patron state in ShouldertapCore.
//!
//! `refresh` blocks; call it off the UI thread. Changes report through
//! `on_change`.

use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};

use crate::account::AccountStore;
use crate::api::{ApiError, ErrorCode};
use crate::models::*;
use crate::persistence::CredentialVault;
use crate::sender::{SenderPairing, SenderStore};

/// Successful sends from this device after which a nudge may show: the
/// first, second and third nudge, then never again.
pub const NUDGE_MILESTONES: [u32; 3] = [5, 20, 50];

/// Whether to ask, gently, after a send: never patrons, never while checkout
/// is closed, at most three times, each at its milestone.
pub fn nudge_due(sent: u32, shown: u32, patron: bool, checkout_enabled: bool) -> bool {
    !patron
        && checkout_enabled
        && NUDGE_MILESTONES
            .get(shown as usize)
            .is_some_and(|&milestone| sent >= milestone)
}

/// What this PC remembers between launches, beside the key in the vault.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatronSettings {
    /// The theme chosen to send in; only sent while a patron.
    #[serde(default)]
    pub theme: TapTheme,
    /// Taps the server accepted from this PC.
    #[serde(default)]
    pub sent: u32,
    /// Nudges dismissed or acted on.
    #[serde(default)]
    pub nudges_shown: u32,
}

/// Where the settings live (`patron.json` beside the other local files).
pub trait PatronPersistence: Send + Sync {
    fn load(&self) -> PatronSettings;
    fn save(&self, settings: &PatronSettings);
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PatronState {
    pub settings: PatronSettings,
    /// Some membership on the account is active.
    pub active: bool,
    /// New memberships can start here.
    pub checkout_enabled: bool,
    /// This device holds a patron key.
    pub has_key: bool,
    /// The active membership, or the first one: for "Renews …" / "Ends …".
    pub membership: Option<Patron>,
    /// The account has answered at least once since launch.
    pub loaded: bool,
}

impl PatronState {
    pub fn theme(&self) -> TapTheme {
        self.settings.theme
    }

    /// What a tap from this PC is sent in right now: this PC's own theme
    /// while a patron holding a key, Default otherwise.
    pub fn sending_theme(&self) -> TapTheme {
        if self.active && self.has_key {
            self.settings.theme
        } else {
            TapTheme::Default
        }
    }

    /// What taps to this person go in from this PC: the theme chosen for
    /// them on the account, else this PC's own; Default while not a patron
    /// holding a key.
    pub fn sending_theme_for(&self, pairing: &SenderPairing) -> TapTheme {
        if self.active && self.has_key {
            pairing.theme.unwrap_or(self.settings.theme)
        } else {
            TapTheme::Default
        }
    }

    /// Whether `theme` can be switched on here.
    pub fn can_use(&self, theme: TapTheme) -> bool {
        !theme.is_paid() || self.active
    }

    pub fn nudge_due(&self) -> bool {
        nudge_due(
            self.settings.sent,
            self.settings.nudges_shown,
            self.active,
            self.checkout_enabled,
        )
    }
}

pub struct PatronConfig {
    pub account: AccountStore,
    /// Taps with the key; counts what it delivers.
    pub senders: SenderStore,
    /// Where the patron key lives (Credential Manager on Windows).
    pub vault: Box<dyn CredentialVault>,
    pub persistence: Box<dyn PatronPersistence>,
}

#[derive(Clone)]
pub struct PatronStore {
    inner: Arc<Inner>,
}

struct Inner {
    config: PatronConfig,
    state: Mutex<PatronState>,
    /// One refresh at a time: two could each restore a key.
    refresh_lock: Mutex<()>,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl PatronStore {
    /// Loads the saved theme, counters and key, hands the key to the sender
    /// store, and counts each tap it delivers.
    pub fn new(config: PatronConfig) -> Self {
        let settings = config.persistence.load();
        let key = config.vault.read();
        config.senders.set_patron_key(key.clone());
        let inner = Arc::new(Inner {
            state: Mutex::new(PatronState {
                settings,
                has_key: key.is_some(),
                ..PatronState::default()
            }),
            config,
            refresh_lock: Mutex::new(()),
            on_change: Mutex::new(None),
        });
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        inner.config.senders.on_delivered(move || {
            if let Some(inner) = weak.upgrade() {
                inner.change_settings(|settings| settings.sent = settings.sent.saturating_add(1));
            }
        });
        Self { inner }
    }

    /// Called (on any thread) whenever `state()` may have changed.
    pub fn on_change(&self, callback: impl Fn() + Send + Sync + 'static) {
        *self.inner.on_change.lock().unwrap() = Some(Arc::new(callback));
    }

    pub fn state(&self) -> PatronState {
        self.inner.state.lock().unwrap().clone()
    }

    /// Asks the account where the membership stands. Active with no key
    /// here: restores one for the first active membership. Not active: the
    /// key stays (the membership may come back), but taps go in Default.
    pub fn refresh(&self) -> Result<(), ApiError> {
        let _one_at_a_time = self.inner.refresh_lock.lock().unwrap();
        let status = self.inner.config.account.patron_status()?;
        let active = status.active_membership().cloned();
        let membership = active
            .as_ref()
            .or(status.memberships.first())
            .and_then(|membership| membership.status.patron.clone());
        self.inner.update(|state| {
            state.active = active.is_some();
            state.checkout_enabled = status.checkout_enabled;
            state.membership = membership;
            state.loaded = true;
        });
        if let Some(active) = active
            && !self.state().has_key
        {
            let key = self.inner.config.account.restore_patron_key(&active.id)?;
            self.inner.config.vault.write(&key).map_err(ApiError::invalid)?;
            self.inner.config.senders.set_patron_key(Some(key));
            self.inner.update(|state| state.has_key = true);
        }
        Ok(())
    }

    /// `refresh` on its own thread.
    pub fn refresh_in_background(&self) {
        let store = self.clone();
        std::thread::spawn(move || {
            let _ = store.refresh();
        });
    }

    /// This PC's own theme from now on, for everyone with no theme chosen
    /// for them on the account (kept even while not a patron).
    pub fn set_theme(&self, theme: TapTheme) {
        self.inner.change_settings(|settings| settings.theme = theme);
    }

    /// Chooses the theme new taps to one person go in, on every device on
    /// the account, keeping how they see you. Signed out, or for a person
    /// the account doesn't hold (an old pairing it never had), this PC's own
    /// theme changes instead, as before themes were per person. Blocks; call
    /// it off the UI thread.
    pub fn choose_theme(&self, pairing_id: &str, theme: TapTheme) -> Result<(), ApiError> {
        let config = &self.inner.config;
        let Some(pairing) = config
            .senders
            .state()
            .session(pairing_id)
            .map(|session| session.pairing.clone())
        else {
            return Ok(());
        };
        if !config.account.state().signed_in {
            self.set_theme(theme);
            return Ok(());
        }
        let profile = Profile {
            name: pairing.sender_name.clone(),
            color: pairing.swatch_color(),
        };
        match config.account.update_send_profile(pairing_id, &profile, Some(theme)) {
            Err(error) if error.code == ErrorCode::NotFound => {
                self.set_theme(theme);
                Ok(())
            }
            result => result,
        }
    }

    /// The nudge was dismissed or acted on: the next waits for its milestone.
    pub fn nudge_shown(&self) {
        self.inner
            .change_settings(|settings| settings.nudges_shown = settings.nudges_shown.saturating_add(1));
    }

    /// Where to become a patron; open it in the browser.
    pub fn checkout(&self) -> Result<String, ApiError> {
        self.inner.config.account.patron_checkout()
    }

    /// The billing portal; open it in the browser.
    pub fn manage(&self) -> Result<String, ApiError> {
        self.inner.config.account.patron_manage()
    }
}

impl Inner {
    fn update(&self, change: impl FnOnce(&mut PatronState)) {
        let changed = {
            let mut state = self.state.lock().unwrap();
            let before = state.clone();
            change(&mut state);
            *state != before
        };
        if changed {
            let callback = self.on_change.lock().unwrap().clone();
            if let Some(callback) = callback {
                callback();
            }
        }
    }

    /// Changes and saves the settings together, so saves keep their order.
    fn change_settings(&self, change: impl FnOnce(&mut PatronSettings)) {
        self.update(|state| {
            change(&mut state.settings);
            self.config.persistence.save(&state.settings);
        });
    }
}
