//! Ported from apps/macos/Tests/ShouldertapCoreTests/SenderTests.swift: the
//! sender store against a stubbed server, and its files on disk.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MemorySenderPersistence, Stub, eventually};
use shouldertap_core::*;

const SENDER_SNAPSHOT: &str = include_str!("../../../macos/Tests/ShouldertapCoreTests/Fixtures/sender_snapshot.json");
const SENDER_GRANT: &str =
    r#"{"kind":"sender","credentialId":"s1","token":"inbox123.s1s1s1s1.secret5678","recipientName":"Jamie"}"#;

fn pairing(id: &str, color: Option<PersonColor>) -> SenderPairing {
    SenderPairing {
        token: format!("inbox123.{id}.secret5678"),
        credential_id: id.into(),
        recipient_name: "Jamie".into(),
        sender_name: "Rosa".into(),
        color,
        paired_at: 1.0,
    }
}

fn rosa() -> MemorySenderPersistence {
    MemorySenderPersistence::with(vec![pairing("s1s1s1s1", Some(PersonColor::Rose))])
}

fn sent_tap(body: &str) -> String {
    format!(
        r#"{{"id":"t9","senderId":"s1","senderName":"Rosa","senderColor":"rose","body":"{body}","createdAt":5,"state":"pending","displayedAt":null,"acknowledgedAt":null,"acknowledgedBy":null,"response":null,"sequence":7}}"#
    )
}

fn make_store(persistence: &MemorySenderPersistence, stub: &Arc<Stub>) -> SenderStore {
    SenderStore::new(SenderConfig {
        server: "https://api.test".into(),
        persistence: Box::new(persistence.clone()),
        transport: stub.clone(),
    })
}

fn session(store: &SenderStore) -> SenderSession {
    store.state().sessions[0].clone()
}

#[test]
fn request_ids_fit_the_contract() {
    let id = new_request_id();
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()), "{id}");
    assert_ne!(id, new_request_id());
}

/// A key as `/account/sync` and `/account/accept` hand it out.
fn synced(grant: &str) -> SyncedSender {
    serde_json::from_str(&format!(
        r#"{{"id":"inbox123:s1","grant":{grant},"name":"Rosa","color":"plum"}}"#
    ))
    .unwrap()
}

#[test]
fn a_key_from_the_account_is_kept_and_connected() {
    let persistence = MemorySenderPersistence::default();
    let stub = Stub::new(|_| (503, String::new()));
    let store = make_store(&persistence, &stub);
    let id = store.add(&synced(SENDER_GRANT)).unwrap();
    assert_eq!(id, "s1");
    let pairing = session(&store).pairing;
    assert_eq!(pairing.recipient_name, "Jamie");
    assert_eq!(pairing.sender_name, "Rosa");
    assert_eq!(pairing.color, Some(PersonColor::Plum));
    let saved: Vec<String> = persistence.load_pairings().into_iter().map(|p| p.token).collect();
    assert_eq!(saved, ["inbox123.s1s1s1s1.secret5678"]);
    assert_eq!(store.tokens(), ["inbox123.s1s1s1s1.secret5678"]);
    // It connects like a saved pairing: a ticket for its socket.
    assert!(eventually(|| stub.count("/v1/connect-tickets") >= 1));
}

#[test]
fn a_device_key_is_not_a_person_to_tap() {
    let persistence = MemorySenderPersistence::default();
    let store = make_store(&persistence, &Stub::new(|_| (503, String::new())));
    let device =
        r#"{"kind":"device","credentialId":"d1","token":"inbox123.d1d1d1d1.secret5678","recipientName":"Jamie"}"#;
    let error = store.add(&synced(device)).unwrap_err();
    assert_eq!(error.message, "That isn't a key to tap someone.");
    assert_eq!(persistence.load_pairings(), []);
}

