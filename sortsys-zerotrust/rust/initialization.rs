//! Proof of possession for the first account and its initial authority state.
use crate::{
    Result,
    crypto::{frame, identifier, sized},
};
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerRegistration {
    pub tenant: String,
    pub subject: String,
    pub username: String,
    pub exchange_hash: String,
    pub registration_hash: String,
    pub vault_hash: String,
    pub setup_hash: String,
    pub locale: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializationSourceProof {
    pub tenant: String,
    pub context: String,
    pub generation: String,
    pub author: String,
    pub manifest: String,
    pub object_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub source_signature: Option<String>,
    pub signature: String,
}
impl InitializationSourceProof {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [&self.tenant, &self.context, &self.author, &self.manifest] {
            identifier(value)?;
        }
        crate::crypto::revision(&self.generation)?;
        sized::<64>(&self.object_signature)?;
        let mut fields = vec![
            self.tenant.as_str(),
            self.context.as_str(),
            self.generation.as_str(),
            self.author.as_str(),
            self.manifest.as_str(),
            self.object_signature.as_str(),
        ];
        if let Some(source) = &self.source_signature {
            sized::<64>(source)?;
            fields.push(source);
            return Ok(frame("sortsys/initialization-source-complete/v1", &fields));
        }
        Ok(frame("sortsys/initialization-source/v1", &fields))
    }

    pub fn verify(&self, authority: &[u8]) -> Result<()> {
        crate::crypto::verify(authority, &self.signature, &self.frame()?)
    }
}

impl OwnerRegistration {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [&self.tenant, &self.subject, &self.username, &self.locale] {
            identifier(value)?;
        }
        for value in [
            &self.exchange_hash,
            &self.registration_hash,
            &self.vault_hash,
            &self.setup_hash,
        ] {
            sized::<32>(value)?;
        }
        Ok(frame(
            "sortsys/initial-owner-registration/v1",
            &[
                &self.tenant,
                &self.subject,
                &self.username,
                &self.exchange_hash,
                &self.registration_hash,
                &self.vault_hash,
                &self.setup_hash,
                &self.locale,
            ],
        ))
    }
}
