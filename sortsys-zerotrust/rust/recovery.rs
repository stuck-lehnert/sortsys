use crate::Result;
use crate::crypto::{frame, identifier, revision, sized};
use crate::pagination::validate_token;
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPageAccess {
    pub tenant: String,
    pub generation: String,
    pub challenge_id: String,
    pub challenge: String,
    pub snapshot: String,
    pub after: Option<String>,
}

impl RecoveryPageAccess {
    pub fn frame(&self) -> Result<Vec<u8>> {
        identifier(&self.tenant)?;
        revision(&self.generation)?;
        identifier(&self.challenge_id)?;
        sized::<32>(&self.challenge)?;
        validate_token(&self.snapshot)?;
        if let Some(after) = &self.after {
            validate_token(after)?;
        }
        Ok(frame(
            "sortsys/recovery-page/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.challenge_id,
                &self.challenge,
                &self.snapshot,
                self.after.as_deref().unwrap_or(""),
            ],
        ))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryTransition {
    pub tenant: String,
    pub generation: String,
    pub operation: String,
    pub challenge: String,
    pub catalog_version: String,
    pub catalog_hash: String,
    pub previous_authority_certificate_hash: String,
    pub next_recovery_encryption_key: String,
    pub next_recovery_signing_key: String,
    pub next_authority_signing_key: String,
    pub next_administrator: String,
    pub next_administrator_bundle_hash: String,
}
impl RecoveryTransition {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [&self.tenant, &self.operation, &self.next_administrator] {
            identifier(value)?;
        }
        revision(&self.generation)?;
        revision(&self.catalog_version)?;
        for value in [
            &self.challenge,
            &self.catalog_hash,
            &self.previous_authority_certificate_hash,
            &self.next_recovery_encryption_key,
            &self.next_recovery_signing_key,
            &self.next_authority_signing_key,
            &self.next_administrator_bundle_hash,
        ] {
            sized::<32>(value)?;
        }
        Ok(frame(
            "sortsys/recovery-transition/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.operation,
                &self.challenge,
                &self.catalog_version,
                &self.catalog_hash,
                &self.previous_authority_certificate_hash,
                &self.next_recovery_encryption_key,
                &self.next_recovery_signing_key,
                &self.next_authority_signing_key,
                &self.next_administrator,
                &self.next_administrator_bundle_hash,
            ],
        ))
    }
}

/// Seed-authorized access to an immutable encrypted catalog block. Future
/// writes are limited to the immediate next authority generation.
#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryCatalogAccess {
    pub tenant: String,
    pub generation: String,
    pub challenge_id: String,
    pub challenge: String,
    pub target_generation: String,
    pub object: String,
    pub hash: String,
    pub action: CatalogAction,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum CatalogAction {
    Read,
    Write,
}
impl RecoveryCatalogAccess {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [&self.tenant, &self.challenge_id, &self.object] {
            identifier(value)?;
        }
        let source = revision(&self.generation)?;
        let target = revision(&self.target_generation)?;
        sized::<32>(&self.challenge)?;
        sized::<32>(&self.hash)?;
        if target < source
            || target - source > 1
            || self.action == CatalogAction::Write && target - source != 1
            || !self.object.starts_with("catalog-page:")
        {
            return Err(crate::crypto::invalid());
        }
        let action = match self.action {
            CatalogAction::Read => "read",
            CatalogAction::Write => "write",
        };
        Ok(frame(
            "zerotrust/recovery-catalog-access/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.challenge_id,
                &self.challenge,
                &self.target_generation,
                &self.object,
                &self.hash,
                action,
            ],
        ))
    }
}
