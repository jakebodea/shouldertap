//! Ported from apps/macos/Tests/ShouldertapCoreTests/StoreTests.swift: the
//! store against a stubbed server.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use shouldertap_core::api::{HttpRequest, HttpResponse};
use shouldertap_core::*;

const SNAPSHOT: &str = include_str!("../../../macos/Tests/ShouldertapCoreTests/Fixtures/snapshot.json");
const ACKED_TAP: &str = r#"{"id":"t1","senderId":"s1","senderName":"Rosa","senderColor":"rose","body":"Hi","createdAt":1,"state":"acknowledged","displayedAt":1,"acknowledgedAt":2,"acknowledgedBy":"Test","response":{"kind":"on_it"},"sequence":2}"#;

/// What a stub saw: the request path, method, token and JSON body.
#[derive(Clone)]
struct Seen {
    path: String,
    method: &'static str,
    token: Option<String>,
    body: Option<serde_json::Value>,
}

type Handler = dyn Fn(&Seen) -> (u16, String) + Send + Sync;

/// Answers from a per-test handler instead of the network, and counts calls.
struct Stub {
    handler: Box<Handler>,
    calls: Mutex<HashMap<String, usize>>,
    last: Mutex<Vec<Seen>>,
}

impl Stub {
    fn new(handler: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            handler: Box::new(handler),
            calls: Default::default(),
            last: Default::default(),
        })
    }

    fn count(&self, path: &str) -> usize {
        self.calls.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    fn body_for(&self, path: &str) -> Option<serde_json::Value> {
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

/// Clones share their contents, so a test keeps a handle on what the store saved.
#[derive(Clone, Default)]
struct MemoryPersistence {
    credential: Arc<Mutex<Option<String>>>,
    acks: Arc<Mutex<BTreeMap<String, TapResponse>>>,
}

impl MemoryPersistence {
    fn with(credential: &str) -> Self {
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

fn make_store(
    persistence: &MemoryPersistence,
    platform: DevicePlatform,
    machine: Option<&str>,
    stub: &Arc<Stub>,
) -> ReceiverStore {
    let machine = machine.map(String::from);
    ReceiverStore::new(StoreConfig {
        endpoints: Endpoints {
            server: "https://api.test".into(),
            web: "https://web.test".into(),
        },
        persistence: Box::new(persistence.clone()),
        device_name: Box::new(move || platform.label().replace("Windows PC", "Test PC")),
        platform,
        machine: Box::new(move || machine.clone()),
        transport: stub.clone(),
        ack_retry_delay: Duration::from_millis(50),
    })
}

fn eventually(condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

#[test]
fn setup_when_unpaired() {
    let stub = Stub::new(|_| (500, String::new()));
    let store = make_store(&Default::default(), DevicePlatform::Windows, None, &stub);
    assert!(!store.start());
    assert_eq!(store.state().phase, Phase::Setup);
}

#[test]
fn answering_is_saved_then_sent() {
    let persistence = MemoryPersistence::with("a.b.c");
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/taps/t1/acknowledge" {
            assert_eq!(seen.token.as_deref(), Some("a.b.c"));
            return (200, ACKED_TAP.into());
        }
        (503, String::new()) // Keep the live socket offline.
    });
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    store.respond("t1", TapResponse::on_it());
    assert!(eventually(|| store.state().pending_acks.is_empty()));
    assert!(persistence.load_pending_acks().is_empty());
    assert_eq!(store.state().taps[0].state, TapState::Acknowledged);
    assert_eq!(
        stub.body_for("/v1/taps/t1/acknowledge").unwrap(),
        serde_json::json!({"response": {"kind": "on_it"}})
    );
}

#[test]
fn offline_answers_retry_until_accepted() {
    let persistence = MemoryPersistence::with("a.b.c");
    let attempts = Arc::new(Mutex::new(0));
    let counter = attempts.clone();
    let stub = Stub::new(move |seen| {
        if seen.path != "/v1/taps/t1/acknowledge" {
            return (503, String::new());
        }
        let mut attempts = counter.lock().unwrap();
        *attempts += 1;
        if *attempts < 3 {
            (503, String::new())
        } else {
            (200, ACKED_TAP.into())
        }
    });
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    store.respond("t1", TapResponse::in_10());
    // Survives a restart while still unsent.
    assert_eq!(
        persistence.load_pending_acks(),
        BTreeMap::from([("t1".into(), TapResponse::in_10())])
    );
    assert!(eventually(|| store.state().pending_acks.is_empty()));
    assert_eq!(stub.count("/v1/taps/t1/acknowledge"), 3);
}

#[test]
fn rejected_answers_are_dropped() {
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/taps/gone/acknowledge" {
            (404, r#"{"_tag":"NotFound","message":"No such tap"}"#.into())
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    store.respond("gone", TapResponse::on_it());
    assert!(eventually(|| store.state().pending_acks.is_empty()));
}

#[test]
fn revoked_credential_returns_to_setup() {
    let persistence = MemoryPersistence::with("a.b.c");
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/connect-tickets" {
            (401, r#"{"_tag":"Unauthorized","message":"Revoked"}"#.into())
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    assert!(eventually(|| store.state().phase == Phase::Setup));
    assert_eq!(persistence.load_credential(), None);
}

#[test]
fn refresh_picks_up_the_plan() {
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/me" {
            (200, SNAPSHOT.into())
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    store.refresh();
    assert!(eventually(
        || store.state().plan.map(|plan| plan.status) == Some(PlanStatus::Trial)
    ));
    assert_eq!(store.state().recipient_name, "Jamie");
}

#[test]
fn the_overlay_shows_the_oldest_waiting_tap() {
    let snapshot = SNAPSHOT.replace(r#""state":"acknowledged""#, r#""state":"pending""#);
    let stub = Stub::new(move |seen| {
        if seen.path == "/v1/me" {
            (200, snapshot.clone())
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    store.refresh();
    assert!(eventually(|| store.state().taps.len() == 2));
    let active = store.state().active_tap().unwrap();
    assert_eq!((active.tap.id.as_str(), active.queued), ("t1", 1));
    // Answering moves on to the next one at once, before the server confirms.
    store.respond("t1", TapResponse::on_it());
    let active = store.state().active_tap().unwrap();
    assert_eq!((active.tap.id.as_str(), active.queued), ("t2", 0));
}

#[test]
fn checkout_opens_the_returned_url() {
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/checkout" && seen.method == "POST" {
            (201, r#"{"url":"https://checkout.test/ch_1"}"#.into())
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    assert_eq!(store.checkout_url().unwrap(), "https://checkout.test/ch_1");
}

#[test]
fn checkout_when_already_paid_refreshes_the_plan() {
    let paid = SNAPSHOT.replace(r#""status":"trial""#, r#""status":"paid""#);
    let stub = Stub::new(move |seen| match seen.path.as_str() {
        "/v1/checkout" => (
            409,
            r#"{"_tag":"Conflict","message":"Shouldertap is already unlocked for this inbox."}"#.into(),
        ),
        "/v1/me" => (200, paid.clone()),
        _ => (503, String::new()),
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    assert_eq!(store.checkout_url().unwrap_err().code, ErrorCode::Conflict);
    assert!(eventually(
        || store.state().plan.map(|plan| plan.status) == Some(PlanStatus::Paid)
    ));
}

#[test]
fn sender_invite_link_carries_the_code_in_the_fragment() {
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/invites" {
            (
                201,
                r#"{"kind":"sender","code":"inbox.id.secret","expiresAt":1}"#.into(),
            )
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    assert_eq!(
        store.create_sender_invite().unwrap().url,
        "https://web.test/join#inbox.id.secret"
    );
    assert_eq!(
        stub.body_for("/v1/invites").unwrap(),
        serde_json::json!({"kind": "sender"})
    );
}

#[test]
fn getting_started_sends_the_platform_and_machine_fingerprint() {
    let grant = r#"{"kind":"device","credentialId":"c1","token":"inbox.c1.secret","recipientName":"Jake"}"#;
    for machine in [Some("ab".repeat(32)), None] {
        let stub = Stub::new(move |seen| {
            if seen.path == "/v1/inboxes" {
                (201, grant.into())
            } else {
                (503, String::new())
            }
        });
        let persistence = MemoryPersistence::default();
        let store = make_store(&persistence, DevicePlatform::Windows, machine.as_deref(), &stub);
        store.start();
        store.create_inbox("Jake").unwrap();
        // Without a fingerprint the key is left out entirely, like older apps.
        let mut expected = serde_json::json!({"recipientName": "Jake", "deviceName": "Test PC", "platform": "windows"});
        if let Some(machine) = &machine {
            expected["machine"] = machine.clone().into();
        }
        assert_eq!(stub.body_for("/v1/inboxes").unwrap(), expected);
        assert_eq!(persistence.load_credential().as_deref(), Some("inbox.c1.secret"));
        assert_eq!(store.state().phase, Phase::Ready);
    }
}

#[test]
fn a_pc_joins_as_a_pc() {
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/invites/redeem" {
            (
                201,
                r#"{"kind":"device","credentialId":"c2","token":"inbox.c2.secret","recipientName":"Jake"}"#.into(),
            )
        } else {
            (503, String::new())
        }
    });
    let persistence = MemoryPersistence::default();
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    store.join(" inbox.code1234.secret12 ").unwrap();
    assert_eq!(
        stub.body_for("/v1/invites/redeem").unwrap(),
        serde_json::json!({"code": "inbox.code1234.secret12", "name": "Test PC", "platform": "windows"})
    );
    assert_eq!(persistence.load_credential().as_deref(), Some("inbox.c2.secret"));
}

#[test]
fn a_sender_invite_is_refused() {
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/invites/redeem" {
            (
                201,
                r#"{"kind":"sender","credentialId":"c2","token":"inbox.c2.secret","recipientName":"Jake"}"#.into(),
            )
        } else {
            (503, String::new())
        }
    });
    let persistence = MemoryPersistence::default();
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    let error = store
        .join("https://shouldertap.app/join#inbox123.invite12.secret1234")
        .unwrap_err();
    assert!(error.message.contains("sender invite"));
    assert_eq!(persistence.load_credential(), None);
    assert_eq!(store.state().phase, Phase::Setup);
}

/// The server keeps the last computer while an iPhone is linked; so does the PC.
#[test]
fn refused_self_removal_keeps_the_pairing() {
    let persistence = MemoryPersistence::with("inbox.dev1.secret");
    let stub = Stub::new(|seen| match seen.path.as_str() {
        "/v1/me" => (200, SNAPSHOT.into()),
        "/v1/credentials/dev1" => (
            409,
            r#"{"_tag":"Conflict","message":"This is the only computer on this inbox."}"#.into(),
        ),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    store.refresh();
    assert!(eventually(|| store.state().credential_id.as_deref() == Some("dev1")));
    assert_eq!(store.revoke("dev1").unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(store.state().phase, Phase::Ready);
    assert_eq!(persistence.load_credential().as_deref(), Some("inbox.dev1.secret"));
}

#[test]
fn removing_this_pc_forgets_it_even_offline() {
    let persistence = MemoryPersistence::with("inbox.dev1.secret");
    let stub = Stub::new(|seen| {
        if seen.path == "/v1/me" {
            (200, SNAPSHOT.into())
        } else {
            (503, String::new())
        }
    });
    let store = make_store(&persistence, DevicePlatform::Windows, None, &stub);
    store.start();
    store.refresh();
    assert!(eventually(|| store.state().credential_id.as_deref() == Some("dev1")));
    store.revoke("dev1").unwrap();
    assert_eq!(store.state().phase, Phase::Setup);
    assert_eq!(persistence.load_credential(), None);
}

#[test]
fn display_is_reported_once() {
    let snapshot = SNAPSHOT.to_string();
    let stub = Stub::new(move |seen| match seen.path.as_str() {
        "/v1/me" => (200, snapshot.clone()),
        "/v1/taps/t1/displayed" => (503, String::new()),
        _ => (503, String::new()),
    });
    let store = make_store(&MemoryPersistence::with("a.b.c"), DevicePlatform::Windows, None, &stub);
    store.start();
    store.refresh();
    assert!(eventually(|| store.state().taps.len() == 2));
    store.did_display("t1");
    // Already displayed elsewhere: nothing to report.
    store.did_display("t2");
    assert!(eventually(|| stub.count("/v1/taps/t1/displayed") == 1));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(stub.count("/v1/taps/t2/displayed"), 0);
    // A failed report is tried again next time.
    store.did_display("t1");
    assert!(eventually(|| stub.count("/v1/taps/t1/displayed") == 2));
}
