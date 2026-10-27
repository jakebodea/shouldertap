//! Patron themes from this PC against a stubbed server: when to nudge, the
//! membership from the account, the device's own patron key, and what a tap
//! is sent in.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MemoryPersistence, MemorySenderPersistence, MemoryVault, Stub, eventually};
use shouldertap_core::*;

const SESSION: &str = "session-token-1";
const PATRON_KEY: &str = "stp1.patronkey.secret99";

const ACTIVE: &str = r#"{"memberships":[{"id":"pat1","name":"Jake","status":{"patron":{"active":true,"status":"active","paidUntil":1800000000000,"canManage":true,"canSubscribe":false,"keys":2}}}],"checkoutEnabled":true}"#;
const LAPSED: &str = r#"{"memberships":[{"id":"pat1","name":"Jake","status":{"patron":{"active":false,"status":"inactive","paidUntil":1700000000000,"canManage":true,"canSubscribe":true}}}],"checkoutEnabled":false}"#;
const NONE: &str = r#"{"memberships":[],"checkoutEnabled":true}"#;

#[test]
fn nudges_come_at_five_twenty_and_fifty_sends_then_stop() {
    assert!(!nudge_due(4, 0, false, true));
    assert!(nudge_due(5, 0, false, true));
    assert!(!nudge_due(19, 1, false, true));
    assert!(nudge_due(20, 1, false, true));
    assert!(nudge_due(50, 2, false, true));
    assert!(!nudge_due(999, 3, false, true));
}

#[test]
fn patrons_and_closed_checkout_are_never_nudged() {
    assert!(!nudge_due(5, 0, true, true));
    assert!(!nudge_due(5, 0, false, false));
}

/// The theme and counters, in memory; clones share them.
#[derive(Clone, Default)]
struct MemorySettings(Arc<Mutex<PatronSettings>>);

impl PatronPersistence for MemorySettings {
    fn load(&self) -> PatronSettings {
        *self.0.lock().unwrap()
    }
    fn save(&self, settings: &PatronSettings) {
        *self.0.lock().unwrap() = *settings;
    }
}

struct Fixture {
    patron: PatronStore,
    senders: SenderStore,
    key: MemoryVault,
    settings: MemorySettings,
    stub: Arc<Stub>,
}

fn fixture(
    key: MemoryVault,
    settings: PatronSettings,
    handler: impl Fn(&common::Seen) -> (u16, String) + Send + Sync + 'static,
) -> Fixture {
    let stub = Stub::new(handler);
    let receiver = ReceiverStore::new(StoreConfig {
        endpoints: Endpoints {
            server: "https://api.test".into(),
            web: "https://web.test".into(),
        },
        persistence: Box::new(MemoryPersistence::default()),
        transport: stub.clone(),
        ack_retry_delay: Duration::from_millis(50),
    });
    let pairing = SenderPairing {
        token: "inbox123.s1s1s1s1.secret5678".into(),
        credential_id: "s1s1s1s1".into(),
        recipient_name: "Jamie".into(),
        sender_name: "Rosa".into(),
        color: Some(PersonColor::Rose),
        paired_at: 1.0,
        account_id: None,
        theme: None,
        choose_seen_as: false,
    };
    let kai = SenderPairing {
        token: "inbox456.s2s2s2s2.secret9012".into(),
        credential_id: "s2s2s2s2".into(),
        recipient_name: "Kai".into(),
        paired_at: 2.0,
        ..pairing.clone()
    };
    let senders = SenderStore::new(SenderConfig {
        server: "https://api.test".into(),
        persistence: Box::new(MemorySenderPersistence::with(vec![pairing, kai])),
        transport: stub.clone(),
    });
    let account = AccountStore::new(AccountConfig {
        server: "https://api.test".into(),
        vault: Box::new(MemoryVault::with(SESSION)),
        transport: stub.clone(),
        platform: DevicePlatform::Windows,
        device_name: Box::new(|| "Studio PC".into()),
        receiver,
        senders: senders.clone(),
    });
    account.start();
    let memory = MemorySettings(Arc::new(Mutex::new(settings)));
    let patron = PatronStore::new(PatronConfig {
        account,
        senders: senders.clone(),
        vault: Box::new(key.clone()),
        persistence: Box::new(memory.clone()),
    });
    senders.start();
    Fixture {
        patron,
        senders,
        key,
        settings: memory,
        stub,
    }
}

