//! Keeps one authorized WebSocket open for server events, like `connectLive`
//! in packages/client/src/live.ts and ShouldertapCore/LiveConnection.swift.
//! Commands still go over HTTPS; this only listens. Each connect trades the
//! credential for a one-time ticket.
//!
//! Event-driven: one thread blocks in a socket read and wakes only for
//! messages, the 25s keepalive, or a reconnect backoff.

use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::api::{ApiClient, ErrorCode};
use crate::models::{ServerEvent, Tap};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveStatus {
    Connecting,
    Live,
    Offline,
}

/// Called on the connection's own thread.
pub trait LiveHandlers: Send + Sync + 'static {
    /// Refetch the authoritative snapshot. Called after every (re)connect and
    /// whenever the server says pairings changed, so a missed event is never lost.
    fn on_resync(&self);
    fn on_tap(&self, tap: Tap);
    fn on_tap_deleted(&self, tap_id: String);
    fn on_status(&self, status: LiveStatus);
    /// The credential was revoked or is no longer valid. The connection stops.
    fn on_revoked(&self);
}

const BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];
const PING_INTERVAL: Duration = Duration::from_secs(25);

pub struct LiveConnection {
    shared: Arc<Shared>,
}

struct Shared {
    api: ApiClient,
    handlers: Box<dyn LiveHandlers>,
    closed: AtomicBool,
    /// Bumped by `nudge`: the running attempt ends and a new one starts now.
    epoch: AtomicU64,
    /// The open socket's stream, so another thread can cut a blocking read short.
    stream: Mutex<Option<TcpStream>>,
    /// Wakes the backoff sleep early.
    wake: (Mutex<()>, Condvar),
}

impl LiveConnection {
    pub fn start(api: ApiClient, handlers: impl LiveHandlers) -> Self {
        let shared = Arc::new(Shared {
            api,
            handlers: Box::new(handlers),
            closed: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            stream: Mutex::new(None),
            wake: (Mutex::new(()), Condvar::new()),
        });
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("shouldertap-live".into())
            .spawn(move || worker.run())
            .expect("spawn the live connection");
        Self { shared }
    }

    /// Reconnect now, e.g. after wake: a socket that slept is often dead even
    /// when it looks open, and a fresh ticket is cheap.
    pub fn nudge(&self) {
        self.shared.epoch.fetch_add(1, Ordering::SeqCst);
        self.shared.interrupt();
    }

    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.interrupt();
    }
}

impl Drop for LiveConnection {
    fn drop(&mut self) {
        self.close();
    }
}

enum Ended {
    /// Reconnect after the backoff.
    Retry,
    /// Reconnect right away (nudged).
    Now,
    /// Stop for good.
    Stop,
}

impl Shared {
    fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn interrupt(&self) {
        if let Some(stream) = self.stream.lock().unwrap().as_ref() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        let _guard = self.wake.0.lock().unwrap();
        self.wake.1.notify_all();
    }

    fn run(self: Arc<Self>) {
        let mut attempt = 0usize;
        while !self.closed() {
            self.handlers.on_status(LiveStatus::Connecting);
            let epoch = self.epoch.load(Ordering::SeqCst);
            let ended = self.connect_once(epoch, &mut attempt);
            *self.stream.lock().unwrap() = None;
            if self.closed() {
                return;
            }
            match ended {
                Ended::Stop => return,
                Ended::Now => {
                    attempt = 0;
                    continue;
                }
                Ended::Retry => {}
            }
            if self.epoch.load(Ordering::SeqCst) != epoch {
                attempt = 0;
                continue;
            }
            self.handlers.on_status(LiveStatus::Offline);
            let delay = BACKOFF[attempt.min(BACKOFF.len() - 1)];
            attempt += 1;
            self.sleep(delay, epoch);
        }
    }

    /// Sleeps for `delay` unless closed or nudged first.
    fn sleep(&self, delay: Duration, epoch: u64) {
        let deadline = Instant::now() + delay;
        let mut guard = self.wake.0.lock().unwrap();
        loop {
            if self.closed() || self.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            guard = self.wake.1.wait_timeout(guard, deadline - now).unwrap().0;
        }
    }

