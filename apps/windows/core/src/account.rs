//! The account: one email for the person, signed in on each of their devices
//! (docs/onboarding.md). A six-digit emailed code gives this PC a session;
//! `sync` then hands the receiver its inbox credential and the sender store a
//! key for each of the person's people. The Rust twin of AccountStore in
//! ShouldertapCore/Account.swift.
//!
//! Signing out or deleting the account ends only the session: the PC keeps
//! receiving and tapping with the credentials it holds.
//!
//! Commands block; call them off the UI thread. Changes report through
//! `on_change`.

use std::sync::{Arc, Mutex, Weak};

use crate::api::{ApiClient, ApiError, ErrorCode, Transport};
use crate::models::*;
use crate::persistence::CredentialVault;
use crate::sender::SenderStore;
use crate::store::ReceiverStore;

/// Sign-in codes are six digits.
pub const CODE_LENGTH: usize = 6;
/// What a wrong or expired code reads as (docs/onboarding.md, "Sign in").
pub const WRONG_CODE: &str = "That code didn't work. Check it or send a new one.";
const EXPIRED_SESSION: &str = "Your sign-in expired. Sign in again.";
const MAX_DEVICE_NAME: usize = 80;
const MAX_SYNC_TOKENS: usize = 50;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountState {
    /// This PC holds an account session.
    pub signed_in: bool,
    pub email: Option<String>,
    /// What the server last said; None until it has answered.
    pub me: Option<Me>,
    /// Why the last sync (or loading the account) failed.
    pub sync_error: Option<String>,
}

impl AccountState {
    /// Signed in, and the person hasn't picked a name and color yet: the You step.
    pub fn needs_profile(&self) -> bool {
        self.signed_in && self.me.as_ref().is_some_and(|me| me.profile.is_none())
    }

    pub fn profile(&self) -> Option<&Profile> {
        self.me.as_ref()?.profile.as_ref()
    }
}

pub struct AccountConfig {
    pub server: String,
    /// Where the session token lives (Credential Manager on Windows).
    pub vault: Box<dyn CredentialVault>,
    pub transport: Arc<dyn Transport>,
    pub platform: DevicePlatform,
    /// This computer's name, as the person's devices list it.
    pub device_name: Box<dyn Fn() -> String + Send + Sync>,
    /// Receives with the inbox credential sync hands out.
    pub receiver: ReceiverStore,
    /// Taps with the sender keys sync and accepting hand out.
    pub senders: SenderStore,
}

#[derive(Clone)]
pub struct AccountStore {
    inner: Arc<Inner>,
}

