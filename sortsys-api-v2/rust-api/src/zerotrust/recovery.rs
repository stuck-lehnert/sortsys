//! Seed-authorized recovery. This module never accepts a phrase or private key.
//! Root, account, key publication and session revocation commit together in
//! the tenant file. A retry can only confirm that exact signed transition.
use super::{
    crypto::{
        AccountVault, decode, encode, frame, identifier, invalid, random_id, revision, sized,
        verify,
    },
    objects::DomainDefinition,
    opaque::{recovery_registration, validate_registration},
    setup::{SetupInput, packet_hash},
    wire::{AuthorityCertificate, Facet, SealedBox},
};
use crate::{
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    error::{internal, not_found},
    ids::Id,
    rpc::ProcedureRegistryBuilder,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock},
};
use ts_rs::TS;

mod catalog;
mod pages;
mod persistence;
pub(crate) use persistence::register as register_metadata;

fn conflict() -> RpcError {
    RpcError::new(
        ErrorCode::Conflict,
        "Recovery state changed; refresh before continuing",
    )
    .with_http_code(409)
}

static RECOVERY_CHECKS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));
async fn validate_plan(input: &RecoveryPlan) -> RpcResult<()> {
    let permit = Arc::clone(&RECOVERY_CHECKS)
        .try_acquire_owned()
        .map_err(|_| {
            RpcError::new(ErrorCode::TooManyRequests, "Recovery checks are busy")
                .with_http_code(429)
        })?;
    let input = input.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        input.validate()
    })
    .await
    .map_err(internal)?
}

