//! WebAuthn parsing and verification for the passkey procedures.
//!
//! The browser-facing representation stays compatible with the former
//! TypeScript implementation: base64url values, ES256/P-256 credentials,
//! resident keys, and mandatory user verification.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ciborium::value::Value as CborValue;
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;
use url::Url;

use crate::{
    auth::AuthService,
    error::{ErrorCode, RpcError, RpcResult},
};

const CHALLENGE_BYTES: usize = 32;
const CHALLENGE_TTL_SECONDS: usize = 5 * 60;
const USER_PRESENT_FLAG: u8 = 0x01;
const USER_VERIFIED_FLAG: u8 = 0x04;
const ATTESTED_CREDENTIAL_FLAG: u8 = 0x40;

pub const TIMEOUT_MS: u32 = 60_000;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationCredential {
    pub id: String,
    pub raw_id: String,

    #[ts(type = "\"public-key\"")]
    pub r#type: String,

    pub response: RegistrationResponse,

    #[serde(default)]
    #[ts(optional = nullable)]
    pub transports: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub attestation_object: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticationCredential {
    pub id: String,
    pub raw_id: String,

    #[ts(type = "\"public-key\"")]
    pub r#type: String,

    pub response: AuthenticationResponse,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticationResponse {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    pub user_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDescriptor {
    pub id: String,

    #[ts(type = "\"public-key\"")]
    pub r#type: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeClaims {
    pub purpose: String,
    pub tenant: Option<String>,
    pub challenge: String,
    pub origin: String,
    pub rp_id: String,
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub iat: usize,
    pub exp: usize,
}

#[derive(Debug)]
pub struct RegistrationResult {
    pub credential_id: String,
    pub public_key_jwk: Value,
    pub counter: u32,
}

#[derive(Debug)]
pub struct AssertionResult {
    pub credential_id: String,
    pub counter: u32,
}

pub fn create_challenge() -> String {
    let mut bytes = [0_u8; CHALLENGE_BYTES];
    getrandom::fill(&mut bytes).expect("operating system random source must be available");

    base64_url_encode(&bytes)
}

pub fn user_handle(tenant: &str, user_id: &str) -> String {
    base64_url_encode(format!("{tenant}:{user_id}").as_bytes())
}

pub fn parse_user_handle(value: Option<&str>) -> Option<(String, i64)> {
    let decoded = base64_url_decode(value?).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (tenant, user_id) = decoded.split_once(':')?;
    let tenant = tenant.to_lowercase();

    if !valid_tenant_name(&tenant) {
        return None;
    }

    Some((tenant, user_id.parse().ok()?))
}

pub fn rp_id_from_origin(origin: &str) -> RpcResult<String> {
    let url = Url::parse(origin).map_err(|_| bad_request("Invalid Origin header"))?;
    let hostname = url
        .host_str()
        .ok_or_else(|| bad_request("Invalid Origin header"))?
        .to_lowercase();

    let local = matches!(hostname.as_str(), "localhost" | "127.0.0.1");
    if url.scheme() != "https" && !local {
        return Err(bad_request("Passkeys require HTTPS"));
    }

    Ok(hostname)
}

pub struct ChallengeRequest<'a> {
    pub purpose: &'a str,
    pub tenant: Option<String>,
    pub challenge: String,
    pub origin: String,
    pub rp_id: String,
    pub user_id: Option<String>,
    pub username: Option<String>,
}

pub fn create_challenge_token(
    auth: &AuthService,
    request: ChallengeRequest<'_>,
) -> RpcResult<String> {
    let issued_at = unix_time();
    let claims = ChallengeClaims {
        purpose: request.purpose.to_owned(),
        tenant: request.tenant,
        challenge: request.challenge,
        origin: request.origin,
        rp_id: request.rp_id,
        user_id: request.user_id,
        username: request.username,
        iat: issued_at,
        exp: issued_at + CHALLENGE_TTL_SECONDS,
    };

    auth.issue_challenge_token(&claims)
}

pub fn verify_challenge_token(
    auth: &AuthService,
    token: &str,
    expected_purpose: &str,
) -> RpcResult<ChallengeClaims> {
    let claims = auth.verify_challenge_token::<ChallengeClaims>(token)?;

    if claims.purpose != expected_purpose
        || claims.challenge.is_empty()
        || claims.origin.is_empty()
        || claims.rp_id.is_empty()
    {
        return Err(unauthorized());
    }

    Ok(claims)
}

pub fn verify_registration(
    credential: &RegistrationCredential,
    challenge: &str,
    expected_origin: &str,
    expected_rp_id: &str,
) -> RpcResult<RegistrationResult> {
    validate_credential_type(&credential.r#type)?;

    let client_data_bytes = base64_url_decode(&credential.response.client_data_json)?;
    verify_client_data(
        &client_data_bytes,
        "webauthn.create",
        challenge,
        expected_origin,
    )?;

    let attestation_bytes = base64_url_decode(&credential.response.attestation_object)?;
    let attestation: CborValue = ciborium::de::from_reader(attestation_bytes.as_slice())
        .map_err(|_| bad_request("Invalid attestation object"))?;
    let authenticator_data = cbor_text_bytes(&attestation, "authData")?;

    let parsed = parse_attested_authenticator_data(authenticator_data, expected_rp_id)?;
    let credential_id = base64_url_encode(parsed.credential_id);

    if credential_id != credential.raw_id {
        return Err(bad_request(
            "Credential identifier does not match attestation",
        ));
    }

    Ok(RegistrationResult {
        credential_id,
        public_key_jwk: cose_ec2_public_key(parsed.cose_public_key)?,
        counter: parsed.counter,
    })
}

pub fn verify_authentication(
    credential: &AuthenticationCredential,
    public_key_jwk: &Value,
    challenge: &str,
    expected_origin: &str,
    expected_rp_id: &str,
) -> RpcResult<AssertionResult> {
    validate_credential_type(&credential.r#type)?;

    let client_data_bytes = base64_url_decode(&credential.response.client_data_json)?;
    verify_client_data(
        &client_data_bytes,
        "webauthn.get",
        challenge,
        expected_origin,
    )?;

    let authenticator_data = base64_url_decode(&credential.response.authenticator_data)?;
    let parsed = parse_authenticator_data(&authenticator_data, expected_rp_id)?;

    let client_data_hash = Sha256::digest(&client_data_bytes);
    let mut signed_data = Vec::with_capacity(authenticator_data.len() + client_data_hash.len());
    signed_data.extend_from_slice(&authenticator_data);
    signed_data.extend_from_slice(&client_data_hash);

    verify_es256_signature(public_key_jwk, &signed_data, &credential.response.signature)?;

    Ok(AssertionResult {
        credential_id: credential.raw_id.clone(),
        counter: parsed.counter,
    })
}

fn verify_client_data(
    bytes: &[u8],
    expected_type: &str,
    expected_challenge: &str,
    expected_origin: &str,
) -> RpcResult<()> {
    let data: ClientData =
        serde_json::from_slice(bytes).map_err(|_| bad_request("Invalid client data JSON"))?;

    if data.r#type != expected_type {
        return Err(bad_request("Unexpected WebAuthn ceremony type"));
    }
    if data.challenge != expected_challenge || data.origin != expected_origin {
        return Err(unauthorized());
    }
    if data.cross_origin {
        return Err(bad_request(
            "Cross-origin passkey ceremonies are not supported",
        ));
    }

    Ok(())
}

fn parse_authenticator_data(
    bytes: &[u8],
    expected_rp_id: &str,
) -> RpcResult<ParsedAuthenticatorData> {
    if bytes.len() < 37 {
        return Err(bad_request("Authenticator data is too short"));
    }

    let expected_rp_id_hash = Sha256::digest(expected_rp_id.as_bytes());
    if bytes[..32] != expected_rp_id_hash[..] {
        return Err(unauthorized());
    }

    let flags = bytes[32];
    if flags & USER_PRESENT_FLAG == 0 || flags & USER_VERIFIED_FLAG == 0 {
        return Err(unauthorized());
    }

    Ok(ParsedAuthenticatorData {
        flags,
        counter: u32::from_be_bytes(bytes[33..37].try_into().expect("checked length")),
    })
}

fn parse_attested_authenticator_data<'a>(
    bytes: &'a [u8],
    expected_rp_id: &str,
) -> RpcResult<ParsedAttestation<'a>> {
    let parsed = parse_authenticator_data(bytes, expected_rp_id)?;

    if parsed.flags & ATTESTED_CREDENTIAL_FLAG == 0 || bytes.len() < 55 {
        return Err(bad_request("Attested credential data is missing"));
    }

    // Bytes 37..53 are the authenticator AAGUID. The next two bytes carry the
    // credential identifier length, followed by the identifier and COSE key.
    let credential_id_length = u16::from_be_bytes([bytes[53], bytes[54]]) as usize;
    let credential_id_start = 55;
    let credential_id_end = credential_id_start + credential_id_length;

    if credential_id_end > bytes.len() {
        return Err(bad_request(
            "Credential identifier exceeds authenticator data",
        ));
    }

    let cose_public_key: CborValue = ciborium::de::from_reader(&bytes[credential_id_end..])
        .map_err(|_| bad_request("Invalid COSE public key"))?;

    Ok(ParsedAttestation {
        counter: parsed.counter,
        credential_id: &bytes[credential_id_start..credential_id_end],
        cose_public_key,
    })
}

fn cose_ec2_public_key(value: CborValue) -> RpcResult<Value> {
    if cbor_integer(&value, 1) != Some(2)
        || cbor_integer(&value, 3) != Some(-7)
        || cbor_integer(&value, -1) != Some(1)
    {
        return Err(bad_request("Only ES256 P-256 passkeys are supported"));
    }

    let x = cbor_integer_bytes(&value, -2)?;
    let y = cbor_integer_bytes(&value, -3)?;

    if x.len() != 32 || y.len() != 32 {
        return Err(bad_request("Invalid P-256 public key coordinates"));
    }

    Ok(serde_json::json!({
        "kty": "EC",
        "crv": "P-256",
        "x": base64_url_encode(x),
        "y": base64_url_encode(y),
        "ext": true,
    }))
}

fn verify_es256_signature(
    public_key_jwk: &Value,
    signed_data: &[u8],
    encoded_signature: &str,
) -> RpcResult<()> {
    let x = decode_jwk_coordinate(public_key_jwk, "x")?;
    let y = decode_jwk_coordinate(public_key_jwk, "y")?;

    if x.len() != 32 || y.len() != 32 {
        return Err(unauthorized());
    }

    let mut sec1_public_key = Vec::with_capacity(65);
    sec1_public_key.push(0x04);
    sec1_public_key.extend_from_slice(&x);
    sec1_public_key.extend_from_slice(&y);

    let verifying_key =
        VerifyingKey::from_sec1_bytes(&sec1_public_key).map_err(|_| unauthorized())?;
    let signature_bytes = base64_url_decode(encoded_signature)?;
    let signature = Signature::from_der(&signature_bytes).map_err(|_| unauthorized())?;

    verifying_key
        .verify(signed_data, &signature)
        .map_err(|_| unauthorized())
}

fn decode_jwk_coordinate(public_key_jwk: &Value, field: &str) -> RpcResult<Vec<u8>> {
    public_key_jwk
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(unauthorized)
        .and_then(base64_url_decode)
}

fn cbor_text_bytes<'a>(value: &'a CborValue, key: &str) -> RpcResult<&'a [u8]> {
    let map = as_cbor_map(value)?;

    map.iter()
        .find_map(|(candidate, value)| {
            matches!(candidate, CborValue::Text(text) if text == key).then_some(value)
        })
        .and_then(|value| match value {
            CborValue::Bytes(bytes) => Some(bytes.as_slice()),
            _ => None,
        })
        .ok_or_else(|| bad_request(format!("Missing CBOR field {key}")))
}

