//! The account against a stubbed server (docs/onboarding.md, "Protocol"):
//! signing in with an emailed code, the You step, syncing credentials into
//! the real receiver and sender stores, invites, and leaving.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{MemoryPersistence, MemorySenderPersistence, MemoryVault, Stub, eventually};
use shouldertap_core::*;

const SESSION: &str = "session-token-1";
const INBOX_TOKEN: &str = "inbox123.dev1dev1.secret12";
const SENDER_TOKEN: &str = "inbox999.key1key1.secret34";
const OTHER_SENDER_TOKEN: &str = "inbox555.key2key2.secret56";
const INVITE: &str = "inbox999.invite12.secret1234";

const ME_WITHOUT_PROFILE: &str = r#"{"email":"jake@example.com","profile":null,"suggestedName":"Jake","inboxId":null}"#;
const ME: &str = r#"{"email":"jake@example.com","profile":{"name":"Jake","color":"moss"},"suggestedName":null,"inboxId":"inbox123"}"#;
const SAM: &str = r#"{"id":"inbox999:cred1","grant":{"kind":"sender","credentialId":"cred1","token":"inbox999.key1key1.secret34","recipientName":"Sam"},"name":"Jake","color":"moss"}"#;

/// What the account works on: real stores over memory, and the stub.
struct Fixture {
    account: AccountStore,
    receiver: ReceiverStore,
    senders: SenderStore,
    vault: MemoryVault,
    inbox: MemoryPersistence,
    pairings: MemorySenderPersistence,
    stub: Arc<Stub>,
}

fn fixture(
    vault: MemoryVault,
    inbox: MemoryPersistence,
    pairings: MemorySenderPersistence,
    handler: impl Fn(&common::Seen) -> (u16, String) + Send + Sync + 'static,
) -> Fixture {
    let stub = Stub::new(handler);
    let receiver = ReceiverStore::new(StoreConfig {
        endpoints: Endpoints {
            server: "https://api.test".into(),
            web: "https://web.test".into(),
        },
        persistence: Box::new(inbox.clone()),
        transport: stub.clone(),
        ack_retry_delay: Duration::from_millis(50),
    });
    let senders = SenderStore::new(SenderConfig {
        server: "https://api.test".into(),
        persistence: Box::new(pairings.clone()),
        transport: stub.clone(),
    });
    let account = AccountStore::new(AccountConfig {
        server: "https://api.test".into(),
        vault: Box::new(vault.clone()),
        transport: stub.clone(),
        platform: DevicePlatform::Windows,
        device_name: Box::new(|| "  Studio PC ".into()),
        receiver: receiver.clone(),
        senders: senders.clone(),
    });
    receiver.start();
    senders.start();
    account.start();
    Fixture {
        account,
        receiver,
        senders,
        vault,
        inbox,
        pairings,
        stub,
    }
}

fn signed_in(handler: impl Fn(&common::Seen) -> (u16, String) + Send + Sync + 'static) -> Fixture {
    fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::default(),
        MemorySenderPersistence::default(),
        handler,
    )
}