use sortsys_zerotrust::recovery::RecoveryTransition as Transition;

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryPlan {
    challenge_id: String,
    source_authority: AuthorityCertificate,
    transition: Transition,
    next_setup: SetupInput,
    username: String,
    registration_record: String,
    vault: AccountVault,
    old_key_envelopes: Vec<SealedBox>,
    domains: Vec<DomainDefinition>,
    proof: String,
    next_proof: String,
}
impl RecoveryPlan {
    fn bundle_hash(&self) -> RpcResult<String> {
        let old_keys = self
            .old_key_envelopes
            .iter()
            .map(|e| packet_hash(e.frame()?, &e.signature))
            .collect::<RpcResult<Vec<_>>>()?;
        let domains = self
            .domains
            .iter()
            .map(|d| packet_hash(d.frame()?, &d.proof))
            .collect::<RpcResult<Vec<_>>>()?;
        Ok(encode(&Sha256::digest(frame(
            "sortsys/recovery-bundle/v1",
            &[
                &self.username,
                &encode(&Sha256::digest(decode(&self.registration_record, 4096)?)),
                &packet_hash(self.next_setup.frame()?, &self.next_setup.proof)?,
                &encode(&Sha256::digest(self.vault.frame())),
                &encode(&frame(
                    "sortsys/archivekeys/v1",
                    &old_keys.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
                &encode(&frame(
                    "sortsys/new-domains/v1",
                    &domains.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
            ],
        ))))
    }
    fn owner_id(&self) -> RpcResult<Id> {
        let value = self
            .transition
            .next_administrator
            .strip_prefix("user:")
            .ok_or_else(invalid)?;
        let id = Id::decode(value).map_err(|_| invalid())?;
        if id.0 <= 0 || id.encode() != value {
            return Err(invalid());
        }
        Ok(id)
    }
    fn validate(&self) -> RpcResult<()> {
        let t = &self.transition;
        identifier(&self.challenge_id)?;
        let generation = revision(&t.generation)?
            .checked_add(1)
            .ok_or_else(invalid)?;
        let policy = revision(&self.next_setup.policy.version)?;
        let owner = self.owner_id()?;
        if self.username != format!("recovery-{}", owner.encode())
            || self.domains.len() > 2000
            || self.old_key_envelopes.len() > 10000
        {
            return Err(invalid());
        }
        self.source_authority.verify()?;
        // Reject unauthenticated submissions before hashing large bundles or
        // checking thousands of envelopes. The source root is pinned by begin.
        verify(
            &sized::<32>(&self.source_authority.recovery_signing_key)?,
            &self.proof,
            &t.frame()?,
        )?;
        let next = &self.next_setup.authority;
        if self.source_authority.tenant != t.tenant
            || self.source_authority.generation != t.generation
            || next.tenant != t.tenant
            || next.generation != generation.to_string()
            || next.recovery_encryption_key != t.next_recovery_encryption_key
            || next.recovery_signing_key != t.next_recovery_signing_key
            || next.authority_signing_key != t.next_authority_signing_key
            || next.context != self.source_authority.context
            || next.recovery_signing_key == self.source_authority.recovery_signing_key
            || next.recovery_encryption_key == self.source_authority.recovery_encryption_key
            || t.previous_authority_certificate_hash
                != packet_hash(
                    self.source_authority.frame()?,
                    &self.source_authority.signature,
                )?
            || t.catalog_hash
                != packet_hash(
                    self.next_setup.catalog.frame()?,
                    &self.next_setup.catalog.signature,
                )?
            || t.next_administrator_bundle_hash != self.bundle_hash()?
        {
            return Err(invalid());
        }
        verify(
            &sized::<32>(&self.source_authority.recovery_signing_key)?,
            &self.proof,
            &t.frame()?,
        )?;
        verify(
            &sized::<32>(&next.recovery_signing_key)?,
            &self.next_proof,
            &t.frame()?,
        )?;
        self.vault.validate()?;
        validate_registration(&self.registration_record)?;
        if self.vault.tenant != t.tenant || self.vault.username != self.username {
            return Err(invalid());
        }
        let scopes = self
            .domains
            .iter()
            .map(|d| (d.scope.clone(), d.facet))
            .collect::<Vec<_>>();
        self.next_setup.validate_for(
            &t.tenant,
            &t.next_administrator,
            &sized::<32>(&self.vault.encryption_key)?,
            &sized::<32>(&self.vault.signing_key)?,
            generation,
            policy,
            &scopes,
        )?;
        let authority = sized::<32>(&next.authority_signing_key)?;
        let author = format!("authority:{generation}");
        let recipient = format!("recovery:{generation}");
        let mut ids = HashSet::new();
        for domain in &self.domains {
            if !ids.insert(&domain.id)
                || domain.tenant != t.tenant
                || domain.policy_version != self.next_setup.policy.version
                || domain.envelopes.len() != 1
                || domain.envelopes[0].recipient != t.next_administrator
                || domain.recovery_envelope.recipient != recipient
            {
                return Err(invalid());
            }
            verify(&authority, &domain.proof, &domain.frame()?)?;
            for box_ in domain
                .envelopes
                .iter()
                .chain(std::iter::once(&domain.recovery_envelope))
            {
                if box_.tenant != t.tenant
                    || box_.purpose != "area-key"
                    || box_.object != domain.id
                    || box_.generation != domain.generation
                    || box_.author != author
                {
                    return Err(invalid());
                }
                box_.verify(&authority)?;
            }
        }
        let mut versions = HashSet::new();
        for box_ in &self.old_key_envelopes {
            if box_.tenant != t.tenant
                || box_.purpose != "area-key"
                || box_.author != author
                || box_.recipient != t.next_administrator
                || !ids.contains(&box_.object)
                || !versions.insert((&box_.object, &box_.generation))
            {
                return Err(invalid());
            }
            box_.verify(&authority)?;
        }
        Ok(())
    }
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct TenantInput {
    tenant: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct InspectInput {
    tenant: String,
    generation: String,
    nonce: String,
    proof: String,
}
#[derive(Serialize, TS)]
struct RecoveryHead {
    phase: String,
    generation: String,
    authority: AuthorityCertificate,
    operation: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationInput {
    tenant: String,
    challenge_id: String,
    username: String,
    registration_request: String,
    proof: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RegistrationOutput {
    registration_response: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ResumeInput {
    tenant: String,
    operation: String,
}
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DomainInfo {
    id: String,
    scope: String,
    facet: Facet,
    generation: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RecoverySourceHead {
    challenge_id: String,
    challenge: String,
    authority: AuthorityCertificate,
    catalog: SealedBox,
    catalog_version: String,
    policy_version: String,
    snapshot: String,
}
struct InventorySnapshot {
    generation: i64,
    catalog_version: i64,
    policy_version: i64,
}

impl InventorySnapshot {
    fn ensure_current(&self, expected_generation: i64) -> RpcResult<()> {
        if self.generation != expected_generation
            || self.generation <= 0
            || self.catalog_version <= 0
            || self.policy_version <= 0
        {
            return Err(conflict());
        }
        Ok(())
    }

    fn id(&self) -> String {
        format!(
            "{}.{}.{}",
            self.generation, self.catalog_version, self.policy_version
        )
    }
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    catalog::register_contract(pages::register_contract(builder))
        .query_stub::<TenantInput, RecoveryHead>("zerotrust.recovery.head")
        .mutation_stub::<InspectInput, RecoverySourceHead>("zerotrust.recovery.inspect")
        .mutation_stub::<RegistrationInput, RegistrationOutput>("zerotrust.recovery.registration")
        .mutation_stub::<RecoveryPlan, Success>("zerotrust.recovery.begin")
        .mutation_stub::<ResumeInput, Success>("zerotrust.recovery.resume")
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_inventory_cannot_outlive_the_generation_its_seed_proof_authorized() {
        let mut snapshot = InventorySnapshot {
            generation: 1,
            catalog_version: 2,
            policy_version: 3,
        };
        assert!(snapshot.ensure_current(1).is_ok());
        assert_eq!(snapshot.id(), "1.2.3");
        snapshot.generation = 2;
        assert!(snapshot.ensure_current(1).is_err());
        snapshot.policy_version = 0;
        assert!(snapshot.ensure_current(2).is_err());
    }

    #[test]
    fn browser_recovery_plan_requires_both_roots_and_binds_every_replacement() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-recovery.json"))
                .unwrap();
        let input: RecoveryPlan = serde_json::from_value(fixture["plan"].clone()).unwrap();
        input.validate().unwrap();
        let mut changed = input.clone();
        changed.domains.clear();
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.old_key_envelopes.clear();
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.username.push('a');
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.next_proof = input.proof.clone();
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.transition.catalog_version = "999".into();
        assert!(changed.validate().is_err());
        let mut changed = fixture["plan"].clone();
        changed["seedPhrase"] = serde_json::json!("unaccepted secret");
        assert!(serde_json::from_value::<RecoveryPlan>(changed).is_err());
    }
}
