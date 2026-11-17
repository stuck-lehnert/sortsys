use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "typescript")]
use ts_rs::TS;

use crate::Result;

pub fn decode(value: &str, maximum: usize) -> Result<Vec<u8>> {
    if value.len() > maximum.saturating_mul(4).div_ceil(3) {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?;
    if bytes.len() > maximum || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(invalid());
    }
    Ok(bytes)
}

pub fn sized<const N: usize>(value: &str) -> Result<[u8; N]> {
    decode(value, N)?.try_into().map_err(|_| invalid())
}

pub fn encode(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(value)
}

/// Commit to the exact canonical message and its signature, never JSON layout.
pub fn packet_hash(message: &[u8], signature: &str) -> Result<String> {
    Ok(encode(&Sha256::digest(signed_packet_frame(
        message, signature,
    )?)))
}

pub fn signed_packet_frame(message: &[u8], signature: &str) -> Result<Vec<u8>> {
    sized::<64>(signature)?;
    Ok(frame(
        "sortsys/signed-packet/v1",
        &[&encode(message), signature],
    ))
}

pub fn frame(domain: &str, fields: &[&str]) -> Vec<u8> {
    let mut result = Vec::new();
    for part in std::iter::once(domain).chain(fields.iter().copied()) {
        result.extend_from_slice(&(part.len() as u32).to_be_bytes());
        result.extend_from_slice(part.as_bytes());
    }
    result
}

pub fn verify(key: &[u8], signature: &str, message: &[u8]) -> Result<()> {
    let key: &[u8; 32] = key.try_into().map_err(|_| invalid())?;
    VerifyingKey::from_bytes(key)
        .map_err(|_| invalid())?
        .verify_strict(message, &Signature::from_bytes(&sized(signature)?))
        .map_err(|_| invalid())
}

pub fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 192
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:.@/-".contains(&b))
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn revision(value: &str) -> Result<i64> {
    let n: i64 = value.parse().map_err(|_| invalid())?;
    if n <= 0 || n.to_string() != value {
        return Err(invalid());
    }
    Ok(n)
}

pub fn random_id() -> Result<String> {
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce).map_err(|_| invalid())?;
    Ok(format!("zt_{}", encode(&nonce)))
}

pub fn invalid() -> crate::Error {
    crate::Error::InvalidProtectedData
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountVault {
    pub format: String,
    pub tenant: String,
    pub subject: String,
    pub encryption_key: String,
    pub signing_key: String,
    pub nonce: String,
    pub ciphertext: String,
    pub wrapped_key: String,
}

impl AccountVault {
    pub fn frame(&self) -> Vec<u8> {
        frame(
            "sortsys/account-vault-envelope/v2",
            &[
                &self.format,
                &self.tenant,
                &self.subject,
                &self.encryption_key,
                &self.signing_key,
                &self.nonce,
                &self.ciphertext,
                &self.wrapped_key,
            ],
        )
    }

    pub fn validate(&self) -> Result<()> {
        if self.format != "sortsys-account-v2" {
            return Err(invalid());
        }
        identifier(&self.tenant)?;
        identifier(&self.subject)?;
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        sized::<12>(&self.nonce)?;
        sized::<40>(&self.wrapped_key)?;
        if decode(&self.ciphertext, 1024 * 1024)?.len() < 16 {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn signed_packet_commitments_match_an_independent_sha256_vector() {
        let signature = encode(&[0; 64]);
        assert_eq!(
            packet_hash(b"message", &signature).unwrap(),
            "qGb2suTULWOqclzjh61DsBkoA00FlZoupnqVak4eeGQ"
        );
        assert_ne!(
            packet_hash(b"message", &signature).unwrap(),
            packet_hash(b"changed", &signature).unwrap()
        );
        assert!(packet_hash(b"message", "").is_err());
    }

    #[test]
    fn frames_match_browser_protocol_and_reject_ambiguous_inputs() {
        assert_eq!(
            frame("a", &["bc", "d"]),
            [0, 0, 0, 1, b'a', 0, 0, 0, 2, b'b', b'c', 0, 0, 0, 1, b'd']
        );
        assert_ne!(frame("a", &["bc", "d"]), frame("a", &["b", "cd"]));
        assert!(decode("Zh", 1).is_err());
        assert!(decode("Zg==", 1).is_err());
        assert_eq!(decode("Zg", 1).unwrap(), b"f");
        assert!(revision("01").is_err());
        assert!(revision("0").is_err());
        assert!(revision("9223372036854775808").is_err());
    }

    #[test]
    fn proofs_bind_every_field_and_fail_with_another_key() {
        let first = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[8; 32]);
        let payload = frame("sortsys/test/v1", &["tenant", "1"]);
        let signature = encode(&first.sign(&payload).to_bytes());
        assert!(verify(first.verifying_key().as_bytes(), &signature, &payload).is_ok());
        assert!(verify(other.verifying_key().as_bytes(), &signature, &payload).is_err());
        assert!(
            verify(
                first.verifying_key().as_bytes(),
                &signature,
                &frame("sortsys/test/v1", &["other", "1"])
            )
            .is_err()
        );
    }
}