fn sync_answer(inbox: Option<&str>, senders: &[&str], removed: &[&str]) -> String {
    let inbox = inbox.map_or("null".to_string(), |token| {
        format!(r#"{{"kind":"device","credentialId":"dev1","token":"{token}","recipientName":"Jake"}}"#)
    });
    let removed: Vec<String> = removed.iter().map(|token| format!("\"{token}\"")).collect();
    format!(
        r#"{{"me":{ME},"inbox":{inbox},"senders":[{}],"removed":[{}]}}"#,
        senders.join(","),
        removed.join(",")
    )
}

#[test]
fn a_code_is_sent_then_traded_for_a_session() {
    let f = fixture(
        MemoryVault::default(),
        MemoryPersistence::default(),
        MemorySenderPersistence::default(),
        |seen| match seen.path.as_str() {
            "/api/auth/email-otp/send-verification-otp" => (200, r#"{"success":true}"#.into()),
            "/api/auth/sign-in/email-otp" => (
                200,
                r#"{"token":"session-token-1","user":{"email":"jake@example.com","id":"u1"}}"#.into(),
            ),
            "/account/me" => (200, ME_WITHOUT_PROFILE.into()),
            _ => (503, String::new()),
        },
    );
    assert!(!f.account.state().signed_in);

    f.account.send_code(" jake@example.com ").unwrap();
    assert_eq!(
        f.stub.body_for("/api/auth/email-otp/send-verification-otp").unwrap(),
        serde_json::json!({"email": "jake@example.com", "type": "sign-in"})
    );

    f.account.verify("jake@example.com", "123 456").unwrap();
    assert_eq!(
        f.stub.body_for("/api/auth/sign-in/email-otp").unwrap(),
        serde_json::json!({"email": "jake@example.com", "otp": "123456"})
    );
    assert_eq!(f.vault.secret().as_deref(), Some(SESSION));
    // The session is the bearer from here on.
    assert_eq!(f.stub.token_for("/account/me").as_deref(), Some(SESSION));
    let state = f.account.state();
    assert!(state.needs_profile());
    assert_eq!(state.email.as_deref(), Some("jake@example.com"));
    assert_eq!(state.me.unwrap().suggested_name.as_deref(), Some("Jake"));
    // No profile yet: nothing to sync until the You step.
    assert_eq!(f.stub.count("/account/sync"), 0);
}

#[test]
fn a_wrong_code_says_so_and_signs_nothing_in() {
    let f = fixture(
        MemoryVault::default(),
        MemoryPersistence::default(),
        MemorySenderPersistence::default(),
        |seen| match seen.path.as_str() {
            "/api/auth/sign-in/email-otp" => (400, r#"{"error":"Invalid OTP"}"#.into()),
            _ => (503, String::new()),
        },
    );
    let error = f.account.verify("jake@example.com", "000000").unwrap_err();
    assert_eq!(error.message, "That code didn't work. Check it or send a new one.");
    assert_eq!(f.vault.secret(), None);
    assert!(!f.account.state().signed_in);
}

#[test]
fn malformed_emails_and_codes_never_reach_the_server() {
    let f = fixture(
        MemoryVault::default(),
        MemoryPersistence::default(),
        MemorySenderPersistence::default(),
        |_| (200, r#"{"success":true}"#.into()),
    );
    assert_eq!(
        f.account.send_code("jake").unwrap_err().message,
        "Enter your email address."
    );
    assert_eq!(
        f.account.verify("jake@example.com", "12345").unwrap_err().message,
        "Enter the six-digit code from the email."
    );
    assert_eq!(f.stub.count("/api/auth/email-otp/send-verification-otp"), 0);
    assert_eq!(f.stub.count("/api/auth/sign-in/email-otp"), 0);
}

#[test]
fn the_you_step_then_sync_hands_out_this_pcs_credentials() {
    let f = signed_in(|seen| match seen.path.as_str() {
        "/account/me" => (200, ME_WITHOUT_PROFILE.into()),
        "/account/profile" => (200, ME.into()),
        "/account/sync" => (200, sync_answer(Some(INBOX_TOKEN), &[SAM], &[])),
        _ => (503, String::new()),
    });
    f.account.refresh().unwrap();
    assert!(f.account.state().needs_profile());

    f.account.set_profile(" Jake ", PersonColor::Moss).unwrap();
    assert_eq!(
        f.stub.body_for("/account/profile").unwrap(),
        serde_json::json!({"name": "Jake", "color": "moss"})
    );
    assert_eq!(
        f.stub.body_for("/account/sync").unwrap(),
        serde_json::json!({"platform": "windows", "deviceName": "Studio PC", "receive": true, "tokens": []})
    );
    assert_eq!(f.stub.token_for("/account/sync").as_deref(), Some(SESSION));

    // The receiver keeps and uses the inbox credential…
    assert_eq!(f.inbox.load_credential().as_deref(), Some(INBOX_TOKEN));
    assert_eq!(f.receiver.state().phase, Phase::Ready);
    // …and the sender store a key to tap Sam, as Jake in Moss.
    let pairing = f.senders.state().sessions[0].pairing.clone();
    assert_eq!(pairing.token, SENDER_TOKEN);
    assert_eq!(pairing.credential_id, "cred1");
    assert_eq!(pairing.recipient_name, "Sam");
    assert_eq!(pairing.sender_name, "Jake");
    assert_eq!(pairing.color, Some(PersonColor::Moss));
    assert_eq!(f.pairings.load_pairings().len(), 1);
    let state = f.account.state();
    assert!(!state.needs_profile());
    assert_eq!(state.profile().unwrap().name, "Jake");
}

#[test]
fn sync_sends_every_token_and_drops_the_removed_ones() {
    let pairings = MemorySenderPersistence::with(vec![
        SenderPairing {
            token: SENDER_TOKEN.into(),
            credential_id: "cred1".into(),
            recipient_name: "Sam".into(),
            sender_name: "Jake".into(),
            color: Some(PersonColor::Moss),
            paired_at: 1.0,
            account_id: None,
        },
        SenderPairing {
            token: OTHER_SENDER_TOKEN.into(),
            credential_id: "cred2".into(),
            recipient_name: "Ana".into(),
            sender_name: "Jake".into(),
            color: Some(PersonColor::Moss),
            paired_at: 2.0,
            account_id: None,
        },
    ]);
    let f = fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::with(INBOX_TOKEN),
        pairings,
        |seen| match seen.path.as_str() {
            "/account/me" => (200, ME.into()),
            "/account/sync" => (200, sync_answer(None, &[], &[OTHER_SENDER_TOKEN])),
            _ => (503, String::new()),
        },
    );
    f.account.sync().unwrap();
    assert_eq!(
        f.stub.body_for("/account/sync").unwrap()["tokens"],
        serde_json::json!([INBOX_TOKEN, SENDER_TOKEN, OTHER_SENDER_TOKEN])
    );
    let left: Vec<String> = f.senders.state().sessions.iter().map(|s| s.id().to_string()).collect();
    assert_eq!(left, ["cred1"]);
    assert_eq!(f.inbox.load_credential().as_deref(), Some(INBOX_TOKEN));
}

#[test]
fn a_removed_inbox_credential_is_forgotten_here() {
    let f = fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::with(INBOX_TOKEN),
        MemorySenderPersistence::default(),
        |seen| match seen.path.as_str() {
            "/account/me" => (200, ME.into()),
            "/account/sync" => (200, sync_answer(None, &[], &[INBOX_TOKEN])),
            _ => (503, String::new()),
        },
    );
    f.account.sync().unwrap();
    assert_eq!(f.inbox.load_credential(), None);
    assert_eq!(f.receiver.state().phase, Phase::Setup);
}

#[test]
fn a_refused_session_signs_out_but_keeps_this_pcs_credentials() {
    let f = fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::with(INBOX_TOKEN),
        MemorySenderPersistence::default(),
        |seen| match seen.path.as_str() {
            "/account/me" => (401, r#"{"error":"Sign in to continue"}"#.into()),
            _ => (503, String::new()),
        },
    );
    assert!(f.account.state().signed_in);
    let error = f.account.sync().unwrap_err();
    assert_eq!(error.message, "Your sign-in expired. Sign in again.");
    assert_eq!(
        f.account.state().sync_error.as_deref(),
        Some("Your sign-in expired. Sign in again.")
    );
    assert!(!f.account.state().signed_in);
    assert_eq!(f.vault.secret(), None);
    assert_eq!(f.inbox.load_credential().as_deref(), Some(INBOX_TOKEN));
}

#[test]
fn a_failed_sync_is_kept_to_show() {
    let f = signed_in(|seen| match seen.path.as_str() {
        "/account/me" => (200, ME.into()),
        "/account/sync" => (429, r#"{"error":"Too many requests. Try again in a minute."}"#.into()),
        _ => (503, String::new()),
    });
    let error = f.account.sync().unwrap_err();
    assert_eq!(error.code, ErrorCode::RateLimited);
    assert_eq!(
        f.account.state().sync_error.as_deref(),
        Some("Too many requests. Try again in a minute.")
    );
}

#[test]
fn accepting_an_invite_connects_you_and_keeps_your_key() {
    let f = signed_in(|seen| match seen.path.as_str() {
        "/account/accept" => (
            200,
            format!(r#"{{"person":{{"name":"Sam","color":"plum"}},"sender":{SAM},"mutual":true}}"#),
        ),
        _ => (503, String::new()),
    });
    let accepted = f
        .account
        .accept(&format!("https://shouldertap.app/join#{INVITE}"))
        .unwrap();
    assert_eq!(
        f.stub.body_for("/account/accept").unwrap(),
        serde_json::json!({"code": INVITE, "platform": "windows", "deviceName": "Studio PC"})
    );
    assert_eq!(f.stub.token_for("/account/accept").as_deref(), Some(SESSION));
    assert_eq!(accepted.person.name, "Sam");
    assert_eq!(accepted.person.color, Some(PersonColor::Plum));
    assert!(accepted.mutual);
    assert_eq!(f.senders.tokens(), [SENDER_TOKEN]);
    assert_eq!(f.senders.session_for_inbox("inbox999").as_deref(), Some("cred1"));
}

#[test]
fn your_own_invite_reads_as_the_server_says() {
    let f = signed_in(|seen| match seen.path.as_str() {
        "/account/accept" => (400, r#"{"error":"That's your own invite"}"#.into()),
        _ => (503, String::new()),
    });
    let error = f.account.accept(INVITE).unwrap_err();
    assert_eq!(error.message, "That's your own invite");
    assert_eq!(
        f.account.accept("not a link").unwrap_err().message,
        "That doesn't look like a Shouldertap invite link."
    );
    assert_eq!(f.stub.count("/account/accept"), 1);
}

#[test]
fn an_invite_preview_needs_no_session() {
    let f = signed_in(|seen| {
        if seen.path.starts_with("/v1/invites/preview") {
            (200, r#"{"name":"Sam","color":null,"expiresAt":1790000000000}"#.into())
        } else {
            (503, String::new())
        }
    });
    let preview = f.account.preview(&format!("shouldertap://join#{INVITE}")).unwrap();
    assert_eq!(preview.name, "Sam");
    assert_eq!(preview.color, None);
    assert_eq!(preview.expires_at, 1_790_000_000_000.0);
    let path = format!("/v1/invites/preview?code={INVITE}");
    assert_eq!(f.stub.count(&path), 1);
    assert_eq!(f.stub.token_for(&path), None);
}

#[test]
fn signing_out_ends_the_session_and_keeps_receiving() {
    let f = fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::with(INBOX_TOKEN),
        MemorySenderPersistence::default(),
        |seen| match seen.path.as_str() {
            "/api/auth/sign-out" => (200, r#"{"success":true}"#.into()),
            _ => (503, String::new()),
        },
    );
    f.account.sign_out().unwrap();
    assert_eq!(f.stub.token_for("/api/auth/sign-out").as_deref(), Some(SESSION));
    assert_eq!(f.vault.secret(), None);
    assert!(!f.account.state().signed_in);
    assert_eq!(f.receiver.token().as_deref(), Some(INBOX_TOKEN));
}

#[test]
fn signing_out_offline_keeps_the_session_to_try_again() {
    let f = signed_in(|_| (503, String::new()));
    assert_eq!(f.account.sign_out().unwrap_err().code, ErrorCode::Network);
    assert_eq!(f.vault.secret().as_deref(), Some(SESSION));
}

#[test]
fn deleting_the_account_signs_out() {
    let f = signed_in(|seen| match seen.path.as_str() {
        "/api/auth/delete-user" => (200, r#"{"success":true,"message":"User deleted"}"#.into()),
        _ => (503, String::new()),
    });
    f.account.delete_account().unwrap();
    assert_eq!(f.stub.token_for("/api/auth/delete-user").as_deref(), Some(SESSION));
    assert_eq!(f.vault.secret(), None);
    assert!(!f.account.state().signed_in);
}

#[test]
fn the_session_survives_a_restart_in_a_file_vault() {
    let directory = std::env::temp_dir().join(format!("shouldertap-account-test-{}", new_request_id()));
    let path = directory.join("account.secret");
    FileVault::new(path.clone()).write(SESSION).unwrap();
    assert_eq!(FileVault::new(path.clone()).read().as_deref(), Some(SESSION));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    FileVault::new(path.clone()).delete();
    assert_eq!(FileVault::new(path).read(), None);
    let _ = std::fs::remove_dir_all(directory);
}

/// Sam (from sync, with the account's id) and Ana (paired before accounts).
fn sam_and_ana() -> MemorySenderPersistence {
    MemorySenderPersistence::with(vec![
        SenderPairing {
            token: SENDER_TOKEN.into(),
            credential_id: "cred1".into(),
            recipient_name: "Sam".into(),
            sender_name: "Jake".into(),
            color: Some(PersonColor::Moss),
            paired_at: 1.0,
            account_id: Some("inbox999:cred1".into()),
        },
        SenderPairing {
            token: OTHER_SENDER_TOKEN.into(),
            credential_id: "cred2".into(),
            recipient_name: "Ana".into(),
            sender_name: "Jake".into(),
            color: Some(PersonColor::Moss),
            paired_at: 2.0,
            account_id: None,
        },
    ])
}

#[test]
fn removing_someone_ends_the_connection_on_the_account() {
    let f = fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::default(),
        sam_and_ana(),
        |seen| match seen.path.as_str() {
            "/account/remove" => (200, r#"{"removed":true}"#.into()),
            _ => (503, String::new()),
        },
    );
    f.account.remove("cred1").unwrap();
    assert_eq!(
        f.stub.body_for("/account/remove").unwrap(),
        serde_json::json!({"id": "inbox999:cred1"})
    );
    assert_eq!(f.stub.token_for("/account/remove").as_deref(), Some(SESSION));
    // An older pairing's id is its inbox and credential.
    f.account.remove("cred2").unwrap();
    assert_eq!(
        f.stub.body_for("/account/remove").unwrap(),
        serde_json::json!({"id": "inbox555:cred2"})
    );
    assert_eq!(f.pairings.load_pairings(), []);
    // Not this PC's key alone: the next sync would hand out another.
    assert_eq!(f.stub.count("/v1/credentials/key1key1"), 0);
}

#[test]
fn a_failed_removal_keeps_them_to_try_again() {
    let f = fixture(
        MemoryVault::with(SESSION),
        MemoryPersistence::default(),
        sam_and_ana(),
        |_| (503, String::new()),
    );
    assert_eq!(f.account.remove("cred1").unwrap_err().code, ErrorCode::Network);
    assert_eq!(f.senders.tokens(), [SENDER_TOKEN, OTHER_SENDER_TOKEN]);
}

#[test]
fn signed_out_removing_someone_revokes_this_pcs_key() {
    let f = fixture(
        MemoryVault::default(),
        MemoryPersistence::default(),
        sam_and_ana(),
        |seen| match seen.path.as_str() {
            "/v1/credentials/key1key1" => (200, r#"{"revoked":true}"#.into()),
            _ => (503, String::new()),
        },
    );
    f.account.remove("cred1").unwrap();
    assert_eq!(f.senders.tokens(), [OTHER_SENDER_TOKEN]);
    assert!(eventually(|| f.stub.count("/v1/credentials/key1key1") == 1));
    assert_eq!(f.stub.count("/account/remove"), 0);
}
