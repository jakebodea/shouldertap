//! The sender half of the client, like SenderStore in
//! ShouldertapCore/Sender.swift (and lib/pairing.ts + lib/use-sender.ts on
//! the web). A PC can tap several people; each pairing is its own sender
//! credential on that recipient's inbox, with its own taps, outbox and live
//! socket. A PC can be sender-only, so none of this needs the receiver.
//!
//! Commands the UI waits on (`pair`, `delete_data`, `delete_tap`) block; call
//! them off the UI thread. Sending, retries and syncing run on their own
//! threads and report through `on_change`.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};

use crate::api::{ApiClient, ApiError, ErrorCode, Transport};
use crate::live::{LiveConnection, LiveHandlers, LiveStatus, merge_snapshot, merge_tap};
use crate::models::*;

/// `newRequestId` from apps/web/src/lib/ids.ts: 16 random bytes as hex.
pub fn new_request_id() -> String {
    let mut bytes = [0u8; 16];
    // The OS generator (ProcessPrng on Windows), which doesn't fail.
    getrandom::fill(&mut bytes).expect("read random bytes");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What the receiver shows when a device code is pasted as an invite.
const DEVICE_CODE_MESSAGE: &str =
    "That code links one of your own devices, not someone to tap. Paste it where you set up this device.";

/// One recipient this PC can tap. `token` is the secret: `LocalSenderPersistence`
/// keeps it in Credential Manager. Mirrors `Pairing` in apps/web/src/lib/pairing.ts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderPairing {
    pub token: String,
    pub credential_id: String,
    pub recipient_name: String,
    pub sender_name: String,
    /// Missing on pairings made before colors; the snapshot fills it in.
    #[serde(default)]
    pub color: Option<PersonColor>,
    pub paired_at: Timestamp,
}

impl SenderPairing {
    pub fn inbox_id(&self) -> Option<&str> {
        token_inbox_id(&self.token)
    }

    pub fn swatch_color(&self) -> PersonColor {
        self.color.unwrap_or_else(|| PersonColor::fallback(&self.credential_id))
    }

    /// The key inside the token (`<inboxId>.<keyId>.<secret>`). Revoking it
    /// leaves the sender's other devices (restored from an account) paired.
    fn key_id(&self) -> Option<&str> {
        self.inbox_id()?;
        self.token.trim().split('.').nth(1)
    }
}

/// A send the server hasn't accepted yet. It keeps its request id, so a
/// retry after a dropped connection can't create a duplicate tap.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingTap {
    pub request_id: String,
    pub body: String,
    pub created_at: Timestamp,
    /// Refused for good (not a transient failure): offer Try again / Discard.
    #[serde(default)]
    pub failed: bool,
    /// Why the server refused it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where a PC keeps its sender pairings and unsent taps across restarts.
pub trait SenderPersistence: Send + Sync {
    fn load_pairings(&self) -> Vec<SenderPairing>;
    fn save_pairing(&self, pairing: &SenderPairing) -> Result<(), String>;
    fn delete_pairing(&self, credential_id: &str);
    fn load_outbox(&self, credential_id: &str) -> Vec<OutgoingTap>;
    fn save_outbox(&self, outbox: &[OutgoingTap], credential_id: &str);
}

/// A draft the server would refuse anyway.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendError {
    Empty,
    TooLong,
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("Write a message first."),
            Self::TooLong => write!(f, "Taps are {MAX_TAP_LENGTH} characters at most."),
        }
    }
}

impl std::error::Error for SendError {}

/// Sender state for one recipient: the authoritative snapshot, live updates,
/// and the outbox (`useSender`).
#[derive(Clone, Debug, PartialEq)]
pub struct SenderSession {
    pub pairing: SenderPairing,
    /// Newest first.
    pub taps: Vec<Tap>,
    /// Newest first.
    pub outbox: Vec<OutgoingTap>,
    pub status: LiveStatus,
    /// The first snapshot arrived, so an empty history really is empty.
    pub loaded: bool,
}

