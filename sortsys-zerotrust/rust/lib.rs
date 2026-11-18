//! Protocol primitives shared by browser clients and storage servers.
//! The crate has no HTTP framework, database driver or business-model dependency.
#![forbid(unsafe_code)]

pub mod administration;
pub mod anchors;
pub mod credentials;
pub mod crypto;
pub mod delegations;
pub mod domains;
pub mod immutable;
pub mod initialization;
pub mod journal;
pub mod key_authorities;
pub mod metadata;
pub mod migration;
pub mod object_shares;
pub mod opentimestamps;
pub mod pagination;
pub mod passkey;
pub mod policy;
pub mod prepared_payload;
pub mod protocol;
pub mod recovery;
pub mod recovery_inventory;
pub mod resource_access;
pub mod webauthn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Invalid protected data")]
    InvalidProtectedData,
}

pub type Result<T> = std::result::Result<T, Error>;
pub use crypto::AccountVault;
