//! Serde twins of the contracts in packages/domain/src/contracts.ts, like
//! apps/macos/Sources/ShouldertapCore/Models.swift. The server is the source of
//! truth; the tests decode the fixtures the Swift tests use, so neither client
//! can drift from it silently.

use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_TAP_LENGTH: usize = 280;
pub const MAX_REPLY_LENGTH: usize = 280;
pub const MAX_NAME_LENGTH: usize = 40;

/// Epoch milliseconds, as the server sends them.
pub type Timestamp = f64;

pub fn now_ms() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PersonColor {
    Moss,
    Cobalt,
    Plum,
    Tomato,
    Ochre,
    Rose,
    Sky,
    Graphite,
}

/// `base` is the frame, `ink` is text and icons set directly on it (sRGB).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Swatch {
    pub label: &'static str,
    pub base: u32,
    pub ink: u32,
}

impl PersonColor {
    pub const ALL: [PersonColor; 8] = [
        Self::Moss,
        Self::Cobalt,
        Self::Plum,
        Self::Tomato,
        Self::Ochre,
        Self::Rose,
        Self::Sky,
        Self::Graphite,
    ];

    /// `swatches` from packages/domain/src/colors.ts.
    pub fn swatch(self) -> Swatch {
        let (label, base, ink) = match self {
            Self::Moss => ("Moss", 0x1f5a3d, 0xf4f1e8),
            Self::Cobalt => ("Cobalt", 0x2340c8, 0xf2f3fb),
            Self::Plum => ("Plum", 0x6d2657, 0xf8eef3),
            Self::Tomato => ("Tomato", 0xd9432b, 0xfff4ef),
            Self::Ochre => ("Ochre", 0xe8b022, 0x1f1a0e),
            Self::Rose => ("Rose", 0xf2c4bd, 0x3b1219),
            Self::Sky => ("Sky", 0x9cc9ec, 0x0d2233),
            Self::Graphite => ("Graphite", 0x2b2c30, 0xf1f1ee),
        };
        Swatch { label, base, ink }
    }

    /// `fallbackColor` from packages/domain/src/colors.ts: a stable color for
    /// senders who paired before colors existed.
    pub fn fallback(id: &str) -> PersonColor {
        let mut hash: u64 = 0;
        // `charCodeAt(0)` of each code point, as the web computes it.
        for character in id.chars() {
            let unit = character.encode_utf16(&mut [0; 2])[0];
            hash = (hash * 31 + u64::from(unit)) % 2_147_483_647;
        }
        Self::ALL[(hash % Self::ALL.len() as u64) as usize]
    }

    fn parse(raw: &str) -> Option<PersonColor> {
        Self::ALL
            .into_iter()
            .find(|color| color.swatch().label.eq_ignore_ascii_case(raw))
    }
}

/// Unknown colors (a newer server) fall back instead of failing the decode.
impl<'de> Deserialize<'de> for PersonColor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(PersonColor::parse(&raw).unwrap_or(PersonColor::Cobalt))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    Device,
    Sender,
}

/// What kind of device a `device` credential is: computers show taps; a
/// linked iPhone manages the inbox alongside them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    Mac,
    Windows,
    Iphone,
}

impl DevicePlatform {
    /// Macs and Windows PCs put taps on screen; an iPhone only manages.
    pub fn shows_taps(self) -> bool {
        self != Self::Iphone
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Mac => "Mac",
            Self::Windows => "Windows PC",
            Self::Iphone => "iPhone",
        }
    }
}

