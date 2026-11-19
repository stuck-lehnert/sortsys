//! Public access metadata, cryptographically bound to one ciphertext revision.
use crate::{
    Result,
    crypto::{frame, identifier, invalid, packet_hash, revision, sized, verify},
    protocol::IdentityCertificate,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceAccessState {
    pub tenant: String,
    pub resource: String,
    pub object: String,
    pub revision: String,
    pub generation: String,
    pub binding: String,
    pub active: bool,
    pub packet_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub command_binding: Option<String>,
    pub author: IdentityCertificate,
    pub signature: String,
}

pub struct ResourceAccessContext<'a> {
    pub tenant: &'a str,
    pub resource: &'a str,
    pub object: &'a str,
    pub generation: &'a str,
    pub binding: &'a str,
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceCommand {
    pub tenant: String,
    pub purpose: String,
    pub revision: String,
    pub issued_at: String,
    pub verification_key: String,
    pub signature: String,
}

pub struct ResourceCommandContext<'a> {
    pub tenant: &'a str,
    pub purpose: &'a str,
    pub binding: &'a str,
}

pub fn resource_command_binding(verification_key: &str) -> Result<String> {
    let key = sized::<32>(verification_key)?;
    Ok(crate::crypto::encode(&Sha256::digest(key)))
}

impl ResourceCommand {
    pub fn timestamp_millis(&self) -> Result<i64> {
        let value = revision(&self.issued_at)?;
        if value > 8_640_000_000_000_000 {
            return Err(invalid());
        }
        Ok(value)
    }

    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.purpose)?;
        revision(&self.revision)?;
        self.timestamp_millis()?;
        sized::<32>(&self.verification_key)?;
        Ok(frame(
            "sortsys/resource-command/v1",
            &[
                &self.tenant,
                &self.purpose,
                &self.revision,
                &self.issued_at,
                &self.verification_key,
            ],
        ))
    }

    /// Timestamp freshness and consumption are part of the caller's
    /// transaction. This proof can also be verified in a historical view.
    pub fn verify(&self, expected: &ResourceCommandContext<'_>) -> Result<()> {
        if self.tenant != expected.tenant
            || self.purpose != expected.purpose
            || resource_command_binding(&self.verification_key)? != expected.binding
        {
            return Err(invalid());
        }
        verify(
            &sized::<32>(&self.verification_key)?,
            &self.signature,
            &self.frame()?,
        )
    }
}

impl ResourceAccessState {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.resource)?;
        identifier(&self.object)?;
        revision(&self.revision)?;
        revision(&self.generation)?;
        sized::<32>(&self.binding)?;
        sized::<64>(&self.packet_signature)?;
        if self.author.tenant != self.tenant || self.author.generation != self.generation {
            return Err(invalid());
        }
        let author = packet_hash(&self.author.frame()?, &self.author.signature)?;
        let mut fields = vec![
            self.tenant.as_str(),
            &self.resource,
            &self.object,
            &self.revision,
            &self.generation,
            &self.binding,
            if self.active { "true" } else { "false" },
            &self.packet_signature,
            &author,
        ];
        if let Some(binding) = &self.command_binding {
            sized::<32>(binding)?;
            fields.push(binding);
            return Ok(frame("sortsys/resource-access/v2", &fields));
        }
        Ok(frame("sortsys/resource-access/v1", &fields))
    }

    pub fn verify(&self, expected: &ResourceAccessContext<'_>, authority: &[u8]) -> Result<()> {
        if self.tenant != expected.tenant
            || self.resource != expected.resource
            || self.object != expected.object
            || self.generation != expected.generation
            || self.binding != expected.binding
        {
            return Err(invalid());
        }
        self.author.verify(authority)?;
        verify(
            &sized::<32>(&self.author.signing_key)?,
            &self.signature,
            &self.frame()?,
        )
    }
}
