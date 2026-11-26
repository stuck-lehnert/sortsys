use super::{
    crypto::{frame, invalid, sized, verify},
    wire::{
        Action, AuthorityCertificate, Effect, Facet, IdentityCertificate, SealedBox, SignedPolicy,
    },
};
use crate::{
    api::Success,
    auth::AuthService,
    control::{Repository, Transaction, accounts, key},
    error::{RpcResult, forbidden, internal},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

#[cfg(test)]
mod tests {
    use super::super::crypto::encode;
    use super::*;

    fn setup_fixture() -> SetupInput {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-setup.json"))
                .unwrap();
        serde_json::from_value(fixture["setup"].clone()).unwrap()
    }

    #[test]
    fn browser_bootstrap_verifies_without_private_or_recovery_keys_on_the_server() {
        let input = setup_fixture();
        let encryption = sized::<32>(&input.owner.encryption_key).unwrap();
        let signing = sized::<32>(&input.owner.signing_key).unwrap();
        input
            .validate("test", "user:interop", &encryption, &signing)
            .unwrap();
        assert!(
            input
                .validate("other", "user:interop", &encryption, &signing)
                .is_err()
        );
        assert!(
            input
                .validate("test", "user:other", &encryption, &signing)
                .is_err()
        );
        let mut changed = input.clone();
        changed.authority.recovery_signing_key = encode(&[1; 32]);
        assert!(
            changed
                .validate("test", "user:interop", &encryption, &signing)
                .is_err()
        );
        let mut bad = serde_json::to_value(input).unwrap();
        bad["seedPhrase"] = serde_json::json!("must never be an accepted server parameter");
        assert!(serde_json::from_value::<SetupInput>(bad).is_err());
    }

    #[test]
    fn creation_grants_allow_only_the_owner_to_create_in_registered_namespaces() {
        let mut policy = setup_fixture().policy;
        let grant = super::super::wire::Rule {
            subject: "user:interop".into(),
            scope: "create:commercial".into(),
            facet: Facet::MasterData,
            actions: vec![Action::Create],
            effect: Effect::Allow,
            origin: None,
        };
        let valid =
            |policy: &SignedPolicy| validate_owner_grants(policy, "test", "user:interop", &[]);
        policy.rules.push(grant.clone());
        valid(&policy).unwrap();
        policy.rules.push(grant.clone());
        assert!(valid(&policy).is_err());
        policy.rules.truncate(policy.rules.len() - 2);

        for invalid_grant in [
            super::super::wire::Rule {
                subject: "user:other".into(),
                ..grant.clone()
            },
            super::super::wire::Rule {
                scope: "create:unknown".into(),
                ..grant.clone()
            },
            super::super::wire::Rule {
                facet: Facet::Billing,
                ..grant.clone()
            },
            super::super::wire::Rule {
                actions: vec![Action::Create, Action::Grant],
                ..grant
            },
        ] {
            policy.rules.push(invalid_grant);
            assert!(valid(&policy).is_err());
            policy.rules.pop();
        }
        let mut suspended_owner = policy.clone();
        suspended_owner.suspended = Some(vec!["user:interop".into()]);
        assert!(valid(&suspended_owner).is_err());
        policy.rules.remove(0);
        assert!(valid(&policy).is_err());
    }

    #[test]
    fn access_status_requires_a_certificate_matching_the_current_root_and_account_keys() {
        let setup = setup_fixture();
        let make = || AccountCertification {
            identity_certificate: serde_json::to_value(&setup.owner).unwrap(),
            encryption_key: sized::<32>(&setup.owner.encryption_key).unwrap().to_vec(),
            signing_key: sized::<32>(&setup.owner.signing_key).unwrap().to_vec(),
            authority_key: Some(
                sized::<32>(&setup.authority.authority_signing_key)
                    .unwrap()
                    .to_vec(),
            ),
        };
        assert!(make().valid("test", "user:interop", 1));
        assert!(!make().valid("test", "user:other", 1));
        assert!(!make().valid("other", "user:interop", 1));
        assert!(!make().valid("test", "user:interop", 2));
        let mut pending = make();
        pending.identity_certificate = serde_json::json!({"format":"pending"});
        assert!(!pending.valid("test", "user:interop", 1));
        let mut replaced = make();
        replaced.encryption_key.fill(1);
        assert!(!replaced.valid("test", "user:interop", 1));
        let mut replaced = make();
        replaced.authority_key = Some(vec![1; 32]);
        assert!(!replaced.valid("test", "user:interop", 1));
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SetupInput {
    pub authority: AuthorityCertificate,
    pub owner: IdentityCertificate,
    pub authority_envelope: SealedBox,
    pub catalog: SealedBox,
    pub policy: SignedPolicy,
    pub proof: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Status {
    tenant: String,
    phase: String,
    generation: String,
    policy_version: String,
    catalog_version: String,
    account_enrolled: bool,
    account_certified: bool,
    access_ready: bool,
    can_initialize: bool,
    initialization: Option<super::initialization::Completion>,
    profile: Option<SetupInput>,
}

struct AccountCertification {
    identity_certificate: Value,
    encryption_key: Vec<u8>,
    signing_key: Vec<u8>,
    authority_key: Option<Vec<u8>>,
}
impl AccountCertification {
    fn valid(self, tenant: &str, subject: &str, generation: i64) -> bool {
        let Ok(certificate) =
            serde_json::from_value::<IdentityCertificate>(self.identity_certificate)
        else {
            return false;
        };
        certificate.tenant == tenant
            && certificate.user == subject
            && certificate.generation == generation.to_string()
            && sized::<32>(&certificate.encryption_key)
                .is_ok_and(|key| key.as_slice() == self.encryption_key)
            && sized::<32>(&certificate.signing_key)
                .is_ok_and(|key| key.as_slice() == self.signing_key)
            && self
                .authority_key
                .is_some_and(|key| certificate.verify(&key).is_ok())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RootState {
    pub policy_version: String,
    pub catalog_version: String,
    pub profile: SetupInput,
}

pub(super) fn root_key() -> sortsys_zerotrust::metadata::RecordKey {
    key("crypto-root", "current")
}
mod identity_history;
pub(super) use identity_history::{append_identity, identity_head_key, identity_history_key};

pub(crate) fn register_root_queries(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let history_service = Arc::clone(&service);
    let builder = builder.query("zerotrust.trust.history", move |ctx, _: ()| {
        let service = Arc::clone(&history_service);
        async move { history(&service, &ctx).await }
    });
    let status_service = Arc::clone(&service);
    builder
        .query("zerotrust.status", move |ctx, _: ()| {
            let service = Arc::clone(&status_service);
            async move {
                let auth = service.authenticate(&ctx.headers).await?;
                let repository = service.records()?.tenant(&auth.tenant)?;
                let mut transaction = repository.transaction()?;
                let (account, _) = accounts::checked_session(&mut transaction, &auth).await?;
                let credential = account.credential()?;
                let root = metadata_root(&mut transaction, &auth.tenant).await?;
                let generation = super::crypto::revision(&root.profile.authority.generation)?;
                let certified = AccountCertification {
                    identity_certificate: credential.certificate.clone(),
                    encryption_key: sized::<32>(&credential.vault.encryption_key)?.to_vec(),
                    signing_key: sized::<32>(&credential.vault.signing_key)?.to_vec(),
                    authority_key: Some(
                        sized::<32>(&root.profile.authority.authority_signing_key)?.to_vec(),
                    ),
                }
                .valid(
                    &auth.tenant,
                    &format!("user:{}", Id(account.id).encode()),
                    generation,
                );
                let initialization = super::initialization::completed(
                    &mut transaction,
                    &root.profile.authority.generation,
                )
                .await?;
                let can_initialize = auth.is_admin()
                    && root.profile.owner.user == format!("user:{}", Id(account.id).encode());
                let status = Status {
                    tenant: auth.tenant,
                    phase: "active".into(),
                    generation: generation.to_string(),
                    policy_version: root.policy_version,
                    catalog_version: root.catalog_version,
                    account_enrolled: true,
                    account_certified: certified,
                    access_ready: certified && credential.pending_invitation.is_none(),
                    can_initialize,
                    initialization,
                    profile: Some(root.profile),
                };
                transaction.validate().await?;
                Ok(status)
            }
        })
        .mutation("zerotrust.setup", move |ctx, input: SetupInput| {
            let service = Arc::clone(&service);
            async move {
                // Initial ownership is created atomically by auth.owner.finish.
                // This endpoint can acknowledge that exact state but cannot reset
                // keys if a setup field was deleted or nulled afterwards.
                let auth = service.authenticate(&ctx.headers).await?;
                let repository = service.records()?.tenant(&auth.tenant)?;
                let mut transaction = repository.transaction()?;
                accounts::checked_session(&mut transaction, &auth).await?;
                let root = metadata_root(&mut transaction, &auth.tenant).await?;
                if serde_json::to_value(root.profile).map_err(internal)?
                    != serde_json::to_value(input).map_err(internal)?
                {
                    return Err(forbidden());
                }
                transaction.validate().await?;
                Ok(Success { success: true })
            }
        })
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    super::initialization::register_contract(
        builder
            .query_stub::<(), super::objects::TrustHistory>("zerotrust.trust.history")
            .query_stub::<(), Status>("zerotrust.status")
            .mutation_stub::<SetupInput, Success>("zerotrust.setup"),
    )
}

pub(super) async fn install_initial(
    transaction: &mut Transaction,
    input: &SetupInput,
) -> RpcResult<()> {
    if transaction.read::<RootState>(root_key()).await?.is_some() {
        return Err(forbidden());
    }
    write_root(
        transaction,
        &RootState {
            policy_version: "1".into(),
            catalog_version: "1".into(),
            profile: input.clone(),
        },
    )
    .await?;
    transaction.anchor("authority", &input.authority).await?;
    transaction
        .put_protected(key("policies", "1"), &input.policy)
        .await?;
    transaction
        .put_protected(key("policy-generations", "1"), &"1")
        .await?;
    transaction
        .put_protected(
            super::recovery::inventory::record_key(),
            &sortsys_zerotrust::recovery_inventory::RecoveryInventory::default(),
        )
        .await?;
    transaction
        .put_protected(
            key("authority-history", "00000000000000000001"),
            &super::objects::AuthorityHistory {
                certificate: input.authority.clone(),
                transition: None,
            },
        )
        .await?;
    append_identity(
        transaction,
        &input.owner,
        &sized::<32>(&input.authority.authority_signing_key)?,
    )
    .await
}

pub(super) async fn public_root(system: &Repository, tenant: &str) -> RpcResult<RootState> {
    let repository = crate::control::tenants::published_repository(system, tenant).await?;
    crate::control::read_snapshot(|| async {
        let mut transaction = repository.transaction()?;
        let root = metadata_root(&mut transaction, tenant).await?;
        transaction.validate().await?;
        Ok(root)
    })
    .await
}

pub(super) fn metadata_root_records() -> [sortsys_zerotrust::metadata::RecordKey; 4] {
    use sortsys_zerotrust::anchors::ANCHOR_COLLECTION;

    [
        root_key(),
        crate::control::content::head_key(),
        key(ANCHOR_COLLECTION, "authority"),
        key(ANCHOR_COLLECTION, "security"),
    ]
}

pub(super) async fn metadata_root(
    transaction: &mut Transaction,
    tenant: &str,
) -> RpcResult<RootState> {
    transaction.prefetch(metadata_root_records().into()).await?;
    let root: RootState = transaction.read(root_key()).await?.ok_or_else(forbidden)?;
    root.profile.authority.verify()?;
    if root.profile.authority.tenant != tenant {
        return Err(forbidden());
    }
    validate_anchor(transaction, &root).await?;
    Ok(root)
}

fn root_fingerprint(root: &RootState) -> RpcResult<String> {
    let value = serde_json::to_string(root).map_err(internal)?;
    Ok(crate::control::fingerprint(&value))
}

pub(super) async fn write_root(transaction: &mut Transaction, root: &RootState) -> RpcResult<()> {
    transaction.put(root_key(), root).await?;
    transaction
        .anchor("security", &root_fingerprint(root)?)
        .await?;
    transaction
        .protect_records("security-record", &[root_key()])
        .await
}

/// Advance the public access inventory in the same transaction as its change.
/// Ordinary content revisions deliberately do not invalidate that inventory.
pub(super) async fn advance_catalog(transaction: &mut Transaction, tenant: &str) -> RpcResult<()> {
    let mut root = metadata_root(transaction, tenant).await?;
    root.catalog_version = super::crypto::revision(&root.catalog_version)?
        .checked_add(1)
        .ok_or_else(super::objects::conflict)?
        .to_string();
    write_root(transaction, &root).await
}

async fn validate_anchor(transaction: &mut Transaction, root: &RootState) -> RpcResult<()> {
    use sortsys_zerotrust::anchors::{ANCHOR_COLLECTION, RecordAnchor};
    let anchor: RecordAnchor = transaction
        .read(key(ANCHOR_COLLECTION, "authority"))
        .await?
        .ok_or_else(forbidden)?;
    anchor.validate()?;
    if anchor.revision != root.profile.authority.generation
        || anchor.payload != serde_json::to_string(&root.profile.authority).map_err(internal)?
    {
        return Err(forbidden());
    }
    let security: RecordAnchor = transaction
        .read(key(ANCHOR_COLLECTION, "security"))
        .await?
        .ok_or_else(forbidden)?;
    security.validate()?;
    if security.payload != serde_json::to_string(&root_fingerprint(root)?).map_err(internal)? {
        return Err(forbidden());
    }
    Ok(())
}
pub(super) async fn metadata_history(
    transaction: &mut Transaction,
) -> RpcResult<super::objects::TrustHistory> {
    let authorities = transaction
        .all::<super::objects::AuthorityHistory>("authority-history", 10000)
        .await?;
    let identities = transaction
        .all::<IdentityCertificate>("identity-history", 10000)
        .await?;
    Ok(super::objects::TrustHistory {
        authorities,
        identities,
    })
}

pub(super) async fn history(
    service: &AuthService,
    context: &RequestContext,
) -> RpcResult<super::objects::TrustHistory> {
    let mut context =
        super::access::metadata_context_for_domains(service, context, Some(&[])).await?;
    let history = metadata_history(&mut context.transaction).await?;
    context.transaction.validate().await?;
    Ok(history)
}

pub(super) use super::crypto::packet_hash;

fn validate_owner_grants(
    policy: &SignedPolicy,
    tenant: &str,
    subject: &str,
    scopes: &[(String, Facet)],
) -> RpcResult<()> {
    if policy
        .suspended
        .as_ref()
        .is_some_and(|members| members.iter().any(|member| member == subject))
    {
        return Err(invalid());
    }
    let tenant_scope = format!("tenant:{tenant}");
    let mut required: BTreeSet<_> = Facet::ALL
        .iter()
        .map(|facet| (tenant_scope.as_str(), facet.name()))
        .chain(
            scopes
                .iter()
                .map(|(scope, facet)| (scope.as_str(), facet.name())),
        )
        .collect();
    let mut creation: BTreeSet<_> = super::creation::CREATION_SCOPES
        .iter()
        .map(|&(_, scope)| scope)
        .collect();
    for rule in &policy.rules {
        if rule.subject != subject || rule.effect != Effect::Allow || rule.origin.is_some() {
            return Err(invalid());
        }
        let scope = rule.scope.as_str();
        if required.remove(&(scope, rule.facet.name())) {
            // Verified policy rules contain distinct actions from the six-action vocabulary.
            if rule.actions.len() != 6 {
                return Err(invalid());
            }
        } else if rule.facet != Facet::MasterData
            || rule.actions != [Action::Create]
            || !creation.remove(scope)
        {
            return Err(invalid());
        }
    }
    if !required.is_empty() {
        return Err(invalid());
    }
    Ok(())
}

impl SetupInput {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        let hashes = [
            packet_hash(self.authority.frame()?, &self.authority.signature)?,
            packet_hash(self.owner.frame()?, &self.owner.signature)?,
            packet_hash(
                self.authority_envelope.frame()?,
                &self.authority_envelope.signature,
            )?,
            packet_hash(self.catalog.frame()?, &self.catalog.signature)?,
            packet_hash(self.policy.frame()?, &self.policy.signature)?,
        ];
        let mut fields = vec![self.authority.tenant.as_str(), self.owner.user.as_str()];
        fields.extend(hashes.iter().map(String::as_str));
        Ok(frame("sortsys/tenant-setup/v1", &fields))
    }
    pub(super) fn validate(
        &self,
        tenant: &str,
        subject: &str,
        encryption_key: &[u8],
        signing_key: &[u8],
    ) -> RpcResult<()> {
        self.validate_for(tenant, subject, encryption_key, signing_key, 1, 1, &[])
    }

    #[allow(clippy::too_many_arguments)]
    pub fn validate_for(
        &self,
        tenant: &str,
        subject: &str,
        encryption_key: &[u8],
        signing_key: &[u8],
        generation: i64,
        policy_version: i64,
        scopes: &[(String, Facet)],
    ) -> RpcResult<()> {
        if self.authority.tenant != tenant
            || self.authority.generation != generation.to_string()
            || self.owner.tenant != tenant
            || self.owner.generation != generation.to_string()
            || self.owner.user != subject
            || self.owner.previous_signature.is_some()
            || sized::<32>(&self.owner.encryption_key)?.as_slice() != encryption_key
            || sized::<32>(&self.owner.signing_key)?.as_slice() != signing_key
            || self.policy.tenant != tenant
            || self.policy.version != policy_version.to_string()
            || self
                .policy
                .administration
                .as_ref()
                .is_some_and(|entry| entry.continuation.is_some())
        {
            return Err(invalid());
        }
        self.authority.verify()?;
        let authority = sized::<32>(&self.authority.authority_signing_key)?;
        self.owner.verify(&authority)?;
        self.policy.verify(&authority)?;
        validate_owner_grants(&self.policy, tenant, subject, scopes)?;
        let authority_subject = format!("authority:{generation}");
        let recovery_subject = format!("recovery:{generation}");
        for (envelope, purpose, object, recipient) in [
            (
                &self.authority_envelope,
                "authority-key",
                authority_subject.as_str(),
                subject,
            ),
            (
                &self.catalog,
                "recovery-catalog",
                "catalog",
                recovery_subject.as_str(),
            ),
        ] {
            if envelope.tenant != tenant
                || envelope.purpose != purpose
                || envelope.object != object
                || envelope.recipient != recipient
                || envelope.generation != generation.to_string()
                || envelope.author != authority_subject
            {
                return Err(invalid());
            }
            envelope.verify(&authority)?;
        }
        verify(signing_key, &self.proof, &self.frame()?)
    }
}
