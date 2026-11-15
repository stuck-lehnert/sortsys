use crate::Result;
use crate::crypto::{decode, frame, identifier, invalid, revision, sized, verify};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityCertificate {
    pub tenant: String,
    pub generation: String,
    pub recovery_encryption_key: String,
    pub recovery_signing_key: String,
    pub authority_signing_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub context: Option<String>,
    pub signature: String,
}
impl AuthorityCertificate {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        revision(&self.generation)?;
        sized::<32>(&self.recovery_encryption_key)?;
        sized::<32>(&self.recovery_signing_key)?;
        sized::<32>(&self.authority_signing_key)?;
        let mut fields: Vec<&str> = vec![
            &self.tenant,
            &self.generation,
            &self.recovery_encryption_key,
            &self.recovery_signing_key,
            &self.authority_signing_key,
        ];
        if let Some(context) = &self.context {
            identifier(context)?;
            fields.push(context);
            return Ok(frame("sortsys/authority/v2", &fields));
        }
        Ok(frame("sortsys/authority/v1", &fields))
    }
    pub fn verify(&self) -> Result<()> {
        verify(
            &sized::<32>(&self.recovery_signing_key)?,
            &self.signature,
            &self.frame()?,
        )
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityCertificate {
    pub tenant: String,
    pub generation: String,
    pub user: String,
    pub encryption_key: String,
    pub signing_key: String,
    pub signature: String,
}
impl IdentityCertificate {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.user)?;
        revision(&self.generation)?;
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        Ok(frame(
            "sortsys/identity-certificate/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.user,
                &self.encryption_key,
                &self.signing_key,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> Result<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct SealedBox {
    pub tenant: String,
    pub purpose: String,
    pub object: String,
    pub generation: String,
    pub recipient: String,
    pub author: String,
    pub format: String,
    pub enc: String,
    pub ciphertext: String,
    pub signature: String,
}
impl SealedBox {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.object)?;
        identifier(&self.recipient)?;
        identifier(&self.author)?;
        revision(&self.generation)?;
        if self.format != "sortsys-hpke-v1"
            || ![
                "area-key",
                "authority-key",
                "recovery-catalog",
                "validation-request",
                "validation-result",
                "search-request",
                "search-result",
                "live-llm-context",
            ]
            .contains(&self.purpose.as_str())
        {
            return Err(invalid());
        }
        sized::<32>(&self.enc)?;
        if decode(&self.ciphertext, 32 * 1024 * 1024 + 16)?.len() < 16 {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/hpke/v1",
            &[
                &self.tenant,
                &self.purpose,
                &self.object,
                &self.generation,
                &self.recipient,
                &self.author,
                &self.format,
                &self.enc,
                &self.ciphertext,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> Result<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedObject<F = String> {
    pub tenant: String,
    pub scope: String,
    pub facet: F,
    pub object: String,
    pub revision: String,
    pub generation: String,
    pub policy_version: String,
    pub author: String,
    pub format: String,
    pub nonce: String,
    pub ciphertext: String,
    pub wrapped_key: String,
    pub signature: String,
}
impl<F: AsRef<str>> EncryptedObject<F> {
    pub fn is_tombstone(&self) -> bool {
        self.format == "sortsys-object-tombstone-v1"
    }
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(self.facet.as_ref())?;
        for value in [&self.tenant, &self.scope, &self.object, &self.author] {
            identifier(value)?;
        }
        for value in [&self.revision, &self.generation, &self.policy_version] {
            revision(value)?;
        }
        if self.format != "sortsys-object-v1" && !self.is_tombstone() {
            return Err(invalid());
        }
        sized::<12>(&self.nonce)?;
        sized::<40>(&self.wrapped_key)?;
        let length = decode(&self.ciphertext, 16 * 1024 * 1024 + 16)?.len();
        if length < 16 || self.is_tombstone() && (length != 16 || self.revision == "1") {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/object/v1",
            &[
                &self.tenant,
                &self.scope,
                self.facet.as_ref(),
                &self.object,
                &self.revision,
                &self.generation,
                &self.policy_version,
                &self.author,
                &self.format,
                &self.nonce,
                &self.ciphertext,
                &self.wrapped_key,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> Result<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}