#[test]
fn a_new_key_for_the_same_person_replaces_the_old_one_and_keeps_unsent_taps() {
    let persistence = MemorySenderPersistence::with(vec![pairing("s1", Some(PersonColor::Rose))]);
    let unsent = OutgoingTap {
        request_id: "r1".into(),
        body: "Hi".into(),
        created_at: 1.0,
        failed: true,
        error: Some("Nope".into()),
    };
    persistence.save_outbox(std::slice::from_ref(&unsent), "s1");
    let store = make_store(&persistence, &Stub::new(|_| (503, String::new())));
    store.start();
    store.add(&synced(SENDER_GRANT)).unwrap();
    let state = store.state();
    let tokens: Vec<&str> = state.sessions.iter().map(|s| s.pairing.token.as_str()).collect();
    assert_eq!(tokens, ["inbox123.s1s1s1s1.secret5678"]);
    assert_eq!(state.sessions[0].outbox, [unsent]);
}

#[test]
fn forgetting_tokens_drops_only_their_pairings() {
    let persistence = MemorySenderPersistence::with(vec![
        pairing("aaaaaaaa", Some(PersonColor::Rose)),
        pairing("bbbbbbbb", Some(PersonColor::Moss)),
    ]);
    let stub = Stub::new(|_| (503, String::new()));
    let store = make_store(&persistence, &stub);
    store.start();
    store.forget_tokens(&["inbox123.aaaaaaaa.secret5678".to_string()]);
    let ids: Vec<String> = store.state().sessions.iter().map(|s| s.id().to_string()).collect();
    assert_eq!(ids, ["bbbbbbbb"]);
    let saved: Vec<String> = persistence
        .load_pairings()
        .into_iter()
        .map(|p| p.credential_id)
        .collect();
    assert_eq!(saved, ["bbbbbbbb"]);
    // Gone already: nothing to revoke.
    assert_eq!(stub.count("/v1/credentials/aaaaaaaa"), 0);
}

#[test]
fn sends_with_a_request_id_and_merges_the_tap() {
    let persistence = rosa();
    let stub = Stub::new(|seen| {
        if seen.path != "/v1/taps" {
            return (503, String::new());
        }
        let body = seen.body.as_ref().unwrap();
        (201, sent_tap(body["body"].as_str().unwrap()))
    });
    let store = make_store(&persistence, &stub);
    store.start();
    store.send("s1s1s1s1", "  Dinner's ready ").unwrap();
    assert_eq!(session(&store).outbox[0].body, "Dinner's ready");
    assert!(eventually(|| session(&store).outbox.is_empty()));
    assert_eq!(session(&store).taps[0].body, "Dinner's ready");
    assert_eq!(persistence.load_outbox("s1s1s1s1"), []);

    let body = stub.body_for("/v1/taps").unwrap();
    assert_eq!(body["body"], "Dinner's ready");
    assert_eq!(body["requestId"].as_str().unwrap().len(), 32);
}

#[test]
fn sends_carry_the_pairing_token() {
    let tokens = Arc::new(Mutex::new(Vec::new()));
    let seen_tokens = tokens.clone();
    let stub = Stub::new(move |seen| {
        if seen.path != "/v1/taps" {
            return (503, String::new());
        }
        seen_tokens.lock().unwrap().push(seen.token.clone());
        (201, sent_tap("Hi"))
    });
    let store = make_store(&rosa(), &stub);
    store.start();
    store.send("s1s1s1s1", "Hi").unwrap();
    assert!(eventually(|| session(&store).outbox.is_empty()));
    assert_eq!(
        *tokens.lock().unwrap(),
        [Some("inbox123.s1s1s1s1.secret5678".to_string())]
    );
}

#[test]
fn rejects_empty_and_overlong_drafts() {
    let store = make_store(&rosa(), &Stub::new(|_| (503, String::new())));
    store.start();
    assert_eq!(store.send("s1s1s1s1", "   "), Err(SendError::Empty));
    assert_eq!(store.send("s1s1s1s1", &"a".repeat(281)), Err(SendError::TooLong));
    assert_eq!(SendError::TooLong.to_string(), "Taps are 280 characters at most.");
    // Exactly at the limit is fine.
    assert_eq!(store.send("s1s1s1s1", &"é".repeat(280)), Ok(()));
    assert_eq!(session(&store).outbox.len(), 1);
}

