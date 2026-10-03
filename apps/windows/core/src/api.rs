//! The HTTP half of the protocol (`ShouldertapApi` in packages/domain/src/api.ts),
//! like ShouldertapCore/APIClient.swift. Realtime events arrive over `live`.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::models::*;

/// A failed API call with a stable `code`, mirroring `ApiError` in
/// packages/client/src/api.ts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    pub status: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidRequest,
    Unauthorized,
    PaymentRequired,
    NotFound,
    Conflict,
    Expired,
    RateLimited,
    /// The server said a dependency (e.g. payments) isn't available.
    Unavailable,
    Network,
}

impl ApiError {
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Network,
            message: message.into(),
            status: 0,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::InvalidRequest,
            message: message.into(),
            status: 400,
        }
    }

    /// Transport failures and server errors are worth retrying; typed domain
    /// failures (not found, invalid, …) are not.
    pub fn is_retryable(&self) -> bool {
        self.code == ErrorCode::Network || self.status >= 500
    }

    pub fn from_response(status: u16, body: &[u8]) -> Self {
        #[derive(Deserialize)]
        struct ErrorBody {
            #[serde(rename = "_tag")]
            tag: Option<String>,
            message: String,
        }
        let decoded = serde_json::from_slice::<ErrorBody>(body).ok();
        let code = match status {
            400 => ErrorCode::InvalidRequest,
            401 => ErrorCode::Unauthorized,
            402 => ErrorCode::PaymentRequired,
            404 => ErrorCode::NotFound,
            409 => ErrorCode::Conflict,
            410 => ErrorCode::Expired,
            429 => ErrorCode::RateLimited,
            // Only the server's own 503 carries a message worth showing; a
            // proxy's is just the network.
            503 if decoded.as_ref().and_then(|body| body.tag.as_deref()) == Some("Unavailable") => {
                ErrorCode::Unavailable
            }
            _ => ErrorCode::Network,
        };
        let message = decoded
            .map(|body| body.message)
            .unwrap_or_else(|| format!("Request failed ({status})"));
        Self { code, message, status }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code == ErrorCode::Network {
            f.write_str("Couldn't reach Shouldertap. Check your connection.")
        } else {
            f.write_str(&self.message)
        }
    }
}

impl std::error::Error for ApiError {}

pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub token: Option<String>,
    /// JSON.
    pub body: Option<Vec<u8>>,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Sends one request. The app uses `NetworkTransport`; tests answer from a stub.
pub trait Transport: Send + Sync {
    /// `Err` is a transport failure (no HTTP status).
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

/// HTTPS through the system's TLS, 20s per request.
pub struct NetworkTransport {
    agent: ureq::Agent,
}

impl Default for NetworkTransport {
    fn default() -> Self {
        use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(20)))
            .user_agent(concat!("Shouldertap-Windows/", env!("CARGO_PKG_VERSION")))
            .tls_config(
                TlsConfig::builder()
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        Self { agent: agent.into() }
    }
}

impl Transport for NetworkTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let authorization = request.token.map(|token| format!("Bearer {token}"));
        let result = match (request.method, request.body) {
            ("GET", _) => with_auth(self.agent.get(&request.url), &authorization).call(),
            ("DELETE", _) => with_auth(self.agent.delete(&request.url), &authorization).call(),
            (_, Some(body)) => with_auth(self.agent.post(&request.url), &authorization)
                .header("Content-Type", "application/json")
                .send(&body[..]),
            (_, None) => with_auth(self.agent.post(&request.url), &authorization).send_empty(),
        };
        let mut response = result.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response.body_mut().read_to_vec().map_err(|error| error.to_string())?;
        Ok(HttpResponse { status, body })
    }
}

fn with_auth<B>(request: ureq::RequestBuilder<B>, authorization: &Option<String>) -> ureq::RequestBuilder<B> {
    match authorization {
        Some(value) => request.header("Authorization", value),
        None => request,
    }
}

