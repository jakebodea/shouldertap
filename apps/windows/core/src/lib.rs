//! Shouldertap's receiver and sender without any UI: the contracts, the HTTP
//! API client, the live socket, the stores and the account that fills them.
//! The Rust twin of apps/macos's ShouldertapCore; change the protocol in
//! packages/domain, both cores and the shared fixtures together.

pub mod account;
pub mod api;
pub mod fingerprint;
pub mod live;
pub mod models;
pub mod patron;
pub mod persistence;
pub mod sender;
pub mod store;

pub use account::{AccountConfig, AccountState, AccountStore, CODE_LENGTH, DEVICE_CLIENT_ID, WRONG_CODE};
pub use api::{
    ApiClient, ApiError, DeviceCode, DeviceSignInPoll, ErrorCode, NetworkTransport, QrSignIn, QrSignInStatus, Transport,
};
pub use live::{LiveStatus, merge_snapshot, merge_tap};
pub use models::*;
pub use patron::{
    NUDGE_MILESTONES, PatronConfig, PatronPersistence, PatronSettings, PatronState, PatronStore, nudge_due,
};
pub use persistence::{
    CredentialVault, FileVault, LocalPatronPersistence, LocalPersistence, LocalSenderPersistence, SenderVaults,
};
pub use sender::{
    OutgoingTap, SendError, SenderConfig, SenderPairing, SenderPersistence, SenderSession, SenderState, SenderStore,
    new_request_id,
};
pub use store::{
    ActiveTap, Endpoints, Phase, ReceiverPersistence, ReceiverStore, SenderInvite, StoreConfig, StoreState,
};
