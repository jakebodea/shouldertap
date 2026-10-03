//! Ported from apps/macos/Tests/ShouldertapCoreTests/CoreTests.swift; both
//! decode the same fixtures, in the server's JSON shapes.

use std::collections::BTreeMap;

use shouldertap_core::fingerprint::{DEBUG_SALT, RELEASE_SALT, machine_fingerprint};
use shouldertap_core::*;

const SNAPSHOT: &str = include_str!("../../../macos/Tests/ShouldertapCoreTests/Fixtures/snapshot.json");
const EVENTS: &str = include_str!("../../../macos/Tests/ShouldertapCoreTests/Fixtures/events.json");
const SENDER_SNAPSHOT: &str = include_str!("../../../macos/Tests/ShouldertapCoreTests/Fixtures/sender_snapshot.json");

fn tap(id: &str, created_at: f64, sequence: i64, state: TapState) -> Tap {
    Tap {
        id: id.into(),
        sender_id: "s1".into(),
        sender_name: "Sam".into(),
        sender_color: PersonColor::Cobalt,
        body: "Hi".into(),
        created_at,
        state,
        displayed_at: None,
        acknowledged_at: None,
        acknowledged_by: None,
        response: None,
        sequence,
    }
}

fn ids(taps: &[Tap]) -> Vec<&str> {
    taps.iter().map(|tap| tap.id.as_str()).collect()
}

// Merging

#[test]
fn newest_first() {
    let merged = merge_tap(
        &[tap("a", 1.0, 1, TapState::Pending)],
        tap("b", 2.0, 1, TapState::Pending),
    );
    assert_eq!(ids(&merged), ["b", "a"]);
}

#[test]
fn older_copy_is_ignored() {
    let current = [tap("a", 1.0, 5, TapState::Acknowledged)];
    let merged = merge_tap(&current, tap("a", 1.0, 3, TapState::Pending));
    assert_eq!(merged[0].state, TapState::Acknowledged);
}

#[test]
fn newer_copy_replaces() {
    let current = [tap("a", 1.0, 3, TapState::Pending)];
    let merged = merge_tap(&current, tap("a", 1.0, 4, TapState::Acknowledged));
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].state, TapState::Acknowledged);
}

#[test]
fn snapshot_keeps_newer_local_copies() {
    let local = [tap("a", 1.0, 9, TapState::Acknowledged)];
    let snapshot = [tap("a", 1.0, 2, TapState::Pending), tap("b", 2.0, 1, TapState::Pending)];
    let merged = merge_snapshot(&local, &snapshot);
    assert_eq!(ids(&merged), ["b", "a"]);
    assert_eq!(merged.last().unwrap().sequence, 9);
}

#[test]
fn snapshot_drops_taps_the_server_forgot() {
    assert!(merge_snapshot(&[tap("old", 1.0, 1, TapState::Pending)], &[]).is_empty());
}

// Contracts

#[test]
fn decodes_receiver_snapshot() {
    let Snapshot::Receiver(snapshot) = serde_json::from_str(SNAPSHOT).unwrap() else {
        panic!("expected a receiver snapshot");
    };
    assert_eq!(snapshot.recipient_name, "Jamie");
    assert_eq!(snapshot.taps[0].response, Some(TapResponse::text("Coming")));
    assert!(
        snapshot
            .credentials
            .iter()
            .any(|c| c.kind == CredentialKind::Sender && c.color == Some(PersonColor::Rose))
    );
    assert!(
        snapshot
            .credentials
            .iter()
            .any(|c| c.kind == CredentialKind::Device && c.color.is_none())
    );
    let platform = |id: &str| {
        snapshot
            .credentials
            .iter()
            .find(|c| c.id == id)
            .unwrap()
            .device_platform()
    };
    // A device without a platform (older server) is a Mac.
    assert_eq!(platform("dev1"), DevicePlatform::Mac);
    assert_eq!(platform("dev2"), DevicePlatform::Iphone);
    assert_eq!(
        snapshot.plan,
        Some(Plan {
            status: PlanStatus::Trial,
            trial_ends_at: 1_791_990_000_000.0
        })
    );
}

/// Servers older than payments send no plan; neither does a malformed one.
#[test]
fn receiver_snapshot_tolerates_missing_plan() {
    let json = r#"{"kind":"device","credentialId":"d","recipientName":"J","sequence":0,"taps":[],"credentials":[]"#;
    for plan in ["", r#","plan":{"status":"lifetime","trialEndsAt":1}"#] {
        let Snapshot::Receiver(snapshot) = serde_json::from_str(&format!("{json}{plan}}}")).unwrap() else {
            panic!("expected a receiver snapshot");
        };
        assert_eq!(snapshot.plan, None);
    }
}

#[test]
fn decodes_sender_snapshot() {
    let Snapshot::Sender(snapshot) = serde_json::from_str(SENDER_SNAPSHOT).unwrap() else {
        panic!("expected a sender snapshot");
    };
    assert_eq!(snapshot.recipient_name, "Jamie");
    assert_eq!(snapshot.sender_color, PersonColor::Rose);
}

