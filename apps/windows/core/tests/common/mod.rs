//! The stubbed server the store tests share: answers from a per-test
//! handler instead of the network.
#![allow(dead_code)] // Each test binary uses its own part of it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use shouldertap_core::Transport;
use shouldertap_core::api::{HttpRequest, HttpResponse};

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
