//! Public access metadata, cryptographically bound to one ciphertext revision.
use crate::{
    Result,
    crypto::{frame, identifier, invalid, packet_hash, revision, sized, verify},
    protocol::IdentityCertificate,
};
use serde::{Deserialize, Serialize};
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