impl SenderSession {
    pub fn id(&self) -> &str {
        &self.pairing.credential_id
    }

    pub fn color(&self) -> PersonColor {
        self.pairing.swatch_color()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SenderState {
    /// Oldest pairing first.
    pub sessions: Vec<SenderSession>,
    /// Something to hear about once, e.g. a removed pairing.
    pub notice: Option<String>,
}

impl SenderState {
    pub fn session(&self, id: &str) -> Option<&SenderSession> {
        self.sessions.iter().find(|session| session.id() == id)
    }
}

pub struct SenderConfig {
    pub server: String,
    pub persistence: Box<dyn SenderPersistence>,
    pub transport: Arc<dyn Transport>,
}

/// Every recipient this PC can tap, persisted and connected.
#[derive(Clone)]
pub struct SenderStore {
    inner: Arc<Inner>,
}

struct Inner {
    config: SenderConfig,
    state: Mutex<SenderState>,
    /// Which connection is current for each pairing; events from an older
    /// one (or a forgotten pairing) are ignored.
    current: Mutex<HashMap<String, u64>>,
    generation: AtomicU64,
    lives: Mutex<HashMap<String, LiveConnection>>,
    /// Request ids being sent right now, so a resync doesn't send one twice.
    in_flight: Mutex<HashSet<String>>,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl SenderStore {
    pub fn new(config: SenderConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                state: Mutex::new(SenderState::default()),
                current: Mutex::new(HashMap::new()),
                generation: AtomicU64::new(0),
                lives: Mutex::new(HashMap::new()),
                in_flight: Mutex::new(HashSet::new()),
                on_change: Mutex::new(None),
            }),
        }
    }

    /// Called (on any thread) whenever `state()` may have changed.
    pub fn on_change(&self, callback: impl Fn() + Send + Sync + 'static) {
        *self.inner.on_change.lock().unwrap() = Some(Arc::new(callback));
    }

    pub fn state(&self) -> SenderState {
        self.inner.state.lock().unwrap().clone()
    }

    /// Loads saved pairings and connects each.
    pub fn start(&self) {
        let ids: Vec<String> = self.state().sessions.iter().map(|s| s.id().to_string()).collect();
        for id in &ids {
            self.inner.stop(id);
        }
        let persistence = &self.inner.config.persistence;
        let mut pairings = persistence.load_pairings();
        pairings.sort_by(|a, b| a.paired_at.total_cmp(&b.paired_at));
        let sessions: Vec<SenderSession> = pairings
            .into_iter()
            .map(|pairing| {
                let outbox = persistence.load_outbox(&pairing.credential_id);
                new_session(pairing, outbox)
            })
            .collect();
        let ids: Vec<String> = sessions.iter().map(|s| s.id().to_string()).collect();
        self.inner.update(|state| state.sessions = sessions);
        for id in &ids {
            self.inner.connect(id);
        }
    }

    /// Reconnect after sleep or a network change: sockets that slept are often dead.
    pub fn nudge(&self) {
        for live in self.inner.lives.lock().unwrap().values() {
            live.nudge();
        }
    }

    /// Refetch one pairing's snapshot, then push anything still queued.
    pub fn refresh(&self, id: &str) {
        self.inner.resync(id);
    }

    pub fn clear_notice(&self) {
        self.inner.update(|state| state.notice = None);
    }

    // Sending

