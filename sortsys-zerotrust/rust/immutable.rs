//! Permanent names are part of the signed object context. Their write lock is
//! independent of decrypted flags or optional external timestamp evidence.
use crate::{
    Result,
    crypto::{identifier, invalid},
    policy::Action,
    protocol::EncryptedObject,
};

#[derive(Debug, PartialEq, Eq)]
pub struct RecordRef<'a> {
    pub kind: &'a str,
    pub id: &'a str,
}

/// Inspect the binding of an already signature-verified object. This does not
/// verify its author, permissions or existence in the application's storage.
pub fn binding<F: AsRef<str>>(envelope: &EncryptedObject<F>) -> Result<Option<RecordRef<'_>>> {
    if !envelope.object.starts_with("immutable:") {
        return Ok(None);
    }
    identifier(&envelope.scope)?;
    identifier(envelope.facet.as_ref())?;
    let prefix = format!("immutable:{}:{}:", envelope.scope, envelope.facet.as_ref());
    let suffix = envelope.object.strip_prefix(&prefix).ok_or_else(invalid)?;
    let (kind, id) = suffix.split_once(':').ok_or_else(invalid)?;
    let valid_kind = !kind.is_empty()
        && kind.len() <= 64
        && kind.as_bytes()[0].is_ascii_lowercase()
        && kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let valid_id = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid_kind || !valid_id {
        return Err(invalid());
    }
    Ok(Some(RecordRef { kind, id }))
}

/// Permanent objects permit creation only. The storage adapter must also check
/// the signature and require that no previous revision exists atomically.
pub fn write_action<F: AsRef<str>>(envelope: &EncryptedObject<F>) -> Result<Option<Action>> {
    if binding(envelope)?.is_none() {
        return Ok(None);
    }
    if envelope.format != "sortsys-object-v1" || envelope.revision != "1" {
        return Err(invalid());
    }
    Ok(Some(Action::Create))
}