#[test]
fn plan_days_left_and_expiry() {
    let now = 1_790_000_000_000.0;
    let day = 86_400_000.0;
    let trial = |ends: f64| Plan {
        status: PlanStatus::Trial,
        trial_ends_at: ends,
    };
    assert_eq!(trial(now + 14.0 * day).days_left(now), 14);
    assert_eq!(trial(now + 2.5 * day).days_left(now), 3);
    assert_eq!(trial(now + 1000.0).days_left(now), 1);
    assert_eq!(trial(now + 1000.0).current_status(now), PlanStatus::Trial);
    // Ran out since the last snapshot: already expired.
    assert_eq!(trial(now - 1.0).days_left(now), 0);
    assert_eq!(trial(now - 1.0).current_status(now), PlanStatus::Expired);
    let paid = Plan {
        status: PlanStatus::Paid,
        trial_ends_at: now - day,
    };
    assert_eq!(paid.current_status(now), PlanStatus::Paid);
}

#[test]
fn decodes_events() {
    let events: Vec<ServerEvent> = serde_json::from_str(EVENTS).unwrap();
    let ServerEvent::Tap(first) = &events[0] else {
        panic!("expected a tap")
    };
    assert_eq!(first.body, "Dinner's ready");
    assert_eq!(events[1], ServerEvent::CredentialsChanged);
    assert_eq!(events[2], ServerEvent::Revoked);
    assert_eq!(events[3], ServerEvent::Unknown);
}

#[test]
fn unknown_values_fall_back() {
    let credential: Credential = serde_json::from_str(
        r#"{"id":"c","kind":"device","name":"N","color":"chartreuse","platform":"vision","createdAt":1,"lastSeenAt":null}"#,
    )
    .unwrap();
    assert_eq!(credential.color, Some(PersonColor::Cobalt));
    assert_eq!(credential.device_platform(), DevicePlatform::Mac);
    let windows: Credential = serde_json::from_str(
        r#"{"id":"c","kind":"device","name":"N","color":null,"platform":"windows","createdAt":1,"lastSeenAt":null}"#,
    )
    .unwrap();
    assert_eq!(windows.device_platform(), DevicePlatform::Windows);
}