fn sent_tap() -> String {
    r#"{"id":"t9","senderId":"s1","senderName":"Rosa","senderColor":"rose","body":"Hi","createdAt":5,"state":"pending","displayedAt":null,"acknowledgedAt":null,"acknowledgedBy":null,"response":null,"sequence":7,"theme":"note"}"#.into()
}

fn note() -> PatronSettings {
    PatronSettings {
        theme: TapTheme::Note,
        ..PatronSettings::default()
    }
}

#[test]
fn an_active_membership_gives_this_pc_its_own_key_and_themed_taps() {
    let f = fixture(MemoryVault::default(), note(), |seen| match seen.path.as_str() {
        "/account/patron/status" => (200, ACTIVE.into()),
        "/account/restore" => (200, format!(r#"{{"key":"{PATRON_KEY}"}}"#)),
        "/v1/taps" => (201, sent_tap()),
        _ => (503, String::new()),
    });
    assert_eq!(f.patron.state().sending_theme(), TapTheme::Default);

    f.patron.refresh().unwrap();
    assert_eq!(f.stub.token_for("/account/patron/status").as_deref(), Some(SESSION));
    assert_eq!(
        f.stub.body_for("/account/restore").unwrap(),
        serde_json::json!({"kind": "patron", "id": "pat1"})
    );
    assert_eq!(f.key.secret().as_deref(), Some(PATRON_KEY));
    let state = f.patron.state();
    assert!(state.active);
    assert_eq!(state.sending_theme(), TapTheme::Note);
    assert_eq!(state.membership.unwrap().paid_until, Some(1_800_000_000_000.0));

    f.senders
        .send("s1s1s1s1", "Hi", f.patron.state().sending_theme(), None)
        .unwrap();
    assert!(eventually(|| f.stub.count("/v1/taps") == 1));
    let body = f.stub.body_for("/v1/taps").unwrap();
    assert_eq!(body["theme"], "note");
    assert_eq!(body["patronKey"], PATRON_KEY);
}

/// Each person's theme as this PC would send it, by recipient.
fn sending_themes(f: &Fixture) -> Vec<(String, TapTheme)> {
    let state = f.patron.state();
    f.senders
        .state()
        .sessions
        .iter()
        .map(|session| {
            (
                session.pairing.recipient_name.clone(),
                state.sending_theme_for(&session.pairing),
            )
        })
        .collect()
}

#[test]
fn a_theme_chosen_for_one_person_leaves_the_others_on_this_pcs_own() {
    let f = fixture(MemoryVault::with(PATRON_KEY), note(), |seen| match seen.path.as_str() {
        "/account/patron/status" => (200, ACTIVE.into()),
        "/account/send-profile" => (
            200,
            r#"{"id":"inbox123:s1s1s1s1","name":"Rosa","color":"rose","theme":"terminal"}"#.into(),
        ),
        _ => (503, String::new()),
    });
    f.patron.refresh().unwrap();
    f.patron.choose_theme("s1s1s1s1", TapTheme::Terminal).unwrap();
    assert_eq!(
        f.stub.body_for("/account/send-profile").unwrap(),
        serde_json::json!({"id": "inbox123:s1s1s1s1", "name": "Rosa", "color": "rose", "theme": "terminal"})
    );
    assert_eq!(
        sending_themes(&f),
        vec![("Jamie".into(), TapTheme::Terminal), ("Kai".into(), TapTheme::Note)]
    );
}

#[test]
fn a_person_the_account_doesnt_hold_changes_this_pcs_own_theme() {
    let f = fixture(MemoryVault::with(PATRON_KEY), note(), |seen| match seen.path.as_str() {
        "/account/patron/status" => (200, ACTIVE.into()),
        "/account/send-profile" => (404, r#"{"error":"No such person"}"#.into()),
        _ => (503, String::new()),
    });
    f.patron.refresh().unwrap();
    f.patron.choose_theme("s1s1s1s1", TapTheme::Billboard).unwrap();
    assert_eq!(
        sending_themes(&f),
        vec![
            ("Jamie".into(), TapTheme::Billboard),
            ("Kai".into(), TapTheme::Billboard)
        ]
    );
}

#[test]
fn a_pc_that_holds_a_key_keeps_it() {
    let f = fixture(MemoryVault::with(PATRON_KEY), note(), |seen| match seen.path.as_str() {
        "/account/patron/status" => (200, ACTIVE.into()),
        _ => (503, String::new()),
    });
    f.patron.refresh().unwrap();
    assert_eq!(f.stub.count("/account/restore"), 0);
    assert_eq!(f.patron.state().sending_theme(), TapTheme::Note);
}

#[test]
fn a_lapsed_membership_keeps_the_key_but_sends_default() {
    let f = fixture(MemoryVault::with(PATRON_KEY), note(), |seen| match seen.path.as_str() {
        "/account/patron/status" => (200, LAPSED.into()),
        _ => (503, String::new()),
    });
    f.patron.refresh().unwrap();
    let state = f.patron.state();
    assert!(!state.active);
    assert!(!state.checkout_enabled);
    assert_eq!(state.sending_theme(), TapTheme::Default);
    assert_eq!(state.theme(), TapTheme::Note);
    assert_eq!(f.key.secret().as_deref(), Some(PATRON_KEY));
    assert!(!state.can_use(TapTheme::Broadsheet));
    assert!(state.can_use(TapTheme::Default));
}

#[test]
fn the_fifth_delivered_tap_brings_the_first_nudge() {
    let settings = PatronSettings {
        sent: 4,
        ..PatronSettings::default()
    };
    let f = fixture(MemoryVault::default(), settings, |seen| match seen.path.as_str() {
        "/account/patron/status" => (200, NONE.into()),
        "/v1/taps" => (201, sent_tap()),
        _ => (503, String::new()),
    });
    f.patron.refresh().unwrap();
    assert!(!f.patron.state().nudge_due());

    f.senders.send("s1s1s1s1", "Hi", TapTheme::Default, None).unwrap();
    assert!(eventually(|| f.patron.state().settings.sent == 5));
    assert!(f.patron.state().nudge_due());

    f.patron.nudge_shown();
    assert!(!f.patron.state().nudge_due());
    assert_eq!(
        *f.settings.0.lock().unwrap(),
        PatronSettings {
            theme: TapTheme::Default,
            sent: 5,
            nudges_shown: 1,
        }
    );
}

#[test]
fn checkout_opens_where_the_server_says_or_says_why_not() {
    let f = fixture(MemoryVault::default(), PatronSettings::default(), |seen| {
        match seen.path.as_str() {
            "/account/patron/checkout" => (200, r#"{"url":"https://pay.test/c/1"}"#.into()),
            "/account/patron/manage" => (409, r#"{"error":"Choose a membership to manage"}"#.into()),
            _ => (503, String::new()),
        }
    });
    assert_eq!(f.patron.checkout().unwrap(), "https://pay.test/c/1");
    assert_eq!(
        f.stub.body_for("/account/patron/checkout").unwrap(),
        serde_json::json!({})
    );
    assert_eq!(f.patron.manage().unwrap_err().message, "Choose a membership to manage");
}

#[test]
fn the_theme_and_counters_survive_a_restart_in_a_file() {
    let directory = std::env::temp_dir().join(format!("shouldertap-patron-{}", new_request_id()));
    let files = LocalPatronPersistence::new(directory.clone());
    assert_eq!(files.load(), PatronSettings::default());
    files.save(&PatronSettings {
        theme: TapTheme::Broadsheet,
        sent: 21,
        nudges_shown: 2,
    });
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("patron.json")).unwrap()).unwrap();
    assert_eq!(
        saved,
        serde_json::json!({"theme": "broadsheet", "sent": 21, "nudgesShown": 2})
    );
    assert_eq!(
        LocalPatronPersistence::new(directory.clone()).load(),
        PatronSettings {
            theme: TapTheme::Broadsheet,
            sent: 21,
            nudges_shown: 2,
        }
    );
    let _ = std::fs::remove_dir_all(directory);
}
