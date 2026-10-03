//! Shouldertap's receiver without any UI: the contracts, the HTTP API client,
//! the live socket and the store. The Rust twin of apps/macos's
//! ShouldertapCore; change the protocol in packages/domain, both cores and the
//! shared fixtures together.

pub mod api;
pub mod fingerprint;
pub mod live;
pub mod models;
pub mod persistence;
pub mod store;

pub use api::{ApiClient, ApiError, ErrorCode, NetworkTransport, Transport};
pub use live::{LiveStatus, merge_snapshot, merge_tap};
pub use models::*;
pub use persistence::{CredentialVault, LocalPersistence};
pub use store::{
    ActiveTap, Endpoints, Phase, ReceiverPersistence, ReceiverStore, SenderInvite, StoreConfig, StoreState,
};
