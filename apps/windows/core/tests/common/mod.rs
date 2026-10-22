//! The stubbed server the store tests share: answers from a per-test
//! handler instead of the network.
#![allow(dead_code)] // Each test binary uses its own part of it.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use shouldertap_core::api::{HttpRequest, HttpResponse};
use shouldertap_core::{
    CredentialVault, OutgoingTap, ReceiverPersistence, SenderPairing, SenderPersistence, TapResponse, Transport,
};

/// What a stub saw: the request path, method, token and JSON body.
#[derive(Clone)]
pub struct Seen {
    pub path: String,
    pub method: &'static str,
    pub token: Option<String>,
    pub body: Option<serde_json::Value>,
}

pub type Handler = dyn Fn(&Seen) -> (u16, String) + Send + Sync;

/// Answers from a per-test handler instead of the network, and counts calls.
pub struct Stub {
    handler: Box<Handler>,
    calls: Mutex<HashMap<String, usize>>,
    last: Mutex<Vec<Seen>>,
}

impl Stub {
    pub fn new(handler: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            handler: Box::new(handler),
            calls: Default::default(),
            last: Default::default(),
        })
    }

    pub fn count(&self, path: &str) -> usize {
        self.calls.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    pub fn body_for(&self, path: &str) -> Option<serde_json::Value> {
        self.last
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|seen| seen.path == path)?
            .body
            .clone()
    }

    /// The bearer token the last request to `path` carried.
    pub fn token_for(&self, path: &str) -> Option<String> {
        self.last
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|seen| seen.path == path)?
            .token
            .clone()
    }
}

impl Transport for Stub {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let path = request.url.trim_start_matches("https://api.test").to_string();
        let seen = Seen {
            path: path.clone(),
            method: request.method,
            token: request.token,
            body: request.body.and_then(|body| serde_json::from_slice(&body).ok()),
        };
        *self.calls.lock().unwrap().entry(path).or_default() += 1;
        self.last.lock().unwrap().push(seen.clone());
        let (status, body) = (self.handler)(&seen);
        Ok(HttpResponse {
            status,
            body: body.into_bytes(),
        })
    }
}

/// The receiver's saved state, in memory. Clones share their contents, so a
/// test keeps a handle on what the store saved.
#[derive(Clone, Default)]
pub struct MemoryPersistence {
    pub credential: Arc<Mutex<Option<String>>>,
    pub acks: Arc<Mutex<BTreeMap<String, TapResponse>>>,
}

impl MemoryPersistence {
    pub fn with(credential: &str) -> Self {
        Self {
            credential: Arc::new(Mutex::new(Some(credential.into()))),
            ..Default::default()
        }
    }
}

impl ReceiverPersistence for MemoryPersistence {
    fn load_credential(&self) -> Option<String> {
        self.credential.lock().unwrap().clone()
    }
    fn save_credential(&self, token: &str) -> Result<(), String> {
        *self.credential.lock().unwrap() = Some(token.into());
        Ok(())
    }
    fn delete_credential(&self) {
        *self.credential.lock().unwrap() = None;
    }
    fn load_pending_acks(&self) -> BTreeMap<String, TapResponse> {
        self.acks.lock().unwrap().clone()
    }
    fn save_pending_acks(&self, acks: &BTreeMap<String, TapResponse>) {
        *self.acks.lock().unwrap() = acks.clone();
    }
}

/// The sender's saved pairings and outboxes, in memory; clones share them.
#[derive(Clone, Default)]
pub struct MemorySenderPersistence {
    pub pairings: Arc<Mutex<Vec<SenderPairing>>>,
    pub outboxes: Arc<Mutex<HashMap<String, Vec<OutgoingTap>>>>,
}

impl MemorySenderPersistence {
    pub fn with(pairings: Vec<SenderPairing>) -> Self {
        Self {
            pairings: Arc::new(Mutex::new(pairings)),
            ..Default::default()
        }
    }
}

impl SenderPersistence for MemorySenderPersistence {
    fn load_pairings(&self) -> Vec<SenderPairing> {
        self.pairings.lock().unwrap().clone()
    }
    fn save_pairing(&self, pairing: &SenderPairing) -> Result<(), String> {
        let mut pairings = self.pairings.lock().unwrap();
        pairings.retain(|saved| saved.credential_id != pairing.credential_id);
        pairings.push(pairing.clone());
        Ok(())
    }
    fn delete_pairing(&self, credential_id: &str) {
        self.pairings
            .lock()
            .unwrap()
            .retain(|saved| saved.credential_id != credential_id);
    }
    fn load_outbox(&self, credential_id: &str) -> Vec<OutgoingTap> {
        self.outboxes
            .lock()
            .unwrap()
            .get(credential_id)
            .cloned()
            .unwrap_or_default()
    }
    fn save_outbox(&self, outbox: &[OutgoingTap], credential_id: &str) {
        self.outboxes
            .lock()
            .unwrap()
            .insert(credential_id.into(), outbox.to_vec());
    }
}

/// One Credential Manager entry, in memory; clones share it.
#[derive(Clone, Default)]
pub struct MemoryVault(pub Arc<Mutex<Option<String>>>);

impl MemoryVault {
    pub fn with(secret: &str) -> Self {
        Self(Arc::new(Mutex::new(Some(secret.into()))))
    }

    pub fn secret(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

impl CredentialVault for MemoryVault {
    fn read(&self) -> Option<String> {
        self.secret()
    }
    fn write(&self, token: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(token.into());
        Ok(())
    }
    fn delete(&self) {
        *self.0.lock().unwrap() = None;
    }
}

pub fn eventually(condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}
