//! RPC error translation for the reusable protocol implementation.
use crate::error::{RpcError, RpcResult};

pub(super) use sortsys_zerotrust::crypto::{AccountVault, encode, frame};

pub(super) fn packet_hash(message: Vec<u8>, signature: &str) -> RpcResult<String> {
    sortsys_zerotrust::crypto::packet_hash(&message, signature).map_err(Into::into)
}

pub(super) fn decode(value: &str, maximum: usize) -> RpcResult<Vec<u8>> {
    sortsys_zerotrust::crypto::decode(value, maximum).map_err(Into::into)
}

pub(super) fn sized<const N: usize>(value: &str) -> RpcResult<[u8; N]> {
    sortsys_zerotrust::crypto::sized(value).map_err(Into::into)
}

pub(super) fn verify(key: &[u8], signature: &str, message: &[u8]) -> RpcResult<()> {
    sortsys_zerotrust::crypto::verify(key, signature, message).map_err(Into::into)
}

pub(super) fn identifier(value: &str) -> RpcResult<()> {
    sortsys_zerotrust::crypto::identifier(value).map_err(Into::into)
}

pub(super) fn revision(value: &str) -> RpcResult<i64> {
    sortsys_zerotrust::crypto::revision(value).map_err(Into::into)
}

pub(super) fn random_id() -> RpcResult<String> {
    sortsys_zerotrust::crypto::random_id().map_err(Into::into)
}

pub(super) fn invalid() -> RpcError {
    sortsys_zerotrust::Error::InvalidProtectedData.into()
}