    /// Queue a tap and deliver it. Fails only for drafts the server would
    /// refuse anyway; network trouble leaves it in the outbox to retry.
    pub fn send(&self, id: &str, body: &str) -> Result<(), SendError> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err(SendError::Empty);
        }
        if trimmed.chars().count() > MAX_TAP_LENGTH {
            return Err(SendError::TooLong);
        }
        let item = OutgoingTap {
            request_id: new_request_id(),
            body: trimmed.into(),
            created_at: now_ms(),
            failed: false,
            error: None,
        };
        let queued = item.clone();
        if self.inner.update_outbox(id, move |outbox| outbox.insert(0, queued)) {
            self.inner.deliver(id, item);
        }
        Ok(())
    }

    /// A failed send, again, as a fresh request (like the web's "Try again").
    pub fn retry(&self, id: &str, request_id: &str) {
        let body = self
            .state()
            .session(id)
            .and_then(|session| session.outbox.iter().find(|item| item.request_id == request_id))
            .map(|item| item.body.clone());
        if let Some(body) = body {
            self.discard(id, request_id);
            let _ = self.send(id, &body);
        }
    }

    pub fn discard(&self, id: &str, request_id: &str) {
        self.inner
            .update_outbox(id, |outbox| outbox.retain(|item| item.request_id != request_id));
    }

    /// Deletes one of your taps for everyone, including from their screens if
    /// they haven't answered. One that's already gone counts as deleted.
    pub fn delete_tap(&self, id: &str, tap_id: &str) -> Result<(), ApiError> {
        let api = self
            .inner
            .api_for(id)
            .ok_or_else(|| ApiError::invalid("No such pairing"))?;
        match api.delete_tap(tap_id) {
            Err(error) if error.code != ErrorCode::NotFound => return Err(error),
            _ => {}
        }
        self.inner
            .update_session(id, |session| session.taps.retain(|tap| tap.id != tap_id));
        Ok(())
    }

    // Pairing

    /// Redeems a sender invite (a code or a link carrying one) and returns the
    /// new pairing's id. Pairing again with the same recipient replaces that
    /// pairing, like the web.
    pub fn pair(&self, invite: &str, name: &str, color: PersonColor) -> Result<String, ApiError> {
        let code = invite_code(invite)
            .ok_or_else(|| ApiError::invalid("That doesn't look like a Shouldertap invite link."))?;
        let name = name.trim();
        if !(1..=MAX_NAME_LENGTH).contains(&name.chars().count()) {
            return Err(ApiError::invalid(format!(
                "Enter your name (up to {MAX_NAME_LENGTH} characters)."
            )));
        }
        let grant = self.inner.api(None).redeem_invite(&code, name, Some(color), None)?;
        if grant.kind != CredentialKind::Sender {
            return Err(ApiError::invalid(DEVICE_CODE_MESSAGE));
        }
        let pairing = SenderPairing {
            token: grant.token,
            credential_id: grant.credential_id,
            recipient_name: grant.recipient_name,
            sender_name: name.into(),
            color: Some(color),
            paired_at: now_ms(),
        };
        self.inner
            .config
            .persistence
            .save_pairing(&pairing)
            .map_err(|message| ApiError {
                code: ErrorCode::InvalidRequest,
                message,
                status: 0,
            })?;
        let replaced: Vec<String> = self
            .state()
            .sessions
            .iter()
            .filter(|session| session.pairing.inbox_id() == pairing.inbox_id() && session.id() != pairing.credential_id)
            .map(|session| session.id().to_string())
            .collect();
        for id in replaced {
            self.unpair(&id);
        }
        let id = pairing.credential_id.clone();
        self.inner.update(|state| {
            state.sessions.retain(|session| session.id() != id);
            state.sessions.push(new_session(pairing, Vec::new()));
        });
        self.inner.connect(&id);
        Ok(id)
    }

    /// Revokes this PC's key so the recipient stops listing the sender, then
    /// forgets the pairing here. Best effort: it's forgotten either way.
    pub fn unpair(&self, id: &str) {
        let Some(pairing) = self.state().session(id).map(|session| session.pairing.clone()) else {
            return;
        };
        self.inner.forget(id);
        let Some(key_id) = pairing.key_id().map(String::from) else {
            return;
        };
        let api = self.inner.api(Some(pairing.token));
        std::thread::spawn(move || {
            let _ = api.revoke(&key_id);
        });
    }

    /// Deletes the sender and their taps from the recipient's inbox. The
    /// pairing stays until the server confirms, so a failure can be retried.
    pub fn delete_data(&self, id: &str) -> Result<(), ApiError> {
        let api = self
            .inner
            .api_for(id)
            .ok_or_else(|| ApiError::invalid("No such pairing"))?;
        api.delete_sender()?;
        self.inner.forget(id);
        Ok(())
    }
}

