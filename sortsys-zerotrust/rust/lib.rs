//! Protocol primitives shared by browser clients and storage servers.
//! The crate has no HTTP framework, database driver or business-model dependency.
#![forbid(unsafe_code)]

pub mod anchors;
pub mod crypto;
pub mod delegations;
pub mod immutable;
pub mod initialization;
pub mod journal;
pub mod metadata;
pub mod migration;
pub mod opentimestamps;
pub mod pagination;
pub mod passkey;
pub mod policy;
pub mod protocol;
pub mod recovery;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Invalid protected data")]
    InvalidProtectedData,
}

pub type Result<T> = std::result::Result<T, Error>;
pub use crypto::AccountVault;