fn cbor_integer(value: &CborValue, key: i64) -> Option<i64> {
    let map = as_cbor_map(value).ok()?;

    map.iter()
        .find_map(|(candidate, value)| {
            (cbor_value_integer(candidate) == Some(key)).then_some(value)
        })
        .and_then(cbor_value_integer)
}

fn cbor_integer_bytes(value: &CborValue, key: i64) -> RpcResult<&[u8]> {
    let map = as_cbor_map(value)?;

    map.iter()
        .find_map(|(candidate, value)| {
            (cbor_value_integer(candidate) == Some(key)).then_some(value)
        })
        .and_then(|value| match value {
            CborValue::Bytes(bytes) => Some(bytes.as_slice()),
            _ => None,
        })
        .ok_or_else(|| bad_request(format!("Missing COSE key {key}")))
}

fn cbor_value_integer(value: &CborValue) -> Option<i64> {
    match value {
        CborValue::Integer(integer) => i64::try_from(*integer).ok(),
        _ => None,
    }
}

fn as_cbor_map(value: &CborValue) -> RpcResult<&[(CborValue, CborValue)]> {
    match value {
        CborValue::Map(entries) => Ok(entries),
        _ => Err(bad_request("Expected a CBOR map")),
    }
}

fn validate_credential_type(value: &str) -> RpcResult<()> {
    if value == "public-key" {
        Ok(())
    } else {
        Err(bad_request("Unsupported credential type"))
    }
}