#[derive(Clone)]
pub struct ApiClient {
    pub base_url: String,
    pub token: Option<String>,
    transport: Arc<dyn Transport>,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>, transport: Arc<dyn Transport>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        Self {
            base_url,
            token: None,
            transport,
        }
    }

    pub fn with_token(&self, token: Option<String>) -> Self {
        Self { token, ..self.clone() }
    }

    // Pairing

    /// `machine` is this computer's trial fingerprint, so setting up again
    /// keeps its original trial; None when it couldn't be read.
    pub fn create_inbox(
        &self,
        recipient_name: &str,
        device_name: &str,
        platform: DevicePlatform,
        machine: Option<&str>,
    ) -> Result<CredentialGrant, ApiError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            recipient_name: &'a str,
            device_name: &'a str,
            // Omitted for a Mac, like the Mac app (servers before Windows
            // assume one); older servers ignore it.
            #[serde(skip_serializing_if = "Option::is_none")]
            platform: Option<DevicePlatform>,
            #[serde(skip_serializing_if = "Option::is_none")]
            machine: Option<&'a str>,
        }
        let platform = (platform != DevicePlatform::Mac).then_some(platform);
        self.send(
            "POST",
            "/v1/inboxes",
            Some(&Body {
                recipient_name,
                device_name,
                platform,
                machine,
            }),
        )
    }

    /// `color` is a sender's frame color and `platform` a joining device's;
    /// the server ignores whichever doesn't apply to the invite.
    pub fn redeem_invite(
        &self,
        code: &str,
        name: &str,
        color: Option<PersonColor>,
        platform: Option<DevicePlatform>,
    ) -> Result<CredentialGrant, ApiError> {
        #[derive(Serialize)]
        struct Body<'a> {
            code: &'a str,
            name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            color: Option<PersonColor>,
            #[serde(skip_serializing_if = "Option::is_none")]
            platform: Option<DevicePlatform>,
        }
        self.send(
            "POST",
            "/v1/invites/redeem",
            Some(&Body {
                code,
                name,
                color,
                platform,
            }),
        )
    }

    // Inbox (authorized)

    pub fn me(&self) -> Result<Snapshot, ApiError> {
        self.send::<(), _>("GET", "/v1/me", None)
    }

    pub fn create_invite(&self, kind: CredentialKind) -> Result<Invite, ApiError> {
        #[derive(Serialize)]
        struct Body {
            kind: CredentialKind,
        }
        self.send("POST", "/v1/invites", Some(&Body { kind }))
    }

    pub fn mark_displayed(&self, tap_id: &str) -> Result<Tap, ApiError> {
        self.send::<(), _>("POST", &format!("/v1/taps/{}/displayed", escape(tap_id)), None)
    }

    pub fn acknowledge(&self, tap_id: &str, response: &TapResponse) -> Result<Tap, ApiError> {
        #[derive(Serialize)]
        struct Body<'a> {
            response: &'a TapResponse,
        }
        self.send(
            "POST",
            &format!("/v1/taps/{}/acknowledge", escape(tap_id)),
            Some(&Body { response }),
        )
    }

    pub fn revoke(&self, credential_id: &str) -> Result<(), ApiError> {
        #[derive(Deserialize)]
        struct Revoked {
            #[allow(dead_code)]
            revoked: bool,
        }
        self.send::<(), Revoked>("DELETE", &format!("/v1/credentials/{}", escape(credential_id)), None)
            .map(|_| ())
    }

    /// Where to pay for this inbox. `Conflict` once it's already paid for;
    /// `Unavailable` when the server has no payments set up.
    pub fn create_checkout(&self) -> Result<Checkout, ApiError> {
        self.send::<(), _>("POST", "/v1/checkout", None)
    }

    pub fn connect_ticket(&self) -> Result<ConnectTicket, ApiError> {
        self.send::<(), _>("POST", "/v1/connect-tickets", None)
    }

    /// `ws(s)://…/v1/connect?ticket=…`: the one-time ticket keeps the
    /// long-lived credential out of URLs.
    pub fn socket_url(&self, ticket: &str) -> Option<String> {
        let mut url = url::Url::parse(&self.base_url).ok()?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).ok()?;
        let path = format!("{}/v1/connect", url.path().trim_end_matches('/'));
        url.set_path(&path);
        url.query_pairs_mut().clear().append_pair("ticket", ticket);
        Some(url.into())
    }

    // Transport

    fn send<B: Serialize, R: DeserializeOwned>(
        &self,
        method: &'static str,
        path: &str,
        body: Option<&B>,
    ) -> Result<R, ApiError> {
        let body = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| ApiError::invalid(error.to_string()))?;
        let response = self
            .transport
            .send(HttpRequest {
                method,
                url: format!("{}{}", self.base_url, path),
                token: self.token.clone(),
                body,
            })
            .map_err(ApiError::network)?;
        if !(200..300).contains(&response.status) {
            return Err(ApiError::from_response(response.status, &response.body));
        }
        // The server answered with a shape we don't understand: treat as a
        // transient failure rather than acting on it.
        serde_json::from_slice(&response.body).map_err(|_| ApiError {
            code: ErrorCode::Network,
            message: "Unexpected response".into(),
            status: response.status,
        })
    }
}

/// One path segment, keeping the characters URLs leave alone.
fn escape(segment: &str) -> String {
    const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    percent_encoding::utf8_percent_encode(segment, SEGMENT).to_string()
}