struct Inner {
    config: AccountConfig,
    state: Mutex<AccountState>,
    token: Mutex<Option<String>>,
    /// One sync at a time: two at once would both be handed an inbox credential.
    sync_lock: Mutex<()>,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl AccountStore {
    /// Also syncs whenever the inbox socket says its connections changed.
    pub fn new(config: AccountConfig) -> Self {
        let inner = Arc::new(Inner {
            config,
            state: Mutex::new(AccountState::default()),
            token: Mutex::new(None),
            sync_lock: Mutex::new(()),
            on_change: Mutex::new(None),
        });
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        inner.config.receiver.on_credentials(move || {
            if let Some(inner) = weak.upgrade() {
                AccountStore { inner }.sync_in_background();
            }
        });
        Self { inner }
    }

    /// Called (on any thread) whenever `state()` may have changed.
    pub fn on_change(&self, callback: impl Fn() + Send + Sync + 'static) {
        *self.inner.on_change.lock().unwrap() = Some(Arc::new(callback));
    }

    pub fn state(&self) -> AccountState {
        self.inner.state.lock().unwrap().clone()
    }

    /// Loads the saved session. True when this PC is signed in.
    pub fn start(&self) -> bool {
        let token = self.inner.config.vault.read();
        let signed_in = token.is_some();
        *self.inner.token.lock().unwrap() = token;
        self.inner.update(|state| state.signed_in = signed_in);
        signed_in
    }

    // Signing in

    /// Emails a six-digit code to `email`.
    pub fn send_code(&self, email: &str) -> Result<(), ApiError> {
        let email = checked_email(email)?;
        self.inner.api(None).send_sign_in_code(&email)
    }

    /// Signs in with the emailed code, then loads the account and syncs when
    /// it already has a profile. Fails only when signing in does: trouble
    /// after that is in `sync_error`, and `state().needs_profile()` says
    /// whether the You step comes next.
    pub fn verify(&self, email: &str, code: &str) -> Result<(), ApiError> {
        let email = checked_email(email)?;
        let otp: String = code.chars().filter(char::is_ascii_digit).collect();
        if otp.len() != CODE_LENGTH {
            return Err(ApiError::invalid("Enter the six-digit code from the email."));
        }
        let signed_in = match self.inner.api(None).sign_in(&email, &otp) {
            Err(error) if error.code == ErrorCode::InvalidRequest => {
                return Err(ApiError {
                    message: WRONG_CODE.into(),
                    ..error
                });
            }
            result => result?,
        };
        self.inner
            .config
            .vault
            .write(&signed_in.token)
            .map_err(ApiError::invalid)?;
        *self.inner.token.lock().unwrap() = Some(signed_in.token);
        self.inner.update(|state| {
            *state = AccountState {
                signed_in: true,
                email: Some(signed_in.user.email),
                ..AccountState::default()
            }
        });
        let _ = self.sync();
        Ok(())
    }

    /// Reloads who this is.
    pub fn refresh(&self) -> Result<Me, ApiError> {
        let api = self.inner.session()?;
        let me = self.inner.checked(api.account_me())?;
        self.inner.update(|state| {
            state.email = Some(me.email.clone());
            state.me = Some(me.clone());
        });
        Ok(me)
    }

    /// The You step: the name and color used for every new connection. The
    /// first time, the server creates the person's inbox; sync then hands
    /// this PC its credential.
    pub fn set_profile(&self, name: &str, color: PersonColor) -> Result<(), ApiError> {
        let name = name.trim();
        if !(1..=MAX_NAME_LENGTH).contains(&name.chars().count()) {
            return Err(ApiError::invalid(format!(
                "Enter your name (up to {MAX_NAME_LENGTH} characters)."
            )));
        }
        let api = self.inner.session()?;
        let profile = Profile {
            name: name.into(),
            color,
        };
        let me = self.inner.checked(api.set_profile(&profile))?;
        self.inner.update(|state| {
            state.email = Some(me.email.clone());
            state.me = Some(me);
        });
        let _ = self.sync();
        Ok(())
    }

    // Syncing

    /// Sends every token this PC holds and keeps what comes back: an inbox
    /// credential when it has none, a key for each person it can't tap yet,
    /// and drops tokens whose connection is gone. Does nothing signed out or
    /// before the You step. Failures are also kept in `sync_error`.
    pub fn sync(&self) -> Result<(), ApiError> {
        let _one_at_a_time = self.inner.sync_lock.lock().unwrap();
        if self.inner.token().is_none() {
            return Ok(());
        }
        let result = self.sync_now();
        let error = result.as_ref().err().map(ToString::to_string);
        self.inner.update(|state| state.sync_error = error);
        result
    }

    /// `sync` on its own thread: on launch, and when the inbox socket says
    /// connections changed.
    pub fn sync_in_background(&self) {
        let store = self.clone();
        std::thread::spawn(move || {
            let _ = store.sync();
        });
    }

    fn sync_now(&self) -> Result<(), ApiError> {
        let me = match self.state().me {
            Some(me) => me,
            None => self.refresh()?,
        };
        if me.profile.is_none() {
            return Ok(());
        }
        let config = &self.inner.config;
        let api = self.inner.session()?;
        let synced = match api.sync(config.platform, &self.inner.device_name(), true, &self.held_tokens()) {
            // Asked before the profile existed: learn that, for the You step.
            Err(error) if error.code == ErrorCode::Conflict => {
                self.refresh()?;
                return Ok(());
            }
            result => self.inner.checked(result)?,
        };

        let (receiver, senders) = (&config.receiver, &config.senders);
        if receiver.token().is_some_and(|token| synced.removed.contains(&token)) {
            receiver.forget();
        }
        senders.forget_tokens(&synced.removed);
        let mut failure = None;
        if let Some(grant) = &synced.inbox
            && let Err(error) = receiver.adopt(grant)
        {
            failure = Some(error);
        }
        for sender in &synced.senders {
            if let Err(error) = senders.add(sender) {
                failure.get_or_insert(error);
            }
        }
        self.inner.update(|state| {
            state.email = Some(synced.me.email.clone());
            state.me = Some(synced.me);
        });
        failure.map_or(Ok(()), Err)
    }

    /// The receiver's credential first, then each sender key, at most 50.
    fn held_tokens(&self) -> Vec<String> {
        let config = &self.inner.config;
        let mut tokens: Vec<String> = Vec::new();
        for token in config.receiver.token().into_iter().chain(config.senders.tokens()) {
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
        tokens.truncate(MAX_SYNC_TOKENS);
        tokens
    }

    // Invites

    /// Who sent an invite (a code or a link carrying one), before accepting.
    pub fn preview(&self, invite: &str) -> Result<InvitePreview, ApiError> {
        self.inner.api(None).invite_preview(&checked_invite(invite)?)
    }

    /// Connects you and the person who sent the invite, both ways, and
    /// keeps your new key to tap them.
    pub fn accept(&self, invite: &str) -> Result<Accepted, ApiError> {
        let code = checked_invite(invite)?;
        let api = self.inner.session()?;
        let config = &self.inner.config;
        let accepted = self
            .inner
            .checked(api.accept_invite(&code, config.platform, &self.inner.device_name()))?;
        if let Some(sender) = &accepted.sender {
            config.senders.add(sender)?;
        }
        Ok(accepted)
    }

    /// Stops tapping someone from every device on the account, then forgets
    /// them here. Signed out, or for a connection the account doesn't hold,
    /// this PC's own key is revoked instead (`SenderStore::unpair`).
    pub fn remove(&self, pairing_id: &str) -> Result<(), ApiError> {
        let senders = &self.inner.config.senders;
        let Some(pairing) = senders
            .state()
            .session(pairing_id)
            .map(|session| session.pairing.clone())
        else {
            return Ok(());
        };
        let (Ok(api), Some(id)) = (self.inner.session(), pairing.account_id()) else {
            senders.unpair(pairing_id);
            return Ok(());
        };
        match self.inner.checked(api.remove_person(&id)) {
            Ok(()) => senders.forget(pairing_id),
            Err(error) if error.code == ErrorCode::NotFound => senders.unpair(pairing_id),
            Err(error) => return Err(error),
        }
        Ok(())
    }

    // Leaving

    /// Ends the session; this PC keeps receiving and tapping.
    pub fn sign_out(&self) -> Result<(), ApiError> {
        let Ok(api) = self.inner.session() else {
            return Ok(());
        };
        match api.sign_out() {
            Err(error) if error.code != ErrorCode::Unauthorized => return Err(error),
            _ => {}
        }
        self.inner.end_session();
        Ok(())
    }

    /// Deletes the account and signs out. Credentials this PC holds stay.
    pub fn delete_account(&self) -> Result<(), ApiError> {
        let api = self.inner.session()?;
        self.inner.checked(api.delete_account())?;
        self.inner.end_session();
        Ok(())
    }
}

impl Inner {
    fn update(&self, change: impl FnOnce(&mut AccountState)) {
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

    fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    fn api(&self, token: Option<String>) -> ApiClient {
        ApiClient::new(&self.config.server, self.config.transport.clone()).with_token(token)
    }

    /// The client carrying the session, or why there's none.
    fn session(&self) -> Result<ApiClient, ApiError> {
        match self.token() {
            Some(token) => Ok(self.api(Some(token))),
            None => Err(ApiError {
                code: ErrorCode::Unauthorized,
                message: "Sign in first.".into(),
                status: 401,
            }),
        }
    }

    /// A refused session ends here: back to signing in.
    fn checked<T>(&self, result: Result<T, ApiError>) -> Result<T, ApiError> {
        result.map_err(|error| {
            if error.code != ErrorCode::Unauthorized {
                return error;
            }
            self.end_session();
            ApiError {
                message: EXPIRED_SESSION.into(),
                ..error
            }
        })
    }

    fn end_session(&self) {
        self.config.vault.delete();
        *self.token.lock().unwrap() = None;
        self.update(|state| *state = AccountState::default());
    }

    /// 1–80 characters; the platform's name when the computer has none.
    fn device_name(&self) -> String {
        let name: String = (self.config.device_name)()
            .trim()
            .chars()
            .take(MAX_DEVICE_NAME)
            .collect();
        let name = name.trim();
        if name.is_empty() {
            self.config.platform.label().into()
        } else {
            name.into()
        }
    }
}

fn checked_email(email: &str) -> Result<String, ApiError> {
    let email = email.trim();
    let valid = email
        .split_once('@')
        .is_some_and(|(name, domain)| !name.is_empty() && domain.contains('.') && !domain.ends_with('.'))
        && !email.chars().any(char::is_whitespace);
    if valid {
        Ok(email.to_string())
    } else {
        Err(ApiError::invalid("Enter your email address."))
    }
}

fn checked_invite(invite: &str) -> Result<String, ApiError> {
    invite_code(invite).ok_or_else(|| ApiError::invalid("That doesn't look like a Shouldertap invite link."))
}