#[test]
fn offline_sends_keep_their_request_id_until_accepted() {
    let persistence = rosa();
    let ids = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen_ids = ids.clone();
    let stub = Stub::new(move |seen| match seen.path.as_str() {
        "/v1/taps" => {
            let body = seen.body.as_ref().unwrap();
            let mut ids = seen_ids.lock().unwrap();
            ids.push(body["requestId"].as_str().unwrap().into());
            if ids.len() < 2 {
                (503, String::new())
            } else {
                (201, sent_tap(body["body"].as_str().unwrap()))
            }
        }
        "/v1/me" => (200, SENDER_SNAPSHOT.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, &stub);
    store.start();
    store.send("s1s1s1s1", "Hi").unwrap();
    assert!(eventually(|| stub.count("/v1/taps") == 1));
    std::thread::sleep(Duration::from_millis(50));
    assert!(!session(&store).outbox[0].failed);
    assert_eq!(persistence.load_outbox("s1s1s1s1").len(), 1);

    store.refresh("s1s1s1s1");
    assert!(eventually(|| session(&store).outbox.is_empty()));
    let ids = ids.lock().unwrap().clone();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1]);
    let tap_ids: Vec<String> = session(&store).taps.iter().map(|tap| tap.id.clone()).collect();
    // The accepted send, then the snapshot's two, newest first.
    assert_eq!(tap_ids, ["t2", "t1", "t9"]);
}

