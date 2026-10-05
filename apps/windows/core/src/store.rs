//! All receiver behavior in one place, like ReceiverStore in
//! ShouldertapCore/Store.swift: the device credential, the live connection,
//! which tap the overlay shows, and acknowledgements that must survive being
//! offline. The UI only draws what this decides.
//!
//! Commands that the UI waits on (`create_inbox`, `join`, `revoke`, …) block;
//! call them off the UI thread. Everything else runs on its own threads and
//! reports through `on_change`.

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use crate::api::{ApiClient, ApiError, ErrorCode, Transport};
use crate::live::{LiveConnection, LiveHandlers, LiveStatus, merge_snapshot, merge_tap};
use crate::models::*;

/// Where a computer keeps what must survive a restart.
pub trait ReceiverPersistence: Send + Sync {
    fn load_credential(&self) -> Option<String>;
    fn save_credential(&self, token: &str) -> Result<(), String>;
    fn delete_credential(&self);
    fn load_pending_acks(&self) -> BTreeMap<String, TapResponse>;
    fn save_pending_acks(&self, acks: &BTreeMap<String, TapResponse>);
}

#[derive(Clone, Debug)]
pub struct Endpoints {
    pub server: String,
    pub web: String,
}

/// The tap the overlay shows: the oldest one still waiting.
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveTap {
    pub tap: Tap,
    /// Other taps waiting behind this one.
    pub queued: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SenderInvite {
    pub url: String,
    pub expires_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Loading,
    Setup,
    Ready,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoreState {
    pub phase: Phase,
    pub recipient_name: String,
    pub credential_id: Option<String>,
    pub credentials: Vec<Credential>,
    /// Trial, paid or expired; None until the first snapshot, or from a server
    /// older than payments.
    pub plan: Option<Plan>,
    /// Newest first.
    pub taps: Vec<Tap>,
    pub status: LiveStatus,
    /// Responses given here that the server hasn't confirmed yet.
    pub pending_acks: BTreeMap<String, TapResponse>,
}

impl Default for StoreState {
    fn default() -> Self {
        Self {
            phase: Phase::Loading,
            recipient_name: String::new(),
            credential_id: None,
            credentials: Vec::new(),
            plan: None,
            taps: Vec::new(),
            status: LiveStatus::Connecting,
            pending_acks: BTreeMap::new(),
        }
    }
}

impl StoreState {
    pub fn active_tap(&self) -> Option<ActiveTap> {
        if self.phase != Phase::Ready {
            return None;
        }
        let mut waiting: Vec<&Tap> = self
            .taps
            .iter()
            .filter(|tap| tap.state == TapState::Pending && !self.pending_acks.contains_key(&tap.id))
            .collect();
        waiting.sort_by(|a, b| a.created_at.total_cmp(&b.created_at));
        waiting.first().map(|tap| ActiveTap {
            tap: (*tap).clone(),
            queued: waiting.len() - 1,
        })
    }
}

pub struct StoreConfig {
    pub endpoints: Endpoints,
    pub persistence: Box<dyn ReceiverPersistence>,
    /// This computer's name, as the inbox lists it.
    pub device_name: Box<dyn Fn() -> String + Send + Sync>,
    pub platform: DevicePlatform,
    /// The trial fingerprint (`MachineFingerprint`), when it can be read.
    pub machine: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub transport: Arc<dyn Transport>,
    pub ack_retry_delay: Duration,
}

#[derive(Clone)]
pub struct ReceiverStore {
    inner: Arc<Inner>,
}

struct Inner {
    config: StoreConfig,
    state: Mutex<StoreState>,
    token: Mutex<Option<String>>,
    live: Mutex<Option<LiveConnection>>,
    /// Which connection is current; events from an older one are ignored.
    live_id: AtomicU64,
    /// Which ack flush is current; an older one doesn't schedule retries.
    ack_flush: AtomicU64,
    reported_displayed: Mutex<HashSet<String>>,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl ReceiverStore {
    pub fn new(config: StoreConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                state: Mutex::new(StoreState::default()),
                token: Mutex::new(None),
                live: Mutex::new(None),
                live_id: AtomicU64::new(0),
                ack_flush: AtomicU64::new(0),
                reported_displayed: Mutex::new(HashSet::new()),
                on_change: Mutex::new(None),
            }),
        }
    }

    /// Called (on any thread) whenever `state()` may have changed.
    pub fn on_change(&self, callback: impl Fn() + Send + Sync + 'static) {
        *self.inner.on_change.lock().unwrap() = Some(Arc::new(callback));
    }

    pub fn state(&self) -> StoreState {
        self.inner.state.lock().unwrap().clone()
    }

    /// Loads saved state and connects. Returns false when this computer still
    /// needs setting up, so the app can open the menu.
    pub fn start(&self) -> bool {
        let acks = self.inner.config.persistence.load_pending_acks();
        self.inner.update(|state| state.pending_acks = acks);
        match self.inner.config.persistence.load_credential() {
            Some(token) => {
                self.inner.connect(token);
                true
            }
            None => {
                self.inner.update(|state| state.phase = Phase::Setup);
                false
            }
        }
    }

    /// Reconnect after sleep or a network change.
    pub fn nudge(&self) {
        if let Some(live) = self.inner.live.lock().unwrap().as_ref() {
            live.nudge();
        }
    }

    /// Refetch the snapshot (one GET) when the menu opens, so the plan is
    /// current after a checkout even if the live event was missed.
    pub fn refresh(&self) {
        if self.state().phase == Phase::Ready && self.inner.token().is_some() {
            self.inner.resync();
        }
    }

    // Plan

    /// Where to pay for this inbox. If it turns out to be paid for already
    /// (`Conflict`), the snapshot is refreshed so the menu catches up.
    pub fn checkout_url(&self) -> Result<String, ApiError> {
        match self.inner.api().create_checkout() {
            Ok(checkout) => Ok(checkout.url),
            Err(error) => {
                if error.code == ErrorCode::Conflict {
                    self.inner.resync();
                }
                Err(error)
            }
        }
    }

    // Overlay

    /// The overlay put this tap on screen; tell the sender once.
    pub fn did_display(&self, tap_id: &str) {
        let undisplayed = self
            .state()
            .taps
            .iter()
            .any(|tap| tap.id == tap_id && tap.displayed_at.is_none());
        if !undisplayed || !self.inner.reported_displayed.lock().unwrap().insert(tap_id.into()) {
            return;
        }
        let inner = self.inner.clone();
        let tap_id = tap_id.to_string();
        std::thread::spawn(move || match inner.api().mark_displayed(&tap_id) {
            Ok(tap) => inner.merge(tap),
            Err(_) => {
                inner.reported_displayed.lock().unwrap().remove(&tap_id);
            }
        });
    }

    // Setup

    /// Sends this computer's fingerprint so its free trial carries over a
    /// fresh setup. Joining an existing inbox (`join`) doesn't: that inbox's
    /// plan already applies.
    pub fn create_inbox(&self, recipient_name: &str) -> Result<(), ApiError> {
        let config = &self.inner.config;
        let machine = (config.machine)();
        let grant = self.inner.api().create_inbox(
            recipient_name,
            &self.inner.safe_device_name(),
            config.platform,
            machine.as_deref(),
        )?;
        self.inner.adopt(grant.token)
    }

    /// `code` is the bare code, or a link carrying it.
    pub fn join(&self, code: &str) -> Result<(), ApiError> {
        let code = invite_code(code).unwrap_or_else(|| code.trim().to_string());
        let platform = self.inner.config.platform;
        let grant = self
            .inner
            .api()
            .redeem_invite(&code, &self.inner.safe_device_name(), None, Some(platform))?;
        if grant.kind != CredentialKind::Device {
            return Err(ApiError::invalid(if platform.shows_taps() {
                "That's a sender invite. Open it on the phone that will send taps."
            } else {
                "That's an invite to tap someone. To link your computer, use the code under Your devices."
            }));
        }
        self.inner.adopt(grant.token)
    }

    // Responding

    /// Dismiss locally right away; the sender sees it once the server commits,
    /// retried until it does, even across restarts.
    pub fn respond(&self, tap_id: &str, response: TapResponse) {
        self.inner.set_pending_acks(|acks| {
            acks.insert(tap_id.into(), response);
        });
        self.inner.flush_acks();
    }

    // Pairing management

    pub fn create_sender_invite(&self) -> Result<SenderInvite, ApiError> {
        let invite = self.inner.api().create_invite(CredentialKind::Sender)?;
        let mut url =
            url::Url::parse(&self.inner.config.endpoints.web).map_err(|error| ApiError::invalid(error.to_string()))?;
        let path = format!("{}/join", url.path().trim_end_matches('/'));
        url.set_path(&path);
        // The code travels in the fragment so it never reaches a server log.
        url.set_fragment(Some(&invite.code));
        Ok(SenderInvite {
            url: url.into(),
            expires_at: invite.expires_at,
        })
    }

    pub fn create_device_code(&self) -> Result<Invite, ApiError> {
        self.inner.api().create_invite(CredentialKind::Device)
    }

    /// Deletes a tap for everyone: from history, and from every screen if
    /// it's still waiting. One that's already gone counts as deleted.
    pub fn delete_tap(&self, tap_id: &str) -> Result<(), ApiError> {
        match self.inner.api().delete_tap(tap_id) {
            Err(error) if error.code != ErrorCode::NotFound => return Err(error),
            _ => {}
        }
        self.inner.drop_tap(tap_id);
        Ok(())
    }

    /// Removing this device forgets it here even if the server can't be
    /// reached, except when the server refuses (the inbox's last computer
    /// while an iPhone is still linked): then it stays, and the error says why.
    pub fn revoke(&self, credential_id: &str) -> Result<(), ApiError> {
        if self.state().credential_id.as_deref() == Some(credential_id) {
            if let Err(error) = self.inner.api().revoke(credential_id) {
                if error.code == ErrorCode::Conflict {
                    return Err(error);
                }
            }
            self.inner.forget();
            return Ok(());
        }
        self.inner.api().revoke(credential_id)?;
        self.inner.resync();
        Ok(())
    }
}

