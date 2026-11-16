//! Public key registry in the tenant's DuckDB file. No decrypted business data
//! or private key is accepted by these procedures.
use super::super::access::MetadataContext;
use super::*;
use crate::{
    auth::{AuthResult, AuthService},
    control::{Transaction, accounts, key},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct DomainRecord {
    pub id: String,
    pub scope: String,
    pub facet: Facet,
    pub generation: String,
    pub policy_version: String,
    pub sequence: String,
    pub definitions: BTreeMap<String, Vec<String>>,
    pub recipients: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::zerotrust) struct DomainDescriptor {
    pub id: String,
    pub scope: String,
    pub facet: Facet,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct RecoveryKeyReference {
    pub domain: String,
    pub generation: String,
    pub authority_generation: String,
}

pub(in crate::zerotrust) fn recovery_key(
    reference: &RecoveryKeyReference,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    identifier(&reference.domain)?;
    Ok(key(
        &format!(
            "recovery-inventory-{}",
            revision(&reference.authority_generation)?
        ),
        &format!("{}:{}", reference.domain, padded(&reference.generation)?),
    ))
}

pub(in crate::zerotrust) async fn catalog(
    transaction: &mut Transaction,
) -> RpcResult<Vec<DomainDescriptor>> {
    transaction.all("domain-catalog", 2000).await
}
pub(in crate::zerotrust) async fn has_key(
    transaction: &mut Transaction,
    domain: &str,
    generation: &str,
    subject: &str,
) -> RpcResult<bool> {
    let envelope: Option<SealedBox> = transaction
        .read(envelope_key(domain, generation, subject)?)
        .await?;
    let Some(envelope) = envelope else {
        return Ok(false);
    };
    envelope.frame()?;
    if envelope.object != domain
        || envelope.generation != generation
        || envelope.recipient != subject
        || envelope.purpose != "area-key"
    {
        return Err(invalid());
    }
    Ok(true)
}

use super::super::access::{metadata_context as context, metadata_context_for_domains};
fn admin(auth: &AuthResult) -> RpcResult<()> {
    if !auth.is_admin() {
        return Err(forbidden());
    }
    Ok(())
}
fn padded(version: &str) -> RpcResult<String> {
    Ok(format!("{:020}", revision(version)?))
}
pub(in crate::zerotrust) fn definition_key(
    domain: &str,
    generation: &str,
    authority: &str,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    identifier(domain)?;
    Ok(key(
        "domain-definitions",
        &format!("{domain}:{}:{}", padded(generation)?, padded(authority)?),
    ))
}
pub(in crate::zerotrust) fn envelope_key(
    domain: &str,
    generation: &str,
    subject: &str,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    identifier(domain)?;
    identifier(subject)?;
    Ok(key(
        "key-envelopes",
        &format!("{domain}:{}:{subject}", padded(generation)?),
    ))
}
pub(in crate::zerotrust) async fn domain(
    transaction: &mut Transaction,
    id: &str,
) -> RpcResult<DomainRecord> {
    identifier(id)?;
    let record: DomainRecord = transaction
        .read(key("domains", id))
        .await?
        .ok_or_else(not_found)?;
    if record.id != id {
        return Err(invalid());
    }
    Ok(record)
}
async fn authority_at(
    transaction: &mut Transaction,
    tenant: &str,
    generation: &str,
) -> RpcResult<AuthorityCertificate> {
    let row: AuthorityHistory = transaction
        .read(key("authority-history", &padded(generation)?))
        .await?
        .ok_or_else(not_found)?;
    row.certificate.verify()?;
    if row.certificate.tenant != tenant || row.certificate.generation != generation {
        return Err(invalid());
    }
    Ok(row.certificate)
}
async fn policy_at(
    transaction: &mut Transaction,
    tenant: &str,
    version: &str,
) -> RpcResult<HistoricalPolicy> {
    revision(version)?;
    let policy: SignedPolicy = transaction
        .read(key("policies", version))
        .await?
        .ok_or_else(not_found)?;
    let generation: String = transaction
        .read(key("policy-generations", version))
        .await?
        .ok_or_else(not_found)?;
    let authority = authority_at(transaction, tenant, &generation).await?;
    policy.verify(&sized::<32>(&authority.authority_signing_key)?)?;
    if policy.tenant != tenant || policy.version != version {
        return Err(invalid());
    }
    Ok(HistoricalPolicy { generation, policy })
}
fn readers(policy: &SignedPolicy, inherited: &[super::super::wire::Rule]) -> ReaderSets {
    let mut sets = policy_readers(policy.rules.iter().chain(inherited));
    if let Some(suspended) = &policy.suspended {
        for set in sets.values_mut() {
            set.retain(|subject| !suspended.contains(subject));
        }
    }
    sets
}
fn area_readers(sets: &ReaderSets, area: &DomainRecord) -> BTreeSet<String> {
    sets.get(&(area.scope.clone(), area.facet.name().into()))
        .map(|subjects| subjects.iter().cloned().collect())
        .unwrap_or_default()
}
pub(in crate::zerotrust) struct RotationChecks {
    current: ReaderSets,
    previous: BTreeMap<String, ReaderSets>,
    pending_assignments: BTreeSet<String>,
}
impl RotationChecks {
    pub(in crate::zerotrust) fn new(guard: &Security) -> Self {
        Self {
            current: readers(&guard.policy, &guard.inherited),
            previous: BTreeMap::new(),
            pending_assignments: BTreeSet::new(),
        }
    }
    pub(in crate::zerotrust) async fn required(
        &mut self,
        transaction: &mut Transaction,
        guard: &Security,
        area: &DomainRecord,
    ) -> RpcResult<bool> {
        let mut current = area_readers(&self.current, area);
        let mut pending_assignment = false;
        if area.generation == "1"
            && let Some(origin) = guard.origins.iter().find(|origin| origin.id == area.id)
            && origin.access.is_none()
            && let Some(assignee) = &origin.assignee
        {
            let canonical = format!("{}:master-data:record", origin.scope);
            if self.pending_assignments.contains(&area.scope)
                || super::persistence::object(transaction, &canonical)
                    .await?
                    .is_none()
            {
                pending_assignment = true;
                self.pending_assignments.insert(area.scope.clone());
                let mut prospective = guard.inherited.clone();
                prospective.push(super::super::wire::Rule {
                    origin: None,
                    subject: assignee.user.clone(),
                    scope: area.scope.clone(),
                    facet: area.facet,
                    actions: vec![Action::Read],
                    effect: super::super::wire::Effect::Allow,
                });
                if guard.policy.allows_with(
                    &prospective,
                    &assignee.user,
                    &area.scope,
                    area.facet,
                    Action::Read,
                ) {
                    current.insert(assignee.user.clone());
                }
            }
        }
        if area.recipients.get(&area.generation) != Some(&current) {
            return Ok(true);
        }
        if pending_assignment {
            return Ok(false);
        }
        if area.policy_version == guard.policy.version {
            return Ok(false);
        }
        if !self.previous.contains_key(&area.policy_version) {
            let policy = policy_at(transaction, &guard.policy.tenant, &area.policy_version).await?;
            self.previous.insert(
                area.policy_version.clone(),
                readers(&policy.policy, &guard.inherited),
            );
        }
        let previous = self
            .previous
            .get(&area.policy_version)
            .ok_or_else(invalid)?;
        Ok(area_readers(previous, area) != current)
    }
}
pub(in crate::zerotrust) fn certified_identity(
    account: &accounts::Account,
    guard: &Security,
) -> RpcResult<Option<IdentityCertificate>> {
    let Some(credential) = &account.credential else {
        return Ok(None);
    };
    if credential.certificate == serde_json::json!({"format": "pending"}) {
        return Ok(None);
    }
    let certificate: IdentityCertificate =
        serde_json::from_value(credential.certificate.clone()).map_err(|_| invalid())?;
    if certificate.tenant != guard.policy.tenant
        || certificate.user != format!("user:{}", Id(account.id).encode())
        || certificate.encryption_key != credential.vault.encryption_key
        || certificate.signing_key != credential.vault.signing_key
    {
        return Err(invalid());
    }
    let generation = revision(&certificate.generation)?;
    if generation < guard.root.generation {
        // Recovery preserves historical authors. Their old certificate grants
        // no live access under the replacement authority.
        return Ok(None);
    }
    if generation != guard.root.generation {
        return Err(invalid());
    }
    certificate.verify(&guard.authority)?;
    Ok(Some(certificate))
}
async fn member_account(
    transaction: &mut Transaction,
    subject: &str,
) -> RpcResult<accounts::Account> {
    let user =
        Id::decode(subject.strip_prefix("user:").ok_or_else(invalid)?).map_err(|_| invalid())?;
    if user.0 <= 0 || format!("user:{}", user.encode()) != subject {
        return Err(invalid());
    }
    let account: accounts::Account = transaction
        .read(accounts::account_key(user.0))
        .await?
        .ok_or_else(forbidden)?;
    if account.id != user.0 {
        return Err(invalid());
    }
    Ok(account)
}
async fn active_member(
    transaction: &mut Transaction,
    guard: &Security,
    subject: &str,
) -> RpcResult<accounts::Account> {
    let account = member_account(transaction, subject).await?;
    if !account.active(chrono::Utc::now())
        || guard
            .policy
            .suspended
            .as_ref()
            .is_some_and(|members| members.iter().any(|member| member == subject))
    {
        return Err(forbidden());
    }
    Ok(account)
}
async fn checked_member(
    transaction: &mut Transaction,
    guard: &Security,
    subject: &str,
) -> RpcResult<IdentityCertificate> {
    let account = active_member(transaction, guard, subject).await?;
    certified_identity(&account, guard)?.ok_or_else(forbidden)
}
pub(in crate::zerotrust) async fn check_member(
    transaction: &mut Transaction,
    guard: &Security,
    expected: &IdentityCertificate,
) -> RpcResult<()> {
    let current = checked_member(transaction, guard, &expected.user).await?;
    if current.encryption_key != expected.encryption_key
        || current.signing_key != expected.signing_key
    {
        return Err(forbidden());
    }
    expected.verify(&guard.authority)?;
    Ok(())
}

/// Both the standalone inventory and the combined access snapshot retain the
/// same visibility and key-rotation checks, inside their caller's transaction.
pub(super) async fn list_domains(
    context: &mut super::super::access::MetadataContext,
    selected: Option<&[String]>,
) -> RpcResult<Vec<DomainInfo>> {
    let areas = if let Some(ids) = selected {
        let records = context
            .transaction
            .many::<DomainRecord>(ids.iter().map(|id| key("domains", id)).collect())
            .await?;
        let mut areas = Vec::new();
        for (id, record) in ids.iter().zip(records) {
            if let Some(record) = record {
                if record.id != *id {
                    return Err(invalid());
                }
                areas.push(record);
            }
        }
        areas
    } else {
        context
            .transaction
            .all::<DomainRecord>("domains", 2000)
            .await?
    };
    let mut result = Vec::new();
    let mut rotation = RotationChecks::new(&context.security);
    for area in areas {
        if context.auth.is_admin()
            || context.security.allows(
                &context.security.subject,
                &area.scope,
                area.facet,
                Action::Read,
            )
        {
            result.push(DomainInfo {
                id: area.id.clone(),
                scope: area.scope.clone(),
                facet: area.facet.name().into(),
                generation: area.generation.clone(),
                rotation_required: rotation
                    .required(&mut context.transaction, &context.security, &area)
                    .await?,
            });
        }
    }
    Ok(result)
}

pub(in crate::zerotrust) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let access_snapshot = Arc::clone(&service);
    let access_page = Arc::clone(&service);
    let policy_get = Arc::clone(&service);
    let policy_history = Arc::clone(&service);
    let policy_set = Arc::clone(&service);
    let domains = Arc::clone(&service);
    let domain_set = Arc::clone(&service);
    let domain_batch = Arc::clone(&service);
    let access_publish = Arc::clone(&service);
    let key_inspection = Arc::clone(&service);
    let keys = Arc::clone(&service);
    let key_grant = Arc::clone(&service);
    let definitions = Arc::clone(&service);
    let directory = Arc::clone(&service);
    let public_identity = Arc::clone(&service);
    builder
        .query(
            "zerotrust.access.snapshot",
            move |ctx, input: AccessInput| {
                let service = Arc::clone(&access_snapshot);
                async move { super::access_inventory::first(&service, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.access.page",
            move |ctx, input: AccessPageInput| {
                let service = Arc::clone(&access_page);
                async move { super::access_inventory::next(&service, &ctx, input).await }
            },
        )
        .query("zerotrust.policy.get", move |ctx, _: ()| {
            let service = Arc::clone(&policy_get);
            async move {
                let context = metadata_context_for_domains(&service, &ctx, Some(&[])).await?;
                context.transaction.validate().await?;
                Ok(context.security.policy)
            }
        })
        .query(
            "zerotrust.policy.getVersion",
            move |ctx, input: PolicyVersionInput| {
                let service = Arc::clone(&policy_history);
                async move {
                    let mut context =
                        metadata_context_for_domains(&service, &ctx, Some(&[])).await?;
                    if revision(&input.version)? > context.security.root.policy_version {
                        return Err(not_found());
                    }
                    let result = policy_at(
                        &mut context.transaction,
                        &context.auth.tenant,
                        &input.version,
                    )
                    .await?;
                    context.transaction.validate().await?;
                    Ok(result)
                }
            },
        )
        .mutation(
            "zerotrust.policy.replace",
            move |ctx, input: SignedPolicy| {
                let service = Arc::clone(&policy_set);
                async move {
                    if input.transaction.is_some() {
                        return Err(invalid());
                    }
                    let mut context = context(&service, &ctx).await?;
                    if input.administration.is_none() {
                        admin(&context.auth)?;
                    }
                    replace_policy(&mut context.transaction, &context.security, &input, false)
                        .await?;
                    context.transaction.commit().await?;
                    Ok(Success { success: true })
                }
            },
        )
        .query("zerotrust.domains.list", move |ctx, _: ()| {
            let service = Arc::clone(&domains);
            async move {
                let mut context = context(&service, &ctx).await?;
                let result = list_domains(&mut context, None).await?;
                context.transaction.validate().await?;
                Ok(result)
            }
        })
        .mutation(
            "zerotrust.domains.put",
            move |ctx, input: DomainDefinition| {
                let service = Arc::clone(&domain_set);
                async move { put_domain(&service, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.domains.putMany",
            move |ctx, input: DomainDefinitionsInput| {
                let service = Arc::clone(&domain_batch);
                async move { put_domains(&service, &ctx, input.domains).await }
            },
        )
        .mutation(
            "zerotrust.access.publish",
            move |ctx, input: AccessPublicationInput| {
                let service = Arc::clone(&access_publish);
                async move { publish_access(&service, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.keys.inspect",
            move |ctx, input: KeyInspectionInput| {
                let service = Arc::clone(&key_inspection);
                async move { inspect_keys(&service, &ctx, input).await }
            },
        )
        .query("zerotrust.domains.get", move |ctx, input: KeyInput| {
            let service = Arc::clone(&definitions);
            async move {
                identifier(&input.domain)?;
                let mut context = metadata_context_for_domains(
                    &service,
                    &ctx,
                    Some(std::slice::from_ref(&input.domain)),
                )
                .await?;
                let area = domain(&mut context.transaction, &input.domain).await?;
                if !context.auth.is_admin()
                    && !context.security.allows(
                        &context.security.subject,
                        &area.scope,
                        area.facet,
                        Action::Read,
                    )
                {
                    return Err(forbidden());
                }
                let result = definition_at(
                    &mut context.transaction,
                    &context.security,
                    &area,
                    &input.generation,
                )
                .await?;
                context.transaction.validate().await?;
                Ok(result)
            }
        })
        .query("zerotrust.keys.get", move |ctx, input: KeyInput| {
            let service = Arc::clone(&keys);
            async move {
                identifier(&input.domain)?;
                let mut context = metadata_context_for_domains(
                    &service,
                    &ctx,
                    Some(std::slice::from_ref(&input.domain)),
                )
                .await?;
                let area = domain(&mut context.transaction, &input.domain).await?;
                if !context.security.allows(
                    &context.security.subject,
                    &area.scope,
                    area.facet,
                    Action::Read,
                ) {
                    return Err(forbidden());
                }
                revision(&input.generation)?;
                let envelope: SealedBox = context
                    .transaction
                    .read(envelope_key(
                        &area.id,
                        &input.generation,
                        &context.security.subject,
                    )?)
                    .await?
                    .ok_or_else(not_found)?;
                context.transaction.validate().await?;
                Ok(envelope)
            }
        })
        .mutation("zerotrust.keys.grant", move |ctx, input: KeyGrant| {
            let service = Arc::clone(&key_grant);
            async move { grant_key(&service, &ctx, input).await }
        })
        .query(
            "zerotrust.identities.get",
            move |ctx, input: IdentityInput| {
                let service = Arc::clone(&public_identity);
                async move {
                    let mut context =
                        metadata_context_for_domains(&service, &ctx, Some(&[])).await?;
                    let account = member_account(&mut context.transaction, &input.subject).await?;
                    let suspended = context
                        .security
                        .policy
                        .suspended
                        .as_ref()
                        .is_some_and(|members| members.contains(&input.subject));
                    let certificate = if account.active(chrono::Utc::now()) && !suspended {
                        certified_identity(&account, &context.security)?
                    } else {
                        None
                    };
                    context.transaction.validate().await?;
                    Ok(certificate)
                }
            },
        )
        .query("zerotrust.identities.list", move |ctx, _: ()| {
            let service = Arc::clone(&directory);
            async move {
                let mut context = context(&service, &ctx).await?;
                admin(&context.auth)?;
                let rows = context
                    .transaction
                    .all::<accounts::Account>("accounts", 2000)
                    .await?;
                let mut result = Vec::new();
                for account in rows {
                    if !account.active(chrono::Utc::now()) {
                        continue;
                    }
                    let Some(certificate) = certified_identity(&account, &context.security)? else {
                        continue;
                    };
                    result.push(IdentityInfo {
                        subject: certificate.user.clone(),
                        encryption_key: certificate.encryption_key.clone(),
                        signing_key: certificate.signing_key.clone(),
                        certificate: serde_json::to_value(certificate).map_err(internal)?,
                    });
                }
                context.transaction.validate().await?;
                Ok(result)
            }
        })
        .mutation(
            "zerotrust.identities.certify",
            move |ctx, input: IdentityCertificate| {
                let service = Arc::clone(&service);
                async move { certify_identity(&service, &ctx, input).await }
            },
        )
}

pub(in crate::zerotrust) async fn replace_policy(
    transaction: &mut Transaction,
    guard: &Security,
    input: &SignedPolicy,
    account_change: bool,
) -> RpcResult<()> {
    input.verify(&guard.authority)?;
    if let Some(administration) = &input.administration {
        if account_change {
            return Err(forbidden());
        }
        let actor = checked_member(transaction, guard, &guard.subject).await?;
        if !input.administrative_replacement(&guard.policy, &actor)? {
            return Err(forbidden());
        }
        for profile in &administration.profiles {
            if profile.version == input.version {
                checked_member(transaction, guard, &profile.subject).await?;
            }
        }
    }
    if input.tenant != guard.policy.tenant
        || guard.root.policy_version.checked_add(1) != Some(revision(&input.version)?)
        || !account_change
            && input.suspended.as_deref().unwrap_or_default()
                != guard.policy.suspended.as_deref().unwrap_or_default()
    {
        return Err(conflict());
    }
    if input
        .rules
        .iter()
        .any(|rule| !rule.subject.starts_with("user:"))
    {
        return Err(invalid());
    }
    if transaction
        .read::<Value>(key("policies", &input.version))
        .await?
        .is_some()
        || transaction
            .read::<Value>(key("policy-generations", &input.version))
            .await?
            .is_some()
    {
        return Err(conflict());
    }
    let mut root: super::super::setup::RootState = transaction
        .read(super::super::setup::root_key())
        .await?
        .ok_or_else(forbidden)?;
    transaction
        .put_protected(key("policies", &input.version), input)
        .await?;
    transaction
        .put_protected(
            key("policy-generations", &input.version),
            &guard.root.generation.to_string(),
        )
        .await?;
    root.policy_version = input.version.clone();
    super::super::setup::write_root(transaction, &root).await?;
    // The root policy version is the durable rotation marker. Comparing a
    // domain's bound policy with this policy avoids rewriting all 2000 domains
    // in every permission update. Both policies remain signed and immutable.
    transaction.notify("access", &serde_json::json!({"policy": input.version}))
}

async fn certify_identity(
    service: &AuthService,
    request: &RequestContext,
    input: IdentityCertificate,
) -> RpcResult<Success> {
    let mut context = context(service, request).await?;
    admin(&context.auth)?;
    install_identity(&mut context.transaction, &context.security, &input).await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}

pub(in crate::zerotrust) async fn install_identity(
    transaction: &mut Transaction,
    guard: &Security,
    input: &IdentityCertificate,
) -> RpcResult<()> {
    input.verify(&guard.authority)?;
    if input.tenant != guard.policy.tenant || input.generation != guard.root.generation.to_string()
    {
        return Err(invalid());
    }
    let user =
        Id::decode(input.user.strip_prefix("user:").ok_or_else(invalid)?).map_err(|_| invalid())?;
    let mut account: accounts::Account = transaction
        .read(accounts::account_key(user.0))
        .await?
        .ok_or_else(forbidden)?;
    if !account.active(chrono::Utc::now())
        || account.credential()?.vault.encryption_key != input.encryption_key
        || account.credential()?.vault.signing_key != input.signing_key
    {
        return Err(invalid());
    }
    // Reapproval under a new tenant authority does not renew roles granted by
    // its predecessor. Reissuing a current certificate preserves current roles.
    if certified_identity(&account, guard)?.is_none() {
        account.roles.clear();
    }
    account.credential_mut()?.certificate = serde_json::to_value(input).map_err(internal)?;
    transaction
        .put_protected(accounts::account_key(user.0), &account)
        .await?;
    let history_key = super::super::setup::identity_history_key(input)?;
    if let Some(previous) = transaction
        .read::<IdentityCertificate>(history_key.clone())
        .await?
        && serde_json::to_value(previous).map_err(internal)?
            != serde_json::to_value(input).map_err(internal)?
    {
        return Err(conflict());
    }
    transaction.put_protected(history_key, input).await?;
    transaction.notify("account", &serde_json::json!({"subject": input.user}))?;
    Ok(())
}

pub(in crate::zerotrust) async fn definition_at(
    transaction: &mut Transaction,
    guard: &Security,
    area: &DomainRecord,
    generation: &str,
) -> RpcResult<DomainDefinition> {
    revision(generation)?;
    let available = area.definitions.get(generation).ok_or_else(not_found)?;
    let mut selected = None;
    for candidate in available {
        let number = revision(candidate)?;
        if number <= guard.root.generation
            && selected
                .as_ref()
                .is_none_or(|(current, _)| number > *current)
        {
            selected = Some((number, candidate));
        }
    }
    let (_, authority_generation) = selected.ok_or_else(not_found)?;
    let definition: DomainDefinition = transaction
        .read(definition_key(&area.id, generation, authority_generation)?)
        .await?
        .ok_or_else(not_found)?;
    if definition.tenant != guard.policy.tenant
        || definition.id != area.id
        || definition.generation != generation
        || definition.scope != area.scope
        || definition.facet != area.facet
    {
        return Err(invalid());
    }
    let authority = authority_at(transaction, &guard.policy.tenant, authority_generation).await?;
    let signing_key = if let Some(origin) = &definition.creation {
        origin.verify(&sized::<32>(&authority.authority_signing_key)?)?;
        sized::<32>(&origin.capability.creator.signing_key)?
    } else {
        sized::<32>(&authority.authority_signing_key)?
    };
    verify(&signing_key, &definition.proof, &definition.frame()?)?;
    Ok(definition)
}

fn capability_key(
    capability: &super::super::creation::CreationCapability,
) -> sortsys_zerotrust::metadata::RecordKey {
    key(
        "creation-capabilities",
        &format!(
            "{}:{}:{}",
            capability.generation, capability.creator.user, capability.namespace
        ),
    )
}
pub(in crate::zerotrust) fn origin_collection(generation: i64) -> String {
    format!("created-areas-{generation}")
}

async fn check_creation(
    transaction: &mut Transaction,
    guard: &Security,
    input: &DomainDefinition,
) -> RpcResult<()> {
    let Some(origin) = &input.creation else {
        return Ok(());
    };
    if let Some(parent) = &origin.parent {
        let registered: Value = transaction
            .read(key(&origin_collection(guard.root.generation), &parent.id))
            .await?
            .ok_or_else(forbidden)?;
        if registered != serde_json::to_value(parent).map_err(internal)? {
            return Err(forbidden());
        }
    }
    if origin.facet != Facet::MasterData {
        let master: super::super::creation::CreationOrigin = transaction
            .read(key(
                &origin_collection(guard.root.generation),
                &format!("{}:master-data", origin.scope),
            ))
            .await?
            .ok_or_else(forbidden)?;
        master.verify(&guard.authority)?;
        if master.tenant != input.tenant
            || master.scope != origin.scope
            || master.facet != Facet::MasterData
            || master.capability.creator.user != guard.subject
            || master.capability.namespace != origin.capability.namespace
        {
            return Err(forbidden());
        }
    }
    if !guard.policy.allows(
        &guard.subject,
        origin.capability.creation_scope()?,
        Facet::MasterData,
        Action::Create,
    ) {
        return Err(forbidden());
    }
    let published: super::super::creation::CreationCapability = transaction
        .read(capability_key(&origin.capability))
        .await?
        .ok_or_else(forbidden)?;
    if serde_json::to_value(published).map_err(internal)?
        != serde_json::to_value(&origin.capability).map_err(internal)?
    {
        return Err(forbidden());
    }
    if origin.access.is_some() {
        return Err(invalid());
    }
    if origin.facet == Facet::Scope && origin.assignee.is_some() {
        let master: super::super::creation::CreationOrigin = transaction
            .read(key(
                &origin_collection(guard.root.generation),
                &format!("{}:master-data", origin.scope),
            ))
            .await?
            .ok_or_else(forbidden)?;
        if serde_json::to_value(&master.assignee).map_err(internal)?
            != serde_json::to_value(&origin.assignee).map_err(internal)?
            || master.capability.signature != origin.capability.signature
        {
            return Err(forbidden());
        }
    }
    for member in origin.recipients() {
        check_member(transaction, guard, member).await?;
    }
    let expected: BTreeSet<_> = origin
        .recipients()
        .into_iter()
        .map(|member| member.user.clone())
        .collect();
    let actual: BTreeSet<_> = input
        .envelopes
        .iter()
        .map(|envelope| envelope.recipient.clone())
        .collect();
    if actual != expected {
        return Err(forbidden());
    }
    Ok(())
}

async fn put_domain(
    service: &AuthService,
    request: &RequestContext,
    input: DomainDefinition,
) -> RpcResult<Success> {
    put_domains(service, request, vec![input]).await
}

async fn put_domains(
    service: &AuthService,
    request: &RequestContext,
    inputs: Vec<DomainDefinition>,
) -> RpcResult<Success> {
    // Each created area emits two hints and may store nine recipient envelopes
    // plus their integrity witnesses. Stay inside both metadata batch limits.
    if inputs.is_empty() || inputs.len() > 32 {
        return Err(invalid());
    }
    let mut seen = BTreeSet::new();
    if inputs.iter().any(|input| !seen.insert(&input.id)) {
        return Err(invalid());
    }
    let mut context = context(service, request).await?;
    let mut changed = false;
    for input in inputs {
        changed |= put_domain_in_transaction(&mut context, input).await?;
    }
    if changed {
        context.transaction.commit().await?;
    } else {
        context.transaction.validate().await?;
    }
    Ok(Success { success: true })
}

async fn put_domain_in_transaction(
    context: &mut MetadataContext,
    input: DomainDefinition,
) -> RpcResult<bool> {
    let guard = &context.security;
    if !context.auth.is_admin() && input.creation.is_none() {
        return Err(forbidden());
    }
    let signer = if let Some(origin) = &input.creation {
        origin.verify(&guard.authority)?;
        if origin.tenant != context.auth.tenant
            || origin.capability.generation != guard.root.generation.to_string()
            || origin.capability.creator.user != guard.subject
        {
            return Err(forbidden());
        }
        sized::<32>(&origin.capability.creator.signing_key)?.to_vec()
    } else {
        guard.authority.clone()
    };
    verify(&signer, &input.proof, &input.frame()?)?;
    let generation = revision(&input.generation)?;
    if input.tenant != context.auth.tenant || input.policy_version != guard.policy.version {
        return Err(invalid());
    }
    let current: Option<DomainRecord> = context.transaction.read(key("domains", &input.id)).await?;
    if let Some(area) = &current {
        if area.scope == input.scope
            && area.facet == input.facet
            && area.generation == input.generation
        {
            let saved =
                definition_at(&mut context.transaction, guard, area, &input.generation).await?;
            if serde_json::to_value(saved).map_err(internal)?
                == serde_json::to_value(&input).map_err(internal)?
            {
                return Ok(false);
            }
        }
        if input.creation.is_some()
            || area.scope != input.scope
            || area.facet != input.facet
            || revision(&area.generation)?.checked_add(1) != Some(generation)
        {
            return Err(conflict());
        }
    } else if generation != 1 {
        return Err(conflict());
    }
    check_creation(&mut context.transaction, guard, &input).await?;
    let author = input
        .creation
        .as_ref()
        .map(super::super::creation::CreationOrigin::author)
        .unwrap_or_else(|| format!("authority:{}", guard.root.generation));
    let mut inherited = guard.inherited.clone();
    if let Some(origin) = &input.creation {
        inherited.extend(origin.rules());
        if let Some(assignee) = &origin.assignee {
            inherited.push(super::super::wire::Rule {
                origin: None,
                subject: assignee.user.clone(),
                scope: origin.scope.clone(),
                facet: origin.facet,
                actions: vec![Action::Read],
                effect: super::super::wire::Effect::Allow,
            });
        }
    }
    let mut recipients = BTreeSet::new();
    for envelope in &input.envelopes {
        if !guard.policy.allows_with(
            &inherited,
            &envelope.recipient,
            &input.scope,
            input.facet,
            Action::Read,
        ) {
            return Err(forbidden());
        }
        check_box(
            envelope,
            &input.tenant,
            &input.id,
            &input.generation,
            &author,
        )?;
        envelope.verify(&signer)?;
        checked_member(&mut context.transaction, guard, &envelope.recipient).await?;
        recipients.insert(envelope.recipient.clone());
    }
    check_box(
        &input.recovery_envelope,
        &input.tenant,
        &input.id,
        &input.generation,
        &author,
    )?;
    input.recovery_envelope.verify(&signer)?;
    if input.recovery_envelope.recipient != format!("recovery:{}", guard.root.generation) {
        return Err(invalid());
    }
    let mut root: super::super::setup::RootState = context
        .transaction
        .read(super::super::setup::root_key())
        .await?
        .ok_or_else(forbidden)?;
    if current.is_none() {
        let count: u32 = context
            .transaction
            .read(key("domain-inventory", "current"))
            .await?
            .ok_or_else(invalid)?;
        if count >= 2000 {
            return Err(RpcError::new(
                ErrorCode::BadRequest,
                "Protected tenant area limit reached",
            ));
        }
        context
            .transaction
            .put(
                key("domain-catalog", &input.id),
                &DomainDescriptor {
                    id: input.id.clone(),
                    scope: input.scope.clone(),
                    facet: input.facet,
                },
            )
            .await?;
        context
            .transaction
            .put(key("domain-inventory", "current"), &(count + 1))
            .await?;
    }
    let mut area = match current {
        Some(mut area) => {
            area.sequence = revision(&area.sequence)?
                .checked_add(1)
                .ok_or_else(conflict)?
                .to_string();
            area.generation = input.generation.clone();
            area.policy_version = input.policy_version.clone();
            area
        }
        None => DomainRecord {
            id: input.id.clone(),
            scope: input.scope.clone(),
            facet: input.facet,
            generation: input.generation.clone(),
            policy_version: input.policy_version.clone(),
            sequence: "1".into(),
            definitions: BTreeMap::new(),
            recipients: BTreeMap::new(),
        },
    };
    area.definitions
        .entry(input.generation.clone())
        .or_default()
        .push(guard.root.generation.to_string());
    area.recipients.insert(input.generation.clone(), recipients);
    let record = definition_key(
        &input.id,
        &input.generation,
        &guard.root.generation.to_string(),
    )?;
    if context
        .transaction
        .read::<DomainDefinition>(record)
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    context
        .transaction
        .put_protected(
            definition_key(
                &input.id,
                &input.generation,
                &guard.root.generation.to_string(),
            )?,
            &input,
        )
        .await?;
    let reference = RecoveryKeyReference {
        domain: input.id.clone(),
        generation: input.generation.clone(),
        authority_generation: guard.root.generation.to_string(),
    };
    context
        .transaction
        .put_protected(recovery_key(&reference)?, &reference)
        .await?;
    for envelope in &input.envelopes {
        context
            .transaction
            .put_protected(
                envelope_key(&input.id, &input.generation, &envelope.recipient)?,
                envelope,
            )
            .await?;
    }
    if let Some(origin) = &input.creation {
        context
            .transaction
            .put(
                key(&origin_collection(guard.root.generation), &input.id),
                origin,
            )
            .await?;
        context.transaction.notify(
            "access",
            &serde_json::json!({"policy": guard.policy.version}),
        )?;
    }
    context
        .transaction
        .put(key("domains", &input.id), &area)
        .await?;
    root.catalog_version = revision(&root.catalog_version)?
        .checked_add(1)
        .ok_or_else(conflict)?
        .to_string();
    super::super::setup::write_root(&mut context.transaction, &root).await?;
    context.transaction.notify(
        "domain",
        &serde_json::json!({"domain": input.id, "sequence": area.sequence}),
    )?;
    Ok(true)
}

async fn grant_key(
    service: &AuthService,
    request: &RequestContext,
    input: KeyGrant,
) -> RpcResult<Success> {
    let mut context = context(service, request).await?;
    admin(&context.auth)?;
    grant_key_in_transaction(&mut context, input).await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}

async fn grant_key_in_transaction(context: &mut MetadataContext, input: KeyGrant) -> RpcResult<()> {
    let guard = &context.security;
    let mut area = domain(&mut context.transaction, &input.domain).await?;
    if revision(&input.generation)? > revision(&area.generation)?
        || !area.definitions.contains_key(&input.generation)
        || !guard.allows(
            &input.envelope.recipient,
            &area.scope,
            area.facet,
            Action::Read,
        )
    {
        return Err(forbidden());
    }
    check_box(
        &input.envelope,
        &context.auth.tenant,
        &input.domain,
        &input.generation,
        &format!("authority:{}", guard.root.generation),
    )?;
    input.envelope.verify(&guard.authority)?;
    checked_member(&mut context.transaction, guard, &input.envelope.recipient).await?;
    let mut rotation = RotationChecks::new(guard);
    let previous_rotation = rotation
        .required(&mut context.transaction, guard, &area)
        .await?;
    context
        .transaction
        .put_protected(
            envelope_key(&input.domain, &input.generation, &input.envelope.recipient)?,
            &input.envelope,
        )
        .await?;
    area.recipients
        .entry(input.generation)
        .or_default()
        .insert(input.envelope.recipient.clone());
    let current_rotation = rotation
        .required(&mut context.transaction, guard, &area)
        .await?;
    context
        .transaction
        .put(key("domains", &input.domain), &area)
        .await?;
    // Historical grants and replacement envelopes do not change the public
    // inventory. Only invalidate it when the advertised rotation state changes.
    if previous_rotation != current_rotation {
        let mut root =
            super::super::setup::metadata_root(&mut context.transaction, &context.auth.tenant)
                .await?;
        root.catalog_version = revision(&root.catalog_version)?
            .checked_add(1)
            .ok_or_else(conflict)?
            .to_string();
        super::super::setup::write_root(&mut context.transaction, &root).await?;
    }
    context.transaction.notify(
        "account",
        &serde_json::json!({"subject": input.envelope.recipient}),
    )?;
    Ok(())
}

/// Related historical envelopes and replacement generations become visible in
/// one commit. Every grant and definition still uses the current signed policy.
async fn publish_access(
    service: &AuthService,
    request: &RequestContext,
    input: AccessPublicationInput,
) -> RpcResult<Success> {
    revision(&input.policy_version)?;
    let operations = input
        .grants
        .len()
        .checked_add(input.domains.len())
        .ok_or_else(invalid)?;
    if operations == 0 || operations > 32 {
        return Err(invalid());
    }
    let mut grants = BTreeSet::new();
    let mut definitions = BTreeSet::new();
    let mut selected = BTreeSet::new();
    for grant in &input.grants {
        identifier(&grant.domain)?;
        revision(&grant.generation)?;
        identifier(&grant.envelope.recipient)?;
        if !grants.insert((&grant.domain, &grant.generation, &grant.envelope.recipient)) {
            return Err(invalid());
        }
        selected.insert(grant.domain.clone());
    }
    for definition in &input.domains {
        identifier(&definition.id)?;
        if !definitions.insert(&definition.id) {
            return Err(invalid());
        }
        selected.insert(definition.id.clone());
    }
    let selected: Vec<String> = selected.into_iter().collect();
    let mut context = metadata_context_for_domains(service, request, Some(&selected)).await?;
    admin(&context.auth)?;
    if context.security.policy.version != input.policy_version {
        return Err(conflict());
    }
    let has_grants = !input.grants.is_empty();
    for grant in input.grants {
        grant_key_in_transaction(&mut context, grant).await?;
    }
    let mut changed = has_grants;
    for definition in input.domains {
        changed |= put_domain_in_transaction(&mut context, definition).await?;
    }
    if changed {
        context.transaction.commit().await?;
    } else {
        context.transaction.validate().await?;
    }
    Ok(Success { success: true })
}

/// Administrators can verify encrypted packets for their actual recipients
/// without impersonating them or obtaining any recipient's private key.
async fn inspect_keys(
    service: &AuthService,
    request: &RequestContext,
    input: KeyInspectionInput,
) -> RpcResult<Vec<SealedBox>> {
    if input.keys.is_empty() || input.keys.len() > 32 {
        return Err(invalid());
    }
    let mut references = BTreeSet::new();
    let mut selected = BTreeSet::new();
    for reference in &input.keys {
        identifier(&reference.domain)?;
        revision(&reference.generation)?;
        identifier(&reference.recipient)?;
        if !references.insert((
            &reference.domain,
            &reference.generation,
            &reference.recipient,
        )) {
            return Err(invalid());
        }
        selected.insert(reference.domain.clone());
    }
    let selected: Vec<String> = selected.into_iter().collect();
    let mut context = metadata_context_for_domains(service, request, Some(&selected)).await?;
    admin(&context.auth)?;
    let mut result = Vec::new();
    for reference in input.keys {
        let area = domain(&mut context.transaction, &reference.domain).await?;
        if !context
            .security
            .allows(&reference.recipient, &area.scope, area.facet, Action::Read)
        {
            return Err(forbidden());
        }
        if !area.definitions.contains_key(&reference.generation) {
            return Err(not_found());
        }
        let envelope: SealedBox = context
            .transaction
            .read(envelope_key(
                &reference.domain,
                &reference.generation,
                &reference.recipient,
            )?)
            .await?
            .ok_or_else(not_found)?;
        envelope.frame()?;
        if envelope.tenant != context.auth.tenant
            || envelope.object != reference.domain
            || envelope.generation != reference.generation
            || envelope.recipient != reference.recipient
            || envelope.purpose != "area-key"
        {
            return Err(invalid());
        }
        result.push(envelope);
    }
    context.transaction.validate().await?;
    Ok(result)
}

pub(in crate::zerotrust) fn register_creation(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    use super::super::creation::{
        CapabilityInput, CreationCapability, CreationOrigin, OriginInput,
    };
    let list = Arc::clone(&service);
    let get = Arc::clone(&service);
    let capabilities = Arc::clone(&service);
    builder
        .query("zerotrust.creations.list", move |ctx, _: ()| {
            let service = Arc::clone(&list);
            async move {
                let context = context(&service, &ctx).await?;
                context.transaction.validate().await?;
                Ok(context.security.origins)
            }
        })
        .query(
            "zerotrust.creations.origin",
            move |ctx, input: OriginInput| {
                let service = Arc::clone(&get);
                async move {
                    identifier(&input.domain)?;
                    let mut context = metadata_context_for_domains(
                        &service,
                        &ctx,
                        Some(std::slice::from_ref(&input.domain)),
                    )
                    .await?;
                    let area = domain(&mut context.transaction, &input.domain).await?;
                    if !context.auth.is_admin()
                        && !context.security.allows(
                            &context.security.subject,
                            &area.scope,
                            area.facet,
                            Action::Read,
                        )
                    {
                        return Err(forbidden());
                    }
                    let result: Option<CreationOrigin> = context
                        .security
                        .origins
                        .into_iter()
                        .find(|origin| origin.id == input.domain);
                    context.transaction.validate().await?;
                    Ok(result)
                }
            },
        )
        .query(
            "zerotrust.creations.capability",
            move |ctx, input: CapabilityInput| {
                let service = Arc::clone(&capabilities);
                async move {
                    let mut context = context(&service, &ctx).await?;
                    let scope = super::super::creation::creation_scope(&input.namespace)?;
                    let inspect_grant = input.subject.is_some() && context.auth.is_admin();
                    let subject = input
                        .subject
                        .as_deref()
                        .unwrap_or(&context.security.subject);
                    let user = subject.strip_prefix("user:").ok_or_else(invalid)?;
                    let user_id = Id::decode(user).map_err(|_| invalid())?;
                    if user_id.0 <= 0 || user_id.encode() != user {
                        return Err(invalid());
                    }
                    if subject != context.security.subject {
                        admin(&context.auth)?;
                    }
                    let permitted = context.security.policy.allows(
                        subject,
                        scope,
                        Facet::MasterData,
                        Action::Create,
                    );
                    let mut result = None;
                    // Administrators can verify a newly stored certificate
                    // before publishing the policy that activates it. Ordinary
                    // members see only their own currently enabled delegation.
                    if permitted || inspect_grant {
                        let record = key(
                            "creation-capabilities",
                            &format!(
                                "{}:{}:{}",
                                context.security.root.generation, subject, input.namespace
                            ),
                        );
                        if let Some(capability) = context
                            .transaction
                            .read::<CreationCapability>(record)
                            .await?
                        {
                            capability.verify(&context.security.authority)?;
                            if capability.tenant != context.auth.tenant
                                || capability.creator.user != subject
                                || capability.generation
                                    != context.security.root.generation.to_string()
                                || capability.namespace != input.namespace
                            {
                                return Err(forbidden());
                            }
                            check_member(
                                &mut context.transaction,
                                &context.security,
                                &capability.creator,
                            )
                            .await?;
                            result = Some(capability);
                        }
                    }
                    context.transaction.validate().await?;
                    Ok(result)
                }
            },
        )
        .mutation(
            "zerotrust.creations.grant",
            move |ctx, input: CreationCapability| {
                let service = Arc::clone(&service);
                async move {
                    let mut context = context(&service, &ctx).await?;
                    admin(&context.auth)?;
                    input.verify(&context.security.authority)?;
                    if input.tenant != context.auth.tenant
                        || input.generation != context.security.root.generation.to_string()
                    {
                        return Err(invalid());
                    }
                    for member in std::iter::once(&input.creator).chain(&input.readers) {
                        check_member(&mut context.transaction, &context.security, member).await?;
                    }
                    context
                        .transaction
                        .put(capability_key(&input), &input)
                        .await?;
                    context.transaction.notify(
                        "access",
                        &serde_json::json!({"policy": context.security.policy.version}),
                    )?;
                    context.transaction.commit().await?;
                    Ok(Success { success: true })
                }
            },
        )
}
