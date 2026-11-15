//! The framework validates proof framing and root binding. Persistence and RPC
//! error translation belong to the application. A proof never grants edits.
use crate::error::RpcResult;

pub(super) use sortsys_zerotrust::opentimestamps::MAX_BYTES;

pub(super) fn validate(bytes: &[u8], digest: &[u8; 32]) -> RpcResult<bool> {
    let summary = sortsys_zerotrust::opentimestamps::inspect(bytes, digest)?;
    Ok(summary.has_pending_attestations)
}
