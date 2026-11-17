use crate::Result;
use crate::crypto::{frame, identifier, revision, sized};
use crate::pagination::validate_token;
use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript")]
use ts_rs::TS;

pub fn account_lookup_frame(tenant: &str, generation: &str, nonce: &str) -> Result<Vec<u8>> {
    identifier(tenant)?;
    revision(generation)?;
    sized::<32>(nonce)?;
    Ok(frame(
        "sortsys/recovery-account/v1",
        &[tenant, generation, nonce],
    ))
}

pub fn member_lookup_frame(
    tenant: &str,
    generation: &str,
    username: &str,
    nonce: &str,
) -> Result<Vec<u8>> {
    identifier(tenant)?;
    revision(generation)?;
    identifier(username)?;
    sized::<32>(nonce)?;
    Ok(frame(
        "sortsys/recovery-member/v1",
        &[tenant, generation, username, nonce],
    ))
}

pub const MAX_RECOVERED_MEMBERS: usize = 8;

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistingRecoveryAccount {
    pub subject: String,
    pub username: String,
    pub version: String,
}

pub fn member_registration_frame(
    tenant: &str,
    challenge: &str,
    account: &ExistingRecoveryAccount,
    request: &str,
) -> Result<Vec<u8>> {
    for value in [tenant, challenge, &account.subject, &account.username] {
        identifier(value)?;
    }
    sized::<32>(&account.version)?;
    Ok(frame(
        "sortsys/recovery-member-registration/v1",
        &[
            tenant,
            challenge,
            &account.username,
            &account.subject,
            request,
            &account.version,
        ],
    ))
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveredMember {
    pub account: ExistingRecoveryAccount,
    pub registration_record: String,
    pub vault: crate::crypto::AccountVault,
    pub certificate: crate::protocol::IdentityCertificate,
}

impl RecoveredMember {
    pub fn frame_hash(&self) -> Result<String> {
        use crate::crypto::{decode, encode, frame, invalid, packet_hash};
        use sha2::{Digest, Sha256};
        identifier(&self.account.subject)?;
        identifier(&self.account.username)?;
        sized::<32>(&self.account.version)?;
        self.vault.validate()?;
        if self.certificate.previous_signature.is_some()
            || self.certificate.user != self.account.subject
            || self.vault.subject != self.account.subject
            || self.vault.tenant != self.certificate.tenant
            || self.vault.signing_key != self.certificate.signing_key
            || self.vault.encryption_key != self.certificate.encryption_key
        {
            return Err(invalid());
        }
        let registration = decode(&self.registration_record, 4096)?;
        if registration.is_empty() {
            return Err(invalid());
        }
        Ok(encode(&Sha256::digest(frame(
            "sortsys/recovered-member/v1",
            &[
                &self.account.subject,
                &self.account.username,
                &self.account.version,
                &encode(&Sha256::digest(registration)),
                &encode(&Sha256::digest(self.vault.frame())),
                &packet_hash(&self.certificate.frame()?, &self.certificate.signature)?,
            ],
        ))))
    }
}

pub fn recovered_members_frame(members: &[RecoveredMember]) -> Result<String> {
    use crate::crypto::{encode, frame, invalid};
    use std::collections::HashSet;
    if members.is_empty() || members.len() > MAX_RECOVERED_MEMBERS {
        return Err(invalid());
    }
    let mut subjects = HashSet::new();
    let mut usernames = HashSet::new();
    let mut hashes = Vec::with_capacity(members.len());
    for member in members {
        if !subjects.insert(&member.account.subject) || !usernames.insert(&member.account.username)
        {
            return Err(invalid());
        }
        hashes.push(member.frame_hash()?);
    }
    Ok(encode(&frame(
        "sortsys/recovered-members/v1",
        &hashes.iter().map(String::as_str).collect::<Vec<_>>(),
    )))
}

#[cfg(test)]
mod member_recovery_tests {
    use super::*;

    #[test]
    fn browser_member_frames_are_identical_and_reject_duplicate_principals() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../test/fixtures/recovery-member.json")).unwrap();
        let members: Vec<RecoveredMember> =
            serde_json::from_value(fixture["plan"]["members"].clone()).unwrap();
        let probe = &fixture["registrationProbe"];
        let registration = member_registration_frame(
            probe["tenant"].as_str().unwrap(),
            probe["challengeId"].as_str().unwrap(),
            &members[0].account,
            probe["registrationRequest"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            crate::crypto::encode(&registration),
            fixture["registrationFrame"].as_str().unwrap()
        );
        crate::crypto::verify(
            &crate::crypto::sized::<32>(
                fixture["plan"]["sourceAuthority"]["recoverySigningKey"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
            probe["proof"].as_str().unwrap(),
            &registration,
        )
        .unwrap();
        assert_eq!(
            recovered_members_frame(&members).unwrap(),
            fixture["membersFrame"].as_str().unwrap()
        );
        let mut duplicate = members.clone();
        duplicate.push(members[0].clone());
        assert!(recovered_members_frame(&duplicate).is_err());
        assert!(recovered_members_frame(&[]).is_err());
        let mut changed = members[0].clone();
        changed.account.subject = "account:substituted".into();
        assert!(changed.frame_hash().is_err());
        let mut changed = members[0].clone();
        changed.vault.encryption_key = crate::crypto::encode(&[0; 32]);
        assert!(changed.frame_hash().is_err());
    }
}

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