impl Inner {
    fn update(&self, change: impl FnOnce(&mut StoreState)) {
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

    fn api(&self) -> ApiClient {
        ApiClient::new(&self.config.endpoints.server, self.config.transport.clone()).with_token(self.token())
    }

    fn safe_device_name(&self) -> String {
        let name: String = (self.config.device_name)().chars().take(MAX_NAME_LENGTH).collect();
        let name = name.trim();
        if name.is_empty() {
            self.config.platform.label().into()
        } else {
            name.into()
        }
    }

    fn adopt(self: &Arc<Self>, token: String) -> Result<(), ApiError> {
        self.config
            .persistence
            .save_credential(&token)
            .map_err(|message| ApiError {
                code: ErrorCode::InvalidRequest,
                message,
                status: 0,
            })?;
        self.connect(token);
        Ok(())
    }

    fn connect(self: &Arc<Self>, token: String) {
        if let Some(live) = self.live.lock().unwrap().take() {
            live.close();
        }
        *self.token.lock().unwrap() = Some(token);
        self.update(|state| {
            state.phase = Phase::Ready;
            state.status = LiveStatus::Connecting;
        });
        let id = self.live_id.fetch_add(1, Ordering::SeqCst) + 1;
        let handlers = Handlers {
            store: Arc::downgrade(self),
            id,
        };
        *self.live.lock().unwrap() = Some(LiveConnection::start(self.api(), handlers));
    }

    fn resync(self: &Arc<Self>) {
        let inner = self.clone();
        std::thread::spawn(move || {
            match inner.api().me() {
                Ok(Snapshot::Receiver(snapshot)) => inner.update(|state| {
                    state.recipient_name = snapshot.recipient_name;
                    state.credential_id = Some(snapshot.credential_id);
                    state.credentials = snapshot.credentials;
                    state.plan = snapshot.plan;
                    state.taps = merge_snapshot(&state.taps, &snapshot.taps);
                }),
                Ok(Snapshot::Sender(_)) => return,
                Err(error) if error.code == ErrorCode::Unauthorized => {
                    inner.forget();
                    return;
                }
                Err(_) => {}
            }
            inner.flush_acks();
        });
    }

    fn merge(&self, tap: Tap) {
        self.update(|state| state.taps = merge_tap(&state.taps, tap));
    }

    fn drop_tap(&self, tap_id: &str) {
        self.update(|state| state.taps.retain(|tap| tap.id != tap_id));
        self.drop_pending_ack(tap_id);
    }

    /// Unpaired (revoked, or this computer removed itself): back to setup.
    fn forget(&self) {
        self.live_id.fetch_add(1, Ordering::SeqCst);
        if let Some(live) = self.live.lock().unwrap().take() {
            live.close();
        }
        self.ack_flush.fetch_add(1, Ordering::SeqCst);
        self.config.persistence.delete_credential();
        *self.token.lock().unwrap() = None;
        self.config.persistence.save_pending_acks(&BTreeMap::new());
        self.update(|state| {
            *state = StoreState {
                phase: Phase::Setup,
                status: LiveStatus::Offline,
                ..StoreState::default()
            }
        });
    }

    fn set_pending_acks(&self, change: impl FnOnce(&mut BTreeMap<String, TapResponse>)) {
        let mut acks = self.state.lock().unwrap().pending_acks.clone();
        change(&mut acks);
        self.config.persistence.save_pending_acks(&acks);
        self.update(|state| state.pending_acks = acks);
    }

    fn flush_acks(self: &Arc<Self>) {
        let flush = self.ack_flush.fetch_add(1, Ordering::SeqCst) + 1;
        let acks = self.state.lock().unwrap().pending_acks.clone();
        if self.token().is_none() || acks.is_empty() {
            return;
        }
        let inner = self.clone();
        std::thread::spawn(move || {
            let api = inner.api();
            // Idempotent server-side, so overlapping flushes are safe.
            let results: Vec<(String, Result<Tap, ApiError>)> = std::thread::scope(|scope| {
                let sends: Vec<_> = acks
                    .iter()
                    .map(|(tap_id, response)| {
                        let api = &api;
                        scope.spawn(move || (tap_id.clone(), api.acknowledge(tap_id, response)))
                    })
                    .collect();
                sends.into_iter().filter_map(|send| send.join().ok()).collect()
            });
            let mut retry = false;
            for (tap_id, result) in results {
                match result {
                    Ok(tap) => {
                        inner.drop_pending_ack(&tap_id);
                        inner.merge(tap);
                    }
                    Err(error) if error.is_retryable() => retry = true,
                    Err(_) => inner.drop_pending_ack(&tap_id),
                }
            }
            if !retry || inner.ack_flush.load(Ordering::SeqCst) != flush {
                return;
            }
            std::thread::sleep(inner.config.ack_retry_delay);
            if inner.ack_flush.load(Ordering::SeqCst) == flush {
                inner.flush_acks();
            }
        });
    }

    fn drop_pending_ack(&self, tap_id: &str) {
        if self.state.lock().unwrap().pending_acks.contains_key(tap_id) {
            self.set_pending_acks(|acks| {
                acks.remove(tap_id);
            });
        }
    }
}

struct Handlers {
    store: Weak<Inner>,
    id: u64,
}

impl Handlers {
    fn current(&self) -> Option<Arc<Inner>> {
        self.store
            .upgrade()
            .filter(|inner| inner.live_id.load(Ordering::SeqCst) == self.id)
    }
}

impl LiveHandlers for Handlers {
    fn on_resync(&self) {
        if let Some(inner) = self.current() {
            inner.resync();
        }
    }

    fn on_tap(&self, tap: Tap) {
        if let Some(inner) = self.current() {
            inner.merge(tap);
        }
    }

    fn on_tap_deleted(&self, tap_id: String) {
        if let Some(inner) = self.current() {
            inner.drop_tap(&tap_id);
        }
    }

    fn on_status(&self, status: LiveStatus) {
        if let Some(inner) = self.current() {
            inner.update(|state| state.status = status);
        }
    }

    fn on_revoked(&self) {
        if let Some(inner) = self.current() {
            inner.forget();
        }
    }
}
