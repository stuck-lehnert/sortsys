//! WebAuthn verification for ES256 resident credentials with mandatory user
//! presence and verification. Persistence, sessions and challenge consumption
//! belong to the caller's atomic transaction.
use crate::{
    Result,
    crypto::{decode, encode, frame, identifier, invalid, sized},
};
use ciborium::value::Value as Cbor;
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;
#[cfg(feature = "typescript")]
use ts_rs::TS;

const PRESENT: u8 = 0x01;
const VERIFIED: u8 = 0x04;
const BACKUP_ELIGIBLE: u8 = 0x08;
const BACKED_UP: u8 = 0x10;
const ATTESTED: u8 = 0x40;
const EXTENSIONS: u8 = 0x80;
pub const TIMEOUT_MS: u32 = 60_000;

pub fn create_challenge() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| invalid())?;
    Ok(encode(&bytes))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationCredential {
    pub id: String,
    pub raw_id: String,

    #[cfg_attr(feature = "typescript", ts(type = "\"public-key\""))]
    pub r#type: String,

    pub response: RegistrationResponse,

    #[serde(default)]
    #[cfg_attr(feature = "typescript", ts(optional = nullable))]
    pub transports: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub attestation_object: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticationCredential {
    pub id: String,
    pub raw_id: String,

    #[cfg_attr(feature = "typescript", ts(type = "\"public-key\""))]
    pub r#type: String,

    pub response: AuthenticationResponse,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticationResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,

    #[serde(default)]
    #[cfg_attr(feature = "typescript", ts(optional = nullable))]
    pub user_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CredentialDescriptor {
    pub id: String,

    #[cfg_attr(feature = "typescript", ts(type = "\"public-key\""))]
    pub r#type: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional = nullable))]
    pub transports: Option<Vec<String>>,
}

impl CredentialDescriptor {
    pub fn public_key(id: String, transports: Vec<String>) -> Self {
        Self {
            id,
            r#type: "public-key".to_owned(),
            transports: (!transports.is_empty()).then_some(transports),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub value: String,
    pub rp_id: String,
}
impl Origin {
    pub fn parse(value: &str) -> Result<Self> {
        let url = url::Url::parse(value).map_err(|_| invalid())?;
        let host = url.host_str().ok_or_else(invalid)?;
        let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
        if !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        {
            return Err(invalid());
        }
        Ok(Self {
            value: url.origin().ascii_serialization(),
            rp_id: host.into(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Es256PublicKey {
    pub x: String,
    pub y: String,
}
impl Es256PublicKey {
    fn verifying_key(&self) -> Result<VerifyingKey> {
        let mut point = Vec::with_capacity(65);
        point.push(4);
        point.extend_from_slice(&sized::<32>(&self.x)?);
        point.extend_from_slice(&sized::<32>(&self.y)?);
        VerifyingKey::from_sec1_bytes(&point).map_err(|_| invalid())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AuthenticatorState {
    pub counter: u32,
    pub backup_eligible: bool,
    pub backed_up: bool,
}
impl AuthenticatorState {
    /// Zero-counter synchronized credentials still need a one-use challenge.
    /// The caller must compare this state and consume that challenge atomically.
    pub fn follows(&self, previous: &Self) -> Result<()> {
        if self.backed_up && !self.backup_eligible
            || previous.backed_up && !previous.backup_eligible
            || self.backup_eligible != previous.backup_eligible
            || (self.counter != 0 || previous.counter != 0) && self.counter <= previous.counter
        {
            return Err(invalid());
        }
        Ok(())
    }
}

pub struct RegistrationResult {
    pub credential_id: String,
    pub rp_id: String,
    pub public_key: Es256PublicKey,
    pub state: AuthenticatorState,
}

pub fn credential_id(id: &str, raw_id: &str, kind: &str) -> Result<Vec<u8>> {
    let bytes = decode(raw_id, 1023)?;
    if kind != "public-key" || id != raw_id || bytes.is_empty() {
        return Err(invalid());
    }
    Ok(bytes)
}

/// Canonical packet commitment shared with the browser's account signature.
pub fn registration_frame(credential: &RegistrationCredential) -> Result<Vec<u8>> {
    credential_id(&credential.id, &credential.raw_id, &credential.r#type)?;
    decode(&credential.response.client_data_json, 8192)?;
    decode(&credential.response.attestation_object, 32768)?;
    let transports = credential.transports.as_deref().unwrap_or_default();
    if transports.len() > 16 {
        return Err(invalid());
    }
    for (index, transport) in transports.iter().enumerate() {
        if transport.is_empty()
            || transport.len() > 32
            || !transport
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
            || transports[..index].contains(transport)
        {
            return Err(invalid());
        }
    }
    let count = transports.len().to_string();
    let mut fields = vec![
        credential.id.as_str(),
        credential.raw_id.as_str(),
        credential.r#type.as_str(),
        credential.response.client_data_json.as_str(),
        credential.response.attestation_object.as_str(),
        count.as_str(),
    ];
    fields.extend(transports.iter().map(String::as_str));
    Ok(frame("sortsys/webauthn-registration/v1", &fields))
}

pub struct RegistrationBinding<'a> {
    pub tenant: &'a str,
    pub subject: &'a str,
    pub user_handle: &'a str,
    pub exchange_hash: &'a str,
    pub credential_hash: &'a str,
    pub key_vault_hash: &'a str,
    pub label: &'a str,
}
impl RegistrationBinding<'_> {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(self.tenant)?;
        identifier(self.subject)?;
        if decode(self.user_handle, 64)?.is_empty() {
            return Err(invalid());
        }
        sized::<32>(self.exchange_hash)?;
        sized::<32>(self.credential_hash)?;
        if !self.key_vault_hash.is_empty() {
            sized::<32>(self.key_vault_hash)?;
        }
        if self.label.is_empty()
            || self.label.trim() != self.label
            || self.label.len() > 127
            || self.label.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/passkey-registration/v1",
            &[
                self.tenant,
                self.subject,
                self.user_handle,
                self.exchange_hash,
                self.credential_hash,
                self.key_vault_hash,
                self.label,
            ],
        ))
    }
}

pub fn tenant_fingerprint(tenant: &str) -> Result<String> {
    identifier(tenant)?;
    Ok(encode(&Sha256::digest(frame(
        "sortsys/webauthn-tenant/v1",
        &[tenant],
    ))))
}

/// A tenant fingerprint and an application-owned opaque subject payload fit
/// WebAuthn's 64-byte user-handle limit without exposing a mutable login alias.
pub fn routing_user_handle(tenant: &str, subject: &[u8]) -> Result<String> {
    if subject.is_empty() || subject.len() > 31 {
        return Err(invalid());
    }
    let mut bytes = vec![1];
    bytes.extend_from_slice(&sized::<32>(&tenant_fingerprint(tenant)?)?);
    bytes.extend_from_slice(subject);
    Ok(encode(&bytes))
}

pub fn parse_routing_user_handle(encoded: &str) -> Result<(String, Vec<u8>)> {
    let bytes = decode(encoded, 64)?;
    if bytes.len() < 34 || bytes[0] != 1 {
        return Err(invalid());
    }
    Ok((encode(&bytes[1..33]), bytes[33..].to_vec()))
}

pub fn deletion_frame(tenant: &str, subject: &str, id: &str) -> Result<Vec<u8>> {
    for field in [tenant, subject, id] {
        identifier(field)?;
    }
    Ok(frame("sortsys/passkey-deletion/v1", &[tenant, subject, id]))
}

pub fn verify_registration(
    credential: &RegistrationCredential,
    challenge: &str,
    origin: &Origin,
) -> Result<RegistrationResult> {
    registration_frame(credential)?;
    verify_client_data(
        &credential.response.client_data_json,
        "webauthn.create",
        challenge,
        &origin.value,
    )?;
    let attestation = decode(&credential.response.attestation_object, 32768)?;
    let (value, consumed) = cbor(&attestation)?;
    if consumed != attestation.len() {
        return Err(invalid());
    }
    let fields = map(&value)?;
    if field(fields, &Cbor::Text("fmt".into()))? != &Cbor::Text("none".into())
        || !map(field(fields, &Cbor::Text("attStmt".into()))?)?.is_empty()
    {
        return Err(invalid());
    }
    let auth_data = match field(fields, &Cbor::Text("authData".into()))? {
        Cbor::Bytes(bytes) if bytes.len() <= 16384 => bytes.as_slice(),
        _ => return Err(invalid()),
    };
    let (flags, state) = authenticator_state(auth_data, &origin.rp_id)?;
    if flags & ATTESTED == 0 || auth_data.len() < 55 {
        return Err(invalid());
    }
    let size = u16::from_be_bytes([auth_data[53], auth_data[54]]) as usize;
    let end = 55 + size;
    if size == 0
        || size > 1023
        || end >= auth_data.len()
        || encode(&auth_data[55..end]) != credential.raw_id
    {
        return Err(invalid());
    }
    let (cose, consumed) = cbor(&auth_data[end..])?;
    extensions(&auth_data[end + consumed..], flags)?;
    let cose = map(&cose)?;
    for (label, expected) in [(1, 2), (3, -7), (-1, 1)] {
        if field(cose, &Cbor::Integer(label.into()))? != &Cbor::Integer(expected.into()) {
            return Err(invalid());
        }
    }
    let coordinate = |label: i64| -> Result<String> {
        match field(cose, &Cbor::Integer(label.into()))? {
            Cbor::Bytes(bytes) if bytes.len() == 32 => Ok(encode(bytes)),
            _ => Err(invalid()),
        }
    };
    let public_key = Es256PublicKey {
        x: coordinate(-2)?,
        y: coordinate(-3)?,
    };
    public_key.verifying_key()?;
    Ok(RegistrationResult {
        credential_id: credential.raw_id.clone(),
        rp_id: origin.rp_id.clone(),
        public_key,
        state,
    })
}

pub fn verify_authentication(
    credential: &AuthenticationCredential,
    registered: &RegistrationResult,
    challenge: &str,
    origin: &Origin,
    expected_user_handle: &str,
) -> Result<AuthenticatorState> {
    credential_id(&credential.id, &credential.raw_id, &credential.r#type)?;
    if credential.raw_id != registered.credential_id || origin.rp_id != registered.rp_id {
        return Err(invalid());
    }
    let handle = credential
        .response
        .user_handle
        .as_deref()
        .ok_or_else(invalid)?;
    if decode(handle, 64)?.is_empty() || handle != expected_user_handle {
        return Err(invalid());
    }
    let client_data = verify_client_data(
        &credential.response.client_data_json,
        "webauthn.get",
        challenge,
        &origin.value,
    )?;
    let auth_data = decode(&credential.response.authenticator_data, 16384)?;
    let (flags, state) = authenticator_state(&auth_data, &origin.rp_id)?;
    if flags & ATTESTED != 0 {
        return Err(invalid());
    }
    extensions(&auth_data[37..], flags)?;
    let mut signed = auth_data;
    signed.extend_from_slice(&Sha256::digest(client_data));
    let signature =
        Signature::from_der(&decode(&credential.response.signature, 80)?).map_err(|_| invalid())?;
    registered
        .public_key
        .verifying_key()?
        .verify(&signed, &signature)
        .map_err(|_| invalid())?;
    Ok(state)
}

fn verify_client_data(encoded: &str, kind: &str, challenge: &str, origin: &str) -> Result<Vec<u8>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ClientData {
        r#type: String,
        challenge: String,
        origin: String,
        #[serde(default)]
        cross_origin: bool,
        top_origin: Option<String>,
    }
    sized::<32>(challenge)?;
    let bytes = decode(encoded, 8192)?;
    let data: ClientData = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if data.r#type != kind
        || data.challenge != challenge
        || data.origin != origin
        || data.cross_origin
        || data.top_origin.is_some()
    {
        return Err(invalid());
    }
    Ok(bytes)
}

fn authenticator_state(bytes: &[u8], rp_id: &str) -> Result<(u8, AuthenticatorState)> {
    if bytes.len() < 37 || bytes[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err(invalid());
    }
    let flags = bytes[32];
    if flags & PRESENT == 0
        || flags & VERIFIED == 0
        || flags & BACKED_UP != 0 && flags & BACKUP_ELIGIBLE == 0
    {
        return Err(invalid());
    }
    Ok((
        flags,
        AuthenticatorState {
            counter: u32::from_be_bytes(bytes[33..37].try_into().map_err(|_| invalid())?),
            backup_eligible: flags & BACKUP_ELIGIBLE != 0,
            backed_up: flags & BACKED_UP != 0,
        },
    ))
}

fn cbor(bytes: &[u8]) -> Result<(Cbor, usize)> {
    let mut cursor = Cursor::new(bytes);
    let value =
        ciborium::de::from_reader_with_recursion_limit(&mut cursor, 16).map_err(|_| invalid())?;
    Ok((value, cursor.position() as usize))
}
fn map(value: &Cbor) -> Result<&[(Cbor, Cbor)]> {
    let Cbor::Map(entries) = value else {
        return Err(invalid());
    };
    if entries.len() > 64 {
        return Err(invalid());
    }
    for (index, (key, _)) in entries.iter().enumerate() {
        if entries[..index].iter().any(|(previous, _)| previous == key) {
            return Err(invalid());
        }
    }
    Ok(entries)
}
fn field<'a>(map: &'a [(Cbor, Cbor)], key: &Cbor) -> Result<&'a Cbor> {
    map.iter()
        .find_map(|(candidate, value)| if candidate == key { Some(value) } else { None })
        .ok_or_else(invalid)
}
fn extensions(bytes: &[u8], flags: u8) -> Result<()> {
    if flags & EXTENSIONS == 0 {
        if !bytes.is_empty() {
            return Err(invalid());
        }
    } else {
        let (value, consumed) = cbor(bytes)?;
        map(&value)?;
        if consumed != bytes.len() {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