    /// One connection's lifetime.
    fn connect_once(&self, epoch: u64, attempt: &mut usize) -> Ended {
        let ticket = match self.api.connect_ticket() {
            Ok(ticket) => ticket,
            Err(error) if error.code == ErrorCode::Unauthorized => {
                self.closed.store(true, Ordering::SeqCst);
                self.handlers.on_revoked();
                return Ended::Stop;
            }
            Err(_) => return Ended::Retry,
        };
        if self.closed() {
            return Ended::Stop;
        }
        let Some(url) = self.api.socket_url(&ticket.ticket) else {
            return Ended::Retry;
        };
        let Ok((mut socket, _)) = tungstenite::connect(url.as_str()) else {
            return Ended::Retry;
        };
        // Clones of the socket's stream: one to time reads out for the
        // keepalive, one for `interrupt` to cut a blocking read short.
        let Some(stream) = tcp_stream(&socket).and_then(|stream| stream.try_clone().ok()) else {
            return Ended::Retry;
        };
        *self.stream.lock().unwrap() = stream.try_clone().ok();
        // Closed or nudged while connecting: start over with the new state.
        if self.closed() || self.epoch.load(Ordering::SeqCst) != epoch {
            let _ = socket.close(None);
            return if self.closed() { Ended::Stop } else { Ended::Now };
        }

        if socket.send(Message::text("ping")).is_err() {
            return Ended::Retry;
        }
        *attempt = 0;
        self.handlers.on_status(LiveStatus::Live);
        self.handlers.on_resync();

        let mut last_ping = Instant::now();
        loop {
            let until_ping = PING_INTERVAL.saturating_sub(last_ping.elapsed());
            let _ = stream.set_read_timeout(Some(until_ping.max(Duration::from_millis(50))));
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if text.as_str() != "pong" {
                        self.handle(text.as_str());
                        if self.closed() {
                            let _ = socket.close(None);
                            return Ended::Stop;
                        }
                    }
                }
                Ok(Message::Close(_)) => return Ended::Retry,
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => {
                    return if self.closed() {
                        Ended::Stop
                    } else if self.epoch.load(Ordering::SeqCst) != epoch {
                        Ended::Now
                    } else {
                        Ended::Retry
                    };
                }
            }
            if last_ping.elapsed() >= PING_INTERVAL {
                if socket.send(Message::text("ping")).is_err() {
                    return Ended::Retry;
                }
                last_ping = Instant::now();
            }
        }
    }

    fn handle(&self, text: &str) {
        match serde_json::from_str::<ServerEvent>(text) {
            Ok(ServerEvent::Tap(tap)) => self.handlers.on_tap(tap),
            Ok(ServerEvent::TapDeleted(tap_id)) => self.handlers.on_tap_deleted(tap_id),
            Ok(ServerEvent::Revoked) => {
                self.closed.store(true, Ordering::SeqCst);
                self.handlers.on_revoked();
            }
            Ok(ServerEvent::CredentialsChanged | ServerEvent::Unknown) | Err(_) => self.handlers.on_resync(),
        }
    }
}

fn tcp_stream(socket: &WebSocket<MaybeTlsStream<TcpStream>>) -> Option<&TcpStream> {
    match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => Some(stream),
        MaybeTlsStream::NativeTls(stream) => Some(stream.get_ref()),
        _ => None,
    }
}

/// Insert or replace a tap unless the incoming copy is older. Newest first.
pub fn merge_tap(taps: &[Tap], incoming: Tap) -> Vec<Tap> {
    if taps
        .iter()
        .any(|tap| tap.id == incoming.id && tap.sequence > incoming.sequence)
    {
        return taps.to_vec();
    }
    let mut next: Vec<Tap> = taps.iter().filter(|tap| tap.id != incoming.id).cloned().collect();
    next.push(incoming);
    sort_newest_first(&mut next);
    next
}

/// Replace local state with a snapshot, keeping any newer local copies.
pub fn merge_snapshot(local: &[Tap], snapshot: &[Tap]) -> Vec<Tap> {
    let mut merged = snapshot.to_vec();
    sort_newest_first(&mut merged);
    for tap in local {
        let newer = merged
            .iter()
            .any(|server| server.id == tap.id && server.sequence < tap.sequence);
        if newer {
            merged = merge_tap(&merged, tap.clone());
        }
    }
    merged
}

fn sort_newest_first(taps: &mut [Tap]) {
    taps.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
}
