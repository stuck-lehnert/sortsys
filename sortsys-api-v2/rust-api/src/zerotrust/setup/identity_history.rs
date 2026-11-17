//! Certificates are appended; a separate checked head selects the active key.
use super::super::crypto::{identifier, invalid, revision, sized};
use super::IdentityCertificate;
use crate::{
    control::{Transaction, key},
    error::{ErrorCode, RpcError, RpcResult, internal},
};
use sortsys_zerotrust::metadata::RecordKey;

fn identity_index(certificate: &IdentityCertificate) -> RpcResult<String> {
    identifier(&certificate.user)?;
    let generation = revision(&certificate.generation)?;
    Ok(format!("{generation:020}:{}", certificate.user))
}

pub(in crate::zerotrust) fn identity_head_key(
    certificate: &IdentityCertificate,
) -> RpcResult<RecordKey> {
    Ok(key("identity-heads", &identity_index(certificate)?))
}

fn historical_key(certificate: &IdentityCertificate, signature: &str) -> RpcResult<RecordKey> {
    sized::<64>(signature)?;
    Ok(key(
        "identity-history",
        &format!("{}:{signature}", identity_index(certificate)?),
    ))
}

fn initial_key(certificate: &IdentityCertificate) -> RpcResult<RecordKey> {
    Ok(key("identity-history", &identity_index(certificate)?))
}

pub(in crate::zerotrust) fn identity_history_key(
    certificate: &IdentityCertificate,
) -> RpcResult<RecordKey> {
    if certificate.previous_signature.is_none() {
        return initial_key(certificate);
    }
    historical_key(certificate, &certificate.signature)
}

fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Identity certificate changed").with_http_code(409)
}

pub(in crate::zerotrust) async fn append_identity(
    transaction: &mut Transaction,
    certificate: &IdentityCertificate,
    authority: &[u8],
) -> RpcResult<()> {
    certificate.verify(authority)?;
    let head_key = identity_head_key(certificate)?;
    let history_key = identity_history_key(certificate)?;
    let stored_head: Option<String> = transaction.read(head_key.clone()).await?;
    let initial: Option<IdentityCertificate> = transaction.read(initial_key(certificate)?).await?;
    if let Some(initial) = &initial {
        initial.verify(authority)?;
        if initial.tenant != certificate.tenant
            || initial.user != certificate.user
            || initial.generation != certificate.generation
            || initial.previous_signature.is_some()
        {
            return Err(invalid());
        }
    }
    // Before its first succession the initial certificate is the active head.
    let head = stored_head.or_else(|| initial.as_ref().map(|value| value.signature.clone()));
    let existing: Option<IdentityCertificate> = transaction.read(history_key.clone()).await?;
    if let Some(existing) = &existing
        && serde_json::to_value(existing).map_err(internal)?
            != serde_json::to_value(certificate).map_err(internal)?
    {
        return Err(invalid());
    }
    if head.as_deref() == Some(&certificate.signature) {
        if existing.is_none() {
            return Err(invalid());
        }
        return Ok(());
    }
    match head {
        Some(previous_signature) => {
            if certificate.previous_signature.as_deref() != Some(previous_signature.as_str()) {
                return Err(conflict());
            }
            let previous = match initial {
                Some(initial) if initial.signature == previous_signature => initial,
                _ => transaction
                    .read::<IdentityCertificate>(historical_key(certificate, &previous_signature)?)
                    .await?
                    .ok_or_else(invalid)?,
            };
            previous.verify(authority)?;
            certificate.succeeds(&previous)?;
        }
        None => {
            if certificate.previous_signature.is_some() || existing.is_some() {
                return Err(conflict());
            }
        }
    }
    if existing.is_none() {
        transaction.put_protected(history_key, certificate).await?;
    }
    transaction
        .put_protected(head_key, &certificate.signature)
        .await
}