#[test]
fn refused_sends_are_marked_failed_then_retried() {
    let stub = Stub::new(|seen| match seen.path.as_str() {
        "/v1/taps" => (400, r#"{"_tag":"InvalidRequest","message":"Nope"}"#.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&rosa(), &stub);
    store.start();
    store.send("s1s1s1s1", "Hi").unwrap();
    assert!(eventually(|| session(&store).outbox[0].failed));
    assert_eq!(session(&store).outbox[0].error.as_deref(), Some("Nope"));
    let first = session(&store).outbox[0].request_id.clone();

    store.retry("s1s1s1s1", &first);
    assert!(eventually(|| stub.count("/v1/taps") == 2));
    // Try again is a fresh request, still one row.
    let outbox = session(&store).outbox;
    assert_eq!(outbox.len(), 1);
    assert_ne!(outbox[0].request_id, first);
    assert_eq!(outbox[0].body, "Hi");

    store.discard("s1s1s1s1", &outbox[0].request_id);
    assert_eq!(session(&store).outbox, []);
}

#[test]
fn a_paused_inbox_fails_with_its_message_and_is_not_retried() {
    let paused = "Jamie's Shouldertap trial has ended, so taps are paused.";
    let stub = Stub::new(move |seen| match seen.path.as_str() {
        "/v1/taps" => (402, format!(r#"{{"_tag":"PaymentRequired","message":"{paused}"}}"#)),
        "/v1/me" => (200, SENDER_SNAPSHOT.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&rosa(), &stub);
    store.start();
    store.send("s1s1s1s1", "Hi").unwrap();
    assert!(eventually(|| session(&store).outbox[0].failed));
    assert_eq!(session(&store).outbox[0].error.as_deref(), Some(paused));
    // A resync pushes queued sends again, but not refused ones.
    store.refresh("s1s1s1s1");
    assert!(eventually(|| session(&store).loaded));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(stub.count("/v1/taps"), 1);
}

#[test]
fn a_refused_key_on_send_forgets_the_pairing() {
    let persistence = rosa();
    let stub = Stub::new(|seen| match seen.path.as_str() {
        "/v1/taps" => (401, r#"{"_tag":"Unauthorized","message":"Revoked"}"#.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, &stub);
    store.start();
    store.send("s1s1s1s1", "Hi").unwrap();
    assert!(eventually(|| store.state().sessions.is_empty()));
    assert_eq!(store.state().notice.as_deref(), Some("Jamie removed this pairing"));
    assert_eq!(persistence.load_pairings(), []);
    assert_eq!(persistence.load_outbox("s1s1s1s1"), []);
    store.clear_notice();
    assert_eq!(store.state().notice, None);
}

#[test]
fn the_snapshot_fills_a_missing_color() {
    let persistence = MemorySenderPersistence::with(vec![pairing("s1s1s1s1", None)]);
    let stub = Stub::new(|seen| match seen.path.as_str() {
        "/v1/me" => (200, SENDER_SNAPSHOT.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, &stub);
    store.start();
    store.refresh("s1s1s1s1");
    assert!(eventually(|| session(&store).loaded));
    assert_eq!(session(&store).color(), PersonColor::Rose);
    assert_eq!(persistence.load_pairings()[0].color, Some(PersonColor::Rose));
}

#[test]
fn deleting_a_tap_that_is_already_gone_counts() {
    let stub = Stub::new(|seen| match (seen.method, seen.path.as_str()) {
        ("GET", "/v1/me") => (200, SENDER_SNAPSHOT.into()),
        ("DELETE", "/v1/taps/t2") => (404, r#"{"_tag":"NotFound","message":"No such tap"}"#.into()),
        ("DELETE", "/v1/taps/t1") => (500, String::new()),
        _ => (503, String::new()),
    });
    let store = make_store(&rosa(), &stub);
    store.start();
    store.refresh("s1s1s1s1");
    assert!(eventually(|| session(&store).taps.len() == 2));
    store.delete_tap("s1s1s1s1", "t2").unwrap();
    assert_eq!(store.delete_tap("s1s1s1s1", "t1").unwrap_err().code, ErrorCode::Network);
    let left: Vec<String> = session(&store).taps.iter().map(|tap| tap.id.clone()).collect();
    assert_eq!(left, ["t1"]);
}

#[test]
fn unpairing_revokes_this_key() {
    let persistence = rosa();
    let stub = Stub::new(|seen| match seen.method {
        "DELETE" => (200, r#"{"revoked":true}"#.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, &stub);
    store.start();
    store.unpair("s1s1s1s1");
    assert_eq!(store.state().sessions, []);
    assert_eq!(persistence.load_pairings(), []);
    assert!(eventually(|| stub.count("/v1/credentials/s1s1s1s1") == 1));
    assert_eq!(store.state().notice, None);
}

#[test]
fn deleting_data_waits_for_the_server() {
    let persistence = rosa();
    let stub = Stub::new(|seen| match (seen.method, seen.path.as_str()) {
        ("DELETE", "/v1/sender") => (200, r#"{"deleted":true}"#.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, &stub);
    store.start();
    store.delete_data("s1s1s1s1").unwrap();
    assert_eq!(stub.count("/v1/sender"), 1);
    assert_eq!(store.state().sessions, []);
    assert_eq!(persistence.load_pairings(), []);
}

#[test]
fn a_failed_deletion_keeps_the_pairing_to_try_again() {
    let persistence = rosa();
    let store = make_store(&persistence, &Stub::new(|_| (503, String::new())));
    store.start();
    assert!(store.delete_data("s1s1s1s1").is_err());
    assert_eq!(store.state().sessions.len(), 1);
    assert_eq!(persistence.load_pairings().len(), 1);
}

#[test]
fn revoked_pairings_are_forgotten() {
    let persistence = rosa();
    let stub = Stub::new(|seen| match seen.path.as_str() {
        "/v1/connect-tickets" => (401, r#"{"_tag":"Unauthorized","message":"Revoked"}"#.into()),
        _ => (503, String::new()),
    });
    let store = make_store(&persistence, &stub);
    store.start();
    assert!(eventually(|| store.state().sessions.is_empty()));
    assert_eq!(persistence.load_pairings(), []);
    assert_eq!(store.state().notice.as_deref(), Some("Jamie removed this pairing"));
}

// Files

/// Credential Manager, in memory: entries by target.
#[derive(Clone, Default)]
struct MemoryVaults(Arc<Mutex<HashMap<String, String>>>);

struct MemoryVault {
    entries: MemoryVaults,
    target: String,
}

impl CredentialVault for MemoryVault {
    fn read(&self) -> Option<String> {
        self.entries.0.lock().unwrap().get(&self.target).cloned()
    }
    fn write(&self, token: &str) -> Result<(), String> {
        self.entries.0.lock().unwrap().insert(self.target.clone(), token.into());
        Ok(())
    }
    fn delete(&self) {
        self.entries.0.lock().unwrap().remove(&self.target);
    }
}

impl MemoryVaults {
    fn factory(&self) -> SenderVaults {
        let entries = self.clone();
        Box::new(move |id| {
            Box::new(MemoryVault {
                entries: entries.clone(),
                target: format!("sender/{id}"),
            })
        })
    }
}

fn temporary_directory() -> std::path::PathBuf {
    let unique = format!("shouldertap-sender-test-{}-{}", std::process::id(), new_request_id());
    std::env::temp_dir().join(unique)
}

#[test]
fn pairings_keep_their_tokens_in_the_vault() {
    let directory = temporary_directory();
    let vaults = MemoryVaults::default();
    let files = LocalSenderPersistence::new(directory.clone(), Some(vaults.factory()));
    files
        .save_pairing(&pairing("s1s1s1s1", Some(PersonColor::Rose)))
        .unwrap();
    files.save_pairing(&pairing("s2s2s2s2", None)).unwrap();

    let reopened = LocalSenderPersistence::new(directory.clone(), Some(vaults.factory()));
    assert_eq!(
        reopened.load_pairings(),
        [pairing("s1s1s1s1", Some(PersonColor::Rose)), pairing("s2s2s2s2", None)]
    );
    let list = std::fs::read_to_string(directory.join("senders.secret")).unwrap();
    assert!(!list.contains("secret5678"), "{list}");
    assert_eq!(
        vaults.0.lock().unwrap().get("sender/s1s1s1s1").map(String::as_str),
        Some("inbox123.s1s1s1s1.secret5678")
    );

    reopened.delete_pairing("s1s1s1s1");
    assert_eq!(reopened.load_pairings(), [pairing("s2s2s2s2", None)]);
    assert_eq!(vaults.0.lock().unwrap().get("sender/s1s1s1s1"), None);
    reopened.delete_pairing("s2s2s2s2");
    assert!(!directory.join("senders.secret").exists());
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn without_a_vault_pairings_and_outboxes_stay_in_files() {
    let directory = temporary_directory();
    let files = LocalSenderPersistence::new(directory.clone(), None);
    assert_eq!(files.load_pairings(), []);
    files
        .save_pairing(&pairing("s1s1s1s1", Some(PersonColor::Sky)))
        .unwrap();
    let outbox = vec![OutgoingTap {
        request_id: "0123456789abcdef0123456789abcdef".into(),
        body: "Dinner's ready".into(),
        created_at: 5.0,
        failed: true,
        error: Some("Nope".into()),
    }];
    files.save_outbox(&outbox, "s1s1s1s1");

    let reopened = LocalSenderPersistence::new(directory.clone(), None);
    assert_eq!(reopened.load_pairings(), [pairing("s1s1s1s1", Some(PersonColor::Sky))]);
    assert_eq!(reopened.load_outbox("s1s1s1s1"), outbox);
    assert_eq!(reopened.load_outbox("other"), []);
    reopened.save_outbox(&[], "s1s1s1s1");
    assert_eq!(reopened.load_outbox("s1s1s1s1"), []);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(directory.join("senders.secret"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let _ = std::fs::remove_dir_all(directory);
}