#[test]
fn response_omits_missing_text() {
    assert_eq!(
        serde_json::to_string(&TapResponse::on_it()).unwrap(),
        r#"{"kind":"on_it"}"#
    );
    let acks = BTreeMap::from([("t1".to_string(), TapResponse::in_10())]);
    assert_eq!(serde_json::to_string(&acks).unwrap(), r#"{"t1":{"kind":"in_10"}}"#);
}

#[test]
fn response_labels() {
    assert_eq!(TapResponse::on_it().label(), "On it");
    assert_eq!(TapResponse::in_10().label(), "In 10 min");
    assert_eq!(TapResponse::text("  Coming ").label(), "Coming");
    assert_eq!(TapResponse::text(" ").label(), "Replied");
}

/// Same answers as `fallbackColor` in packages/domain/src/colors.ts.
#[test]
fn fallback_color_matches_web() {
    for (id, color) in [
        ("s1", PersonColor::Sky),
        ("abcDEF123", PersonColor::Ochre),
        ("cred_9f8e7d", PersonColor::Sky),
        ("x", PersonColor::Moss),
    ] {
        assert_eq!(PersonColor::fallback(id), color, "{id}");
    }
}

// Invite codes (SenderTests.swift)

const CODE: &str = "inbox123.invite12.secret1234";

#[test]
fn reads_invite_codes() {
    for input in [
        CODE.to_string(),
        format!("  {CODE}\n"),
        format!("https://shouldertap.app/join#{CODE}"),
        format!("http://localhost:3001/join#{CODE}"),
        format!("shouldertap://join#{CODE}"),
        format!("shouldertap://link#{CODE}"),
        format!("shouldertap://join?code={CODE}"),
        format!("https://shouldertap.app/join#{}", CODE.replace('.', "%2E")),
    ] {
        assert_eq!(invite_code(&input).as_deref(), Some(CODE), "{input}");
    }
}

#[test]
fn rejects_non_invites() {
    for input in [
        "",
        "https://shouldertap.app/join",
        "a.b.c",
        "short.invite12.secret1234",
        "x.y",
    ] {
        assert_eq!(invite_code(input), None, "{input}");
    }
}

// Client

fn api(base: &str) -> ApiClient {
    ApiClient::new(base, std::sync::Arc::new(NetworkTransport::default()))
}

#[test]
fn socket_url() {
    assert_eq!(
        api("https://api.shouldertap.app").socket_url("a.b.c").unwrap(),
        "wss://api.shouldertap.app/v1/connect?ticket=a.b.c"
    );
    assert_eq!(
        api("http://localhost:3000").socket_url("t").unwrap(),
        "ws://localhost:3000/v1/connect?ticket=t"
    );
}

#[test]
fn errors_map_by_status() {
    let error = ApiError::from_response(404, br#"{"_tag":"NotFound","message":"No such tap"}"#);
    assert_eq!(error.code, ErrorCode::NotFound);
    assert_eq!(error.message, "No such tap");
    assert!(!error.is_retryable());
    assert!(ApiError::from_response(503, b"").is_retryable());
    assert_eq!(ApiError::from_response(503, b"").code, ErrorCode::Network);
}

#[test]
fn payment_errors_keep_the_servers_message() {
    let paused = ApiError::from_response(402, br#"{"_tag":"PaymentRequired","message":"Taps are paused."}"#);
    assert_eq!(paused.code, ErrorCode::PaymentRequired);
    assert!(!paused.is_retryable());
    assert_eq!(paused.to_string(), "Taps are paused.");
    let unavailable = ApiError::from_response(
        503,
        br#"{"_tag":"Unavailable","message":"Payments aren't set up here yet."}"#,
    );
    assert_eq!(unavailable.code, ErrorCode::Unavailable);
    assert_eq!(unavailable.to_string(), "Payments aren't set up here yet.");
}

// Trial fingerprint

const UUID: &str = "00000000-0000-0000-0000-000000000001";

#[test]
fn fingerprint_matches_the_mac() {
    // printf '%s' "shouldertap-trial-v1:<uuid>" | shasum -a 256
    assert_eq!(
        machine_fingerprint(UUID, RELEASE_SALT).unwrap(),
        "83b90d91bc723de2adebfb2d1dded3800d545d2035b796293f916e0cf83c8924"
    );
    assert_eq!(
        machine_fingerprint(UUID, DEBUG_SALT).unwrap(),
        "e3d40e566b8ccefa7ef227c07c3e5b9940ea072a8c1e6e0fb5db0731c371107e"
    );
    assert_eq!(machine_fingerprint("", RELEASE_SALT), None);
}

// Persistence

struct MemoryVault {
    token: std::sync::Mutex<Option<String>>,
    failing: bool,
}

impl CredentialVault for MemoryVault {
    fn read(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }
    fn write(&self, token: &str) -> Result<(), String> {
        if self.failing {
            return Err("locked".into());
        }
        *self.token.lock().unwrap() = Some(token.into());
        Ok(())
    }
    fn delete(&self) {
        *self.token.lock().unwrap() = None;
    }
}

fn temporary_directory() -> std::path::PathBuf {
    let unique = format!("shouldertap-test-{}-{}", std::process::id(), now_ms());
    std::env::temp_dir()
        .join(unique)
        .join(format!("{:?}", std::thread::current().id()))
}

#[test]
fn persistence_round_trips() {
    let directory = temporary_directory();
    let store = LocalPersistence::new(directory.clone(), None);
    assert_eq!(store.load_credential(), None);
    store.save_credential("inbox.id.secret").unwrap();
    assert_eq!(store.load_credential().as_deref(), Some("inbox.id.secret"));
    store.delete_credential();
    assert_eq!(store.load_credential(), None);

    let acks = BTreeMap::from([("t1".to_string(), TapResponse::in_10())]);
    store.save_pending_acks(&acks);
    assert_eq!(store.load_pending_acks(), acks);
    store.save_pending_acks(&BTreeMap::new());
    assert!(store.load_pending_acks().is_empty());
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn moves_a_file_credential_into_the_vault() {
    let directory = temporary_directory();
    LocalPersistence::new(directory.clone(), None)
        .save_credential("inbox.id.secret")
        .unwrap();
    let vault = std::sync::Arc::new(MemoryVault {
        token: Default::default(),
        failing: false,
    });

    struct Shared(std::sync::Arc<MemoryVault>);
    impl CredentialVault for Shared {
        fn read(&self) -> Option<String> {
            self.0.read()
        }
        fn write(&self, token: &str) -> Result<(), String> {
            self.0.write(token)
        }
        fn delete(&self) {
            self.0.delete()
        }
    }

    let store = LocalPersistence::new(directory.clone(), Some(Box::new(Shared(vault.clone()))));
    assert_eq!(store.load_credential().as_deref(), Some("inbox.id.secret"));
    assert_eq!(vault.read().as_deref(), Some("inbox.id.secret"));
    assert!(!directory.join("credential.secret").exists());
    store.delete_credential();
    assert_eq!(store.load_credential(), None);
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn keeps_the_file_when_the_vault_fails() {
    let directory = temporary_directory();
    LocalPersistence::new(directory.clone(), None)
        .save_credential("inbox.id.secret")
        .unwrap();
    let vault = MemoryVault {
        token: Default::default(),
        failing: true,
    };
    let store = LocalPersistence::new(directory.clone(), Some(Box::new(vault)));
    assert_eq!(store.load_credential().as_deref(), Some("inbox.id.secret"));
    // Still readable next launch: the file stays until a write succeeds.
    assert_eq!(
        LocalPersistence::new(directory.clone(), None)
            .load_credential()
            .as_deref(),
        Some("inbox.id.secret")
    );
    let _ = std::fs::remove_dir_all(directory);
}