fn new_session(pairing: SenderPairing, outbox: Vec<OutgoingTap>) -> SenderSession {
    SenderSession {
        pairing,
        taps: Vec::new(),
        outbox,
        status: LiveStatus::Connecting,
        loaded: false,
    }
}

impl Inner {
    fn update<R>(&self, change: impl FnOnce(&mut SenderState) -> R) -> R {
        let (result, changed) = {
            let mut state = self.state.lock().unwrap();
            let before = state.clone();
            let result = change(&mut state);
            (result, *state != before)
        };
        if changed {
            let callback = self.on_change.lock().unwrap().clone();
            if let Some(callback) = callback {
                callback();
            }
        }
        result
    }

    /// False when there's no such pairing (any more).
    fn update_session(&self, id: &str, change: impl FnOnce(&mut SenderSession)) -> bool {
        self.update(
            |state| match state.sessions.iter_mut().find(|session| session.id() == id) {
                Some(session) => {
                    change(session);
                    true
                }
                None => false,
            },
        )
    }

    /// Changes and saves a pairing's outbox together, so saves keep their order.
    fn update_outbox(&self, id: &str, change: impl FnOnce(&mut Vec<OutgoingTap>)) -> bool {
        self.update_session(id, |session| {
            change(&mut session.outbox);
            self.config.persistence.save_outbox(&session.outbox, id);
        })
    }

    fn api(&self, token: Option<String>) -> ApiClient {
        ApiClient::new(&self.config.server, self.config.transport.clone()).with_token(token)
    }

    fn api_for(&self, id: &str) -> Option<ApiClient> {
        let token = self.state.lock().unwrap().session(id)?.pairing.token.clone();
        Some(self.api(Some(token)))
    }

    fn connect(self: &Arc<Self>, id: &str) {
        let Some(api) = self.api_for(id) else { return };
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.current.lock().unwrap().insert(id.into(), generation);
        self.update_session(id, |session| session.status = LiveStatus::Connecting);
        let handlers = Handlers {
            store: Arc::downgrade(self),
            id: id.into(),
            generation,
        };
        let connection = LiveConnection::start(api, handlers);
        // Forgotten while starting (revoked at once): don't keep it.
        let mut lives = self.lives.lock().unwrap();
        if self.current.lock().unwrap().get(id) == Some(&generation) {
            if let Some(old) = lives.insert(id.into(), connection) {
                old.close();
            }
        } else {
            connection.close();
        }
    }

    fn stop(&self, id: &str) {
        self.current.lock().unwrap().remove(id);
        if let Some(live) = self.lives.lock().unwrap().remove(id) {
            live.close();
        }
        self.update_session(id, |session| session.status = LiveStatus::Offline);
    }