/// Unknown platforms (a newer server) read as a Mac instead of failing the decode.
impl<'de> Deserialize<'de> for DevicePlatform {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "windows" => Self::Windows,
            "iphone" => Self::Iphone,
            _ => Self::Mac,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ResponseKind {
    #[serde(rename = "on_it")]
    OnIt,
    #[serde(rename = "in_10")]
    In10,
    #[serde(rename = "text")]
    Text,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TapResponse {
    pub kind: ResponseKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl TapResponse {
    pub fn on_it() -> Self {
        Self {
            kind: ResponseKind::OnIt,
            text: None,
        }
    }

    pub fn in_10() -> Self {
        Self {
            kind: ResponseKind::In10,
            text: None,
        }
    }

    pub fn text(text: impl Into<String>) -> Self {
        Self {
            kind: ResponseKind::Text,
            text: Some(text.into()),
        }
    }

    /// `describeResponse` from packages/domain/src/responses.ts.
    pub fn label(&self) -> String {
        match self.kind {
            ResponseKind::OnIt => "On it".into(),
            ResponseKind::In10 => "In 10 min".into(),
            ResponseKind::Text => match self.text.as_deref().map(str::trim) {
                Some(text) if !text.is_empty() => text.into(),
                _ => "Replied".into(),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TapState {
    Pending,
    Acknowledged,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tap {
    pub id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub sender_color: PersonColor,
    pub body: String,
    pub created_at: Timestamp,
    pub state: TapState,
    pub displayed_at: Option<Timestamp>,
    pub acknowledged_at: Option<Timestamp>,
    pub acknowledged_by: Option<String>,
    pub response: Option<TapResponse>,
    pub sequence: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub kind: CredentialKind,
    pub name: String,
    /// Senders only; devices have no color.
    #[serde(default)]
    pub color: Option<PersonColor>,
    /// Devices only. Missing from servers older than iPhone linking: a Mac.
    #[serde(default)]
    pub platform: Option<DevicePlatform>,
    pub created_at: Timestamp,
    #[serde(default)]
    pub last_seen_at: Option<Timestamp>,
}

impl Credential {
    pub fn swatch_color(&self) -> PersonColor {
        self.color.unwrap_or_else(|| PersonColor::fallback(&self.id))
    }

    /// For devices: a Mac unless it says otherwise.
    pub fn device_platform(&self) -> DevicePlatform {
        self.platform.unwrap_or(DevicePlatform::Mac)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialGrant {
    pub kind: CredentialKind,
    pub credential_id: String,
    pub token: String,
    pub recipient_name: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub kind: CredentialKind,
    pub code: String,
    pub expires_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectTicket {
    pub ticket: String,
    pub expires_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    Trial,
    Paid,
    Expired,
}

/// Whether the inbox delivers taps: during its free trial, once paid for, or
/// neither (`expired`).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub status: PlanStatus,
    pub trial_ends_at: Timestamp,
}

const DAY_MS: f64 = 86_400_000.0;

impl Plan {
    /// Whole days of trial left as of `now`, rounded up: 1 on the last day,
    /// 0 once it has ended.
    pub fn days_left(&self, now: Timestamp) -> i64 {
        let remaining = self.trial_ends_at - now;
        if remaining <= 0.0 {
            return 0;
        }
        (remaining / DAY_MS).ceil() as i64
    }

    /// The status as of `now`: a trial that ran out since the last snapshot is
    /// already expired (the server refuses taps from then on too).
    pub fn current_status(&self, now: Timestamp) -> PlanStatus {
        if self.status == PlanStatus::Trial && self.days_left(now) == 0 {
            PlanStatus::Expired
        } else {
            self.status
        }
    }
}

/// Where a paired computer sends its person to pay.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Checkout {
    pub url: String,
}

/// What a paired computer sees: every pending tap plus recent history.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverSnapshot {
    pub credential_id: String,
    pub recipient_name: String,
    pub sequence: i64,
    pub taps: Vec<Tap>,
    pub credentials: Vec<Credential>,
    /// Missing from servers older than payments; the menu then shows no plan.
    /// A plan shaped differently by a newer server mustn't fail the snapshot.
    #[serde(default, deserialize_with = "lenient")]
    pub plan: Option<Plan>,
}

/// What a sender sees: only their own recent taps.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderSnapshot {
    pub credential_id: String,
    pub sender_name: String,
    pub sender_color: PersonColor,
    pub recipient_name: String,
    pub sequence: i64,
    pub taps: Vec<Tap>,
}

/// `GET /v1/me`: the shape depends on which kind of credential asked.
#[derive(Clone, Debug, PartialEq)]
pub enum Snapshot {
    Receiver(ReceiverSnapshot),
    Sender(SenderSnapshot),
}

impl<'de> Deserialize<'de> for Snapshot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let receiver = value.get("kind").and_then(|kind| kind.as_str()) == Some("device");
        let snapshot = if receiver {
            serde_json::from_value(value).map(Snapshot::Receiver)
        } else {
            serde_json::from_value(value).map(Snapshot::Sender)
        };
        snapshot.map_err(serde::de::Error::custom)
    }
}

/// Server → client WebSocket events: versioned JSON envelopes.
#[derive(Clone, Debug, PartialEq)]
pub enum ServerEvent {
    Tap(Tap),
    /// A tap was deleted, for everyone: drop it.
    TapDeleted(String),
    CredentialsChanged,
    Revoked,
    /// A newer or unknown event: resync from the snapshot instead.
    Unknown,
}

impl<'de> Deserialize<'de> for ServerEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.get("v").and_then(|v| v.as_i64()) != Some(1) {
            return Ok(Self::Unknown);
        }
        Ok(match value.get("type").and_then(|kind| kind.as_str()) {
            Some("tap") => {
                let tap = value.get("tap").cloned().unwrap_or_default();
                Self::Tap(serde_json::from_value(tap).map_err(serde::de::Error::custom)?)
            }
            Some("deleted") => match value.get("tapId").and_then(|id| id.as_str()) {
                Some(id) => Self::TapDeleted(id.to_owned()),
                None => Self::Unknown,
            },
            Some("credentials") => Self::CredentialsChanged,
            Some("revoked") => Self::Revoked,
            _ => Self::Unknown,
        })
    }
}

fn lenient<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned>(deserializer: D) -> Result<Option<T>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// `parseToken` from packages/domain/src/token.ts: `<inboxId>.<id>.<secret>`,
/// each segment 8–64 of `[A-Za-z0-9_-]`. Returns the inbox id.
pub fn token_inbox_id(value: &str) -> Option<&str> {
    let parts: Vec<&str> = value.trim().split('.').collect();
    let valid = |part: &&str| {
        (8..=64).contains(&part.len())
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    };
    (parts.len() == 3 && parts.iter().all(valid)).then(|| parts[0])
}

/// The invite code in whatever was pasted: a bare code, a link with it in the
/// fragment (`https://shouldertap.app/join#<code>`, `shouldertap://link#<code>`),
/// or either with `?code=<code>`. `inviteCode` in ShouldertapCore/Sender.swift.
pub fn invite_code(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if token_inbox_id(trimmed).is_some() {
        return Some(trimmed.into());
    }
    let url = url::Url::parse(trimmed).ok()?;
    let query = url
        .query_pairs()
        .find(|(name, _)| name == "code")
        .map(|(_, value)| value.into_owned());
    let fragment = url.fragment().map(|fragment| {
        percent_encoding::percent_decode_str(fragment)
            .decode_utf8_lossy()
            .into_owned()
    });
    [fragment, query]
        .into_iter()
        .flatten()
        .map(|candidate| candidate.trim().to_string())
        .find(|candidate| token_inbox_id(candidate).is_some())
}