fn valid_tenant_name(value: &str) -> bool {
    let mut segments = value.split(['.', '-']);
    segments.all(|segment| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn base64_url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn base64_url_decode(value: &str) -> RpcResult<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| bad_request("Invalid base64url value"))
}

fn unix_time() -> usize {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as usize
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message.into()).with_http_code(400)
}

fn unauthorized() -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, "Passkey verification failed").with_http_code(401)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientData {
    r#type: String,
    challenge: String,
    origin: String,

    #[serde(default)]
    cross_origin: bool,
}

#[derive(Debug)]
struct ParsedAuthenticatorData {
    flags: u8,
    counter: u32,
}

#[derive(Debug)]
struct ParsedAttestation<'a> {
    counter: u32,
    credential_id: &'a [u8],
    cose_public_key: CborValue,
}

#[cfg(test)]
mod tests {
    use super::{parse_user_handle, rp_id_from_origin, user_handle};

    #[test]
    fn derives_relying_party_ids_only_from_secure_or_local_origins() {
        assert_eq!(
            rp_id_from_origin("https://app.example.test:8443").unwrap(),
            "app.example.test"
        );
        assert_eq!(
            rp_id_from_origin("http://127.0.0.1:3000").unwrap(),
            "127.0.0.1"
        );
        assert!(rp_id_from_origin("http://app.example.test").is_err());
    }

    #[test]
    fn round_trips_discoverable_user_handles() {
        let encoded = user_handle("tenant-one", "42");
        assert_eq!(
            parse_user_handle(Some(&encoded)),
            Some(("tenant-one".to_owned(), 42))
        );
        assert_eq!(parse_user_handle(Some("not-base64")), None);
    }
}