    fn deliver(self: &Arc<Self>, id: &str, item: OutgoingTap) {
        let Some(api) = self.api_for(id) else { return };
        if !self.in_flight.lock().unwrap().insert(item.request_id.clone()) {
            return;
        }
        let inner = self.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            match api.send_tap(&item.request_id, &item.body) {
                Ok(tap) => {
                    inner.update_outbox(&id, |outbox| {
                        outbox.retain(|queued| queued.request_id != item.request_id)
                    });
                    inner.merge(&id, tap);
                }
                Err(error) if error.code == ErrorCode::Unauthorized => inner.revoked(&id),
                // Transient failures stay queued and go again on the next
                // resync. Refusals (a 402 once the recipient's trial ends, …)
                // are marked failed with the server's message and never
                // retried alone.
                Err(error) => {
                    let failed = !error.is_retryable();
                    inner.update_outbox(&id, |outbox| {
                        for queued in outbox.iter_mut().filter(|queued| queued.request_id == item.request_id) {
                            queued.failed = failed;
                            queued.error = failed.then(|| error.message.clone());
                        }
                    });
                }
            }
            inner.in_flight.lock().unwrap().remove(&item.request_id);
        });
    }

    fn resync(self: &Arc<Self>, id: &str) {
        let Some(api) = self.api_for(id) else { return };
        let inner = self.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            match api.me() {
                Ok(Snapshot::Sender(snapshot)) => {
                    let mut changed_pairing = None;
                    inner.update_session(&id, |session| {
                        session.taps = merge_snapshot(&session.taps, &snapshot.taps);
                        session.loaded = true;
                        // Pairings made before colors existed learn theirs here.
                        let pairing = &mut session.pairing;
                        if pairing.color.is_none() || pairing.recipient_name != snapshot.recipient_name {
                            pairing.color = pairing.color.or(Some(snapshot.sender_color));
                            pairing.recipient_name = snapshot.recipient_name.clone();
                            changed_pairing = Some(pairing.clone());
                        }
                    });
                    if let Some(pairing) = changed_pairing {
                        let _ = inner.config.persistence.save_pairing(&pairing);
                    }
                }
                Ok(Snapshot::Receiver(_)) => return,
                Err(error) if error.code == ErrorCode::Unauthorized => {
                    inner.revoked(&id);
                    return;
                }
                Err(_) => return,
            }
            let queued: Vec<OutgoingTap> = inner
                .state
                .lock()
                .unwrap()
                .session(&id)
                .map(|session| session.outbox.iter().filter(|item| !item.failed).cloned().collect())
                .unwrap_or_default();
            for item in queued {
                inner.deliver(&id, item);
            }
        });
    }

    fn merge(&self, id: &str, tap: Tap) {
        self.update_session(id, |session| session.taps = merge_tap(&session.taps, tap));
    }

    /// The recipient removed this pairing (or its key stopped working).
    fn revoked(&self, id: &str) {
        let name = self
            .state
            .lock()
            .unwrap()
            .session(id)
            .map(|s| s.pairing.recipient_name.clone());
        let Some(name) = name else { return };
        self.update(|state| state.notice = Some(format!("{name} removed this pairing")));
        self.forget(id);
    }

    /// Forget a pairing here without telling the server.
    fn forget(&self, id: &str) {
        self.stop(id);
        self.config.persistence.delete_pairing(id);
        self.config.persistence.save_outbox(&[], id);
        self.update(|state| state.sessions.retain(|session| session.id() != id));
    }
}

struct Handlers {
    store: Weak<Inner>,
    id: String,
    generation: u64,
}

impl Handlers {
    fn current(&self) -> Option<Arc<Inner>> {
        self.store
            .upgrade()
            .filter(|inner| inner.current.lock().unwrap().get(&self.id) == Some(&self.generation))
    }
}

impl LiveHandlers for Handlers {
    fn on_resync(&self) {
        if let Some(inner) = self.current() {
            inner.resync(&self.id);
        }
    }

    fn on_tap(&self, tap: Tap) {
        if let Some(inner) = self.current() {
            inner.merge(&self.id, tap);
        }
    }

    fn on_tap_deleted(&self, tap_id: String) {
        if let Some(inner) = self.current() {
            inner.update_session(&self.id, |session| session.taps.retain(|tap| tap.id != tap_id));
        }
    }

    fn on_status(&self, status: LiveStatus) {
        if let Some(inner) = self.current() {
            inner.update_session(&self.id, |session| session.status = status);
        }
    }

    fn on_revoked(&self) {
        if let Some(inner) = self.current() {
            inner.revoked(&self.id);
        }
    }
}
