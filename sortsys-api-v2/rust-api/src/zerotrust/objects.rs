pub(super) mod persistence;
pub(super) use persistence::{
    ChangeRecord, ObjectRecord, check_read as metadata_check_read,
    journal_id as metadata_journal_id, object as metadata_object,
    raw_object as metadata_raw_object, read as metadata_read, record_key as metadata_record_key,
};
pub(super) use registry::{
    DomainDescriptor, DomainRecord, catalog as metadata_catalog, has_key as metadata_has_key,
    install_identity as metadata_install_identity, replace_policy as metadata_replace_policy,
};
mod access_inventory;
mod creation_renewals;
mod domain_access;
pub(super) use access_inventory::check_snapshot as metadata_check_inventory_snapshot;
pub(super) mod registry;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use ts_rs::TS;

use super::{
    access::Security,
    crypto::{frame, identifier, invalid, revision, sized, verify},
    wire::{
        Action, AuthorityCertificate, EncryptedObject, Facet, IdentityCertificate, SealedBox,
        SignedPolicy,
    },
};
use crate::{
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    error::{forbidden, internal, not_found},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub(super) fn conflict() -> RpcError {
    RpcError::new(
        ErrorCode::Conflict,
        "Protected data changed; reload the current version",
    )
    .with_http_code(409)
}
pub(super) use super::crypto::packet_hash;
pub(super) type KeyAuthority = sortsys_zerotrust::key_authorities::KeyAuthority<Facet>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CipherReference {
    pub format: String,
    pub id: String,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DomainDefinition {
    pub tenant: String,
    pub id: String,
    pub scope: String,
    pub facet: Facet,
    pub generation: String,
    pub policy_version: String,
    pub envelopes: Vec<SealedBox>,
    pub recovery_envelope: SealedBox,
    pub proof: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub creation: Option<super::creation::CreationOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_authority: Option<KeyAuthority>,
}
impl DomainDefinition {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        if self.creation.is_some() && self.key_authority.is_some() {
            return Err(invalid());
        }
        for id in [&self.tenant, &self.id, &self.scope] {
            identifier(id)?;
        }
        revision(&self.generation)?;
        revision(&self.policy_version)?;
        if self.envelopes.len() > 10000 {
            return Err(invalid());
        }
        let mut recipients = std::collections::HashSet::new();
        let mut hashes = Vec::new();
        for box_ in self
            .envelopes
            .iter()
            .chain(std::iter::once(&self.recovery_envelope))
        {
            if !recipients.insert(&box_.recipient) {
                return Err(invalid());
            }
            hashes.push(packet_hash(box_.frame()?, &box_.signature)?);
        }
        use sortsys_zerotrust::domains::{DomainCreationRef, DomainFrameRef, DomainSignerRef};
        let creation_frame = self
            .creation
            .as_ref()
            .map(|origin| origin.frame())
            .transpose()?;
        let signer = if let Some(origin) = &self.creation {
            DomainSignerRef::Creator(DomainCreationRef {
                tenant: &origin.tenant,
                id: &origin.id,
                scope: &origin.scope,
                facet: origin.facet.name(),
                frame: creation_frame.as_deref().ok_or_else(invalid)?,
                signature: &origin.signature,
            })
        } else if let Some(authority) = &self.key_authority {
            DomainSignerRef::Manager(authority.as_protocol())
        } else {
            DomainSignerRef::Authority
        };
        Ok(DomainFrameRef {
            tenant: &self.tenant,
            id: &self.id,
            scope: &self.scope,
            facet: self.facet.name(),
            generation: &self.generation,
            policy_version: &self.policy_version,
            envelope_hashes: &hashes,
            signer,
        }
        .frame()?)
    }
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdInput {
    id: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyInput {
    domain: String,
    generation: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyHistoryInput {
    domain: String,
    generations: Vec<String>,
}
#[derive(Serialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyHistoryEntry {
    generation: String,
    definition: DomainDefinition,
    envelope: Option<SealedBox>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdentityInput {
    subject: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyGrant {
    domain: String,
    generation: String,
    envelope: SealedBox,
    #[serde(default)]
    #[ts(optional)]
    key_authority: Option<KeyAuthority>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyAuthorityInput {
    signature: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyAuthoritiesInput {
    authorities: Vec<KeyAuthority>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyAuthorityAreaInput {
    scope: String,
    facet: Facet,
    #[serde(default)]
    #[ts(optional)]
    holder: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyAuthorityAreasInput {
    areas: Vec<KeyAuthorityAreaInput>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct RecipientPageInput {
    scope: String,
    facet: Facet,
    after: Option<Id>,
}
#[derive(Serialize, TS)]
struct PermissionRecipients {
    rows: Vec<Id>,
    after: Option<Id>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessPublicationInput {
    policy_version: String,
    grants: Vec<KeyGrant>,
    domains: Vec<DomainDefinition>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyRecipientInput {
    domain: String,
    generation: String,
    recipient: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct KeyInspectionInput {
    keys: Vec<KeyRecipientInput>,
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SaveInput {
    pub domain: String,
    pub message_id: String,
    pub envelope: EncryptedObject,
    #[ts(optional)]
    pub references: Option<super::stock::StockReferences>,
    #[ts(optional)]
    pub migration_origin: Option<super::history::MigrationOrigin>,
    #[ts(optional)]
    pub resource_access: Option<sortsys_zerotrust::resource_access::ResourceAccessState>,
    #[ts(optional)]
    pub recipient_key: Option<super::object_shares::RecipientKey>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct BatchInput {
    pub objects: Vec<SaveInput>,
    #[ts(optional)]
    pub heads: Option<Vec<DomainHead>>,
    #[ts(optional)]
    pub documents: Option<Vec<super::documents::DocumentHead>>,
    #[ts(optional)]
    #[serde(rename = "liveCheckpoints")]
    pub live_checkpoints: Option<Vec<super::live_checkpoints::LiveCheckpoint>>,
    #[ts(optional)]
    pub member: Option<super::members::MemberChange>,
    #[ts(optional)]
    pub policy: Option<SignedPolicy>,
}
#[derive(Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct DomainHead {
    pub domain: String,
    pub sequence: String,
}
#[derive(Serialize, TS)]
pub(super) struct BatchResult {
    success: bool,
    heads: Vec<DomainHead>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    domain: String,
    prefix: String,
    after: Option<String>,
    snapshot: Option<String>,
    #[ts(optional)]
    known: Option<String>,
    #[ts(optional)]
    include_openings: Option<bool>,
    #[ts(optional)]
    head_only: Option<bool>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ListBatchInput {
    selections: Vec<ListInput>,
}
#[derive(Serialize, TS)]
struct DomainOpening {
    generation: String,
    definition: DomainDefinition,
    envelope: SealedBox,
    #[serde(skip_serializing_if = "Option::is_none", rename = "keyAuthority")]
    #[ts(optional)]
    key_authority: Option<KeyAuthority>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ObjectPage {
    snapshot: String,
    key_generation: String,
    objects: Vec<EncryptedObject>,
    after: Option<String>,
    recipient_access: Vec<super::object_shares::RecipientAccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    openings: Option<Vec<DomainOpening>>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct DomainInfo {
    id: String,
    scope: String,
    facet: String,
    generation: String,
    rotation_required: bool,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DomainDefinitionsInput {
    domains: Vec<DomainDefinition>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessInput {
    #[serde(default)]
    #[ts(optional)]
    known: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    domain: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    domains: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional)]
    include_domains: Option<bool>,
}

impl AccessInput {
    fn selected_domains(&self) -> RpcResult<Option<&[String]>> {
        if self.domain.is_some() && self.domains.is_some() {
            return Err(invalid());
        }
        let selected = if let Some(domain) = &self.domain {
            Some(std::slice::from_ref(domain))
        } else {
            self.domains.as_deref()
        };
        if let Some(domains) = selected {
            if domains.is_empty() || domains.len() > 16 {
                return Err(invalid());
            }
            let mut unique = std::collections::HashSet::new();
            for domain in domains {
                identifier(domain)?;
                if !unique.insert(domain) {
                    return Err(invalid());
                }
            }
        }
        Ok(selected)
    }
}

#[cfg(test)]
mod access_selection_tests {
    use super::AccessInput;
    use serde_json::json;

    #[test]
    fn access_selections_are_unambiguous_unique_and_bounded() {
        for input in [
            json!({"domains": []}),
            json!({"domain": "catalog:products:master-data", "domains": ["catalog:products:master-data"]}),
            json!({"domains": ["catalog:products:master-data", "catalog:products:master-data"]}),
            json!({"domains": ["invalid domain"]}),
            json!({"domains": (0..17).map(|index| format!("testing:{index}:master-data")).collect::<Vec<_>>()}),
        ] {
            let selection: AccessInput = serde_json::from_value(input).unwrap();
            assert!(selection.selected_domains().is_err());
        }
        let all: AccessInput = serde_json::from_value(json!({})).unwrap();
        assert!(all.selected_domains().unwrap().is_none());
        let domains = (0..16)
            .map(|index| format!("testing:{index}:master-data"))
            .collect::<Vec<_>>();
        let selected: AccessInput = serde_json::from_value(json!({"domains": domains})).unwrap();
        assert_eq!(selected.selected_domains().unwrap().unwrap(), domains);
        let single: AccessInput = serde_json::from_value(json!({"domain": domains[0]})).unwrap();
        assert_eq!(single.selected_domains().unwrap().unwrap(), &domains[..1]);
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AccessSnapshot {
    subject: String,
    username: String,
    history: TrustHistory,
    policy: SignedPolicy,
    origins: Vec<super::creation::CreationOrigin>,
    domains: Vec<DomainInfo>,
    snapshot: String,
    after: Option<String>,
    unchanged: bool,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessPageInput {
    snapshot: String,
    after: String,
    include_domains: bool,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AccessInventoryPage {
    snapshot: String,
    origins: Vec<super::creation::CreationOrigin>,
    domains: Vec<DomainInfo>,
    after: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct IdentityInfo {
    subject: String,
    encryption_key: String,
    signing_key: String,
    certificate: Value,
}

#[derive(Deserialize, Serialize, TS)]
pub(super) struct AuthorityHistory {
    pub(super) certificate: AuthorityCertificate,
    pub(super) transition: Option<Value>,
}
#[derive(Serialize, TS)]
pub(super) struct TrustHistory {
    pub(super) authorities: Vec<AuthorityHistory>,
    pub(super) identities: Vec<IdentityCertificate>,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct PolicyVersionInput {
    version: String,
}
#[derive(Serialize, TS)]
struct HistoricalPolicy {
    generation: String,
    policy: SignedPolicy,
}

pub(crate) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let builder = registry::register(builder, Arc::clone(&service));
    persistence::register(builder, service)
}
pub(super) fn register_creation(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    registry::register_creation(builder, service)
}

pub(super) async fn metadata_current_domain(
    transaction: &mut crate::control::Transaction,
    guard: &Security,
    id: &str,
) -> RpcResult<registry::DomainRecord> {
    let area = registry::domain(transaction, id).await?;
    if registry::RotationChecks::new(guard)
        .required(transaction, guard, &area)
        .await?
    {
        return Err(conflict());
    }
    Ok(area)
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<KeyAuthorityInput, KeyAuthority>("zerotrust.keyAuthorities.get")
        .query_stub::<KeyAuthorityAreaInput, Option<KeyAuthority>>(
            "zerotrust.keyAuthorities.forArea",
        )
        .query_stub::<KeyAuthorityAreasInput, Vec<Option<KeyAuthority>>>(
            "zerotrust.keyAuthorities.forAreas",
        )
        .query_stub::<RecipientPageInput, PermissionRecipients>("zerotrust.identities.recipients")
        .mutation_stub::<KeyAuthoritiesInput, Success>("zerotrust.keyAuthorities.register")
        .query_stub::<AccessInput, AccessSnapshot>("zerotrust.access.snapshot")
        .query_stub::<AccessPageInput, AccessInventoryPage>("zerotrust.access.page")
        .query_stub::<(), SignedPolicy>("zerotrust.policy.get")
        .query_stub::<PolicyVersionInput, HistoricalPolicy>("zerotrust.policy.getVersion")
        .mutation_stub::<SignedPolicy, Success>("zerotrust.policy.replace")
        .query_stub::<(), Vec<DomainInfo>>("zerotrust.domains.list")
        .mutation_stub::<DomainDefinition, Success>("zerotrust.domains.put")
        .mutation_stub::<DomainDefinitionsInput, Success>("zerotrust.domains.putMany")
        .mutation_stub::<AccessPublicationInput, Success>("zerotrust.access.publish")
        .query_stub::<KeyInput, SealedBox>("zerotrust.keys.get")
        .query_stub::<KeyHistoryInput, Vec<KeyHistoryEntry>>("zerotrust.keys.history")
        .query_stub::<KeyInspectionInput, Vec<SealedBox>>("zerotrust.keys.inspect")
        .mutation_stub::<KeyGrant, Success>("zerotrust.keys.grant")
        .query_stub::<KeyInput, DomainDefinition>("zerotrust.domains.get")
        .mutation_stub::<SaveInput, Success>("zerotrust.objects.save")
        .mutation_stub::<BatchInput, BatchResult>("zerotrust.objects.batch")
        .query_stub::<ListInput, ObjectPage>("zerotrust.objects.list")
        .query_stub::<ListBatchInput, Vec<ObjectPage>>("zerotrust.objects.pages")
        .query_stub::<IdInput, EncryptedObject>("zerotrust.objects.get")
        .query_stub::<(), Vec<IdentityInfo>>("zerotrust.identities.list")
        .query_stub::<IdentityInput, Option<IdentityCertificate>>("zerotrust.identities.get")
        .mutation_stub::<IdentityCertificate, Success>("zerotrust.identities.certify")
}

/// Precompute effective readers once per policy, preserving deny precedence.
/// Policy changes must not repeatedly scan every rule for every member/domain.
type ReaderSets = std::collections::HashMap<(String, String), std::collections::HashSet<String>>;
fn policy_readers<'a>(rules: impl Iterator<Item = &'a super::wire::Rule>) -> ReaderSets {
    let mut allowed = std::collections::HashMap::<_, std::collections::HashSet<String>>::new();
    let mut denied = std::collections::HashMap::<_, std::collections::HashSet<String>>::new();
    for rule in rules {
        if !rule.actions.contains(&Action::Read) {
            continue;
        }
        let target = if rule.effect == super::wire::Effect::Deny {
            &mut denied
        } else {
            &mut allowed
        };
        target
            .entry((rule.scope.clone(), rule.facet.name().to_owned()))
            .or_default()
            .insert(rule.subject.clone());
    }
    for (scope, subjects) in denied {
        if let Some(readers) = allowed.get_mut(&scope) {
            readers.retain(|subject| !subjects.contains(subject));
        }
    }
    allowed
}

pub(super) fn policy_batch_binding(
    policy: &SignedPolicy,
    subject: &str,
    previous: &str,
    objects: &[SaveInput],
    heads: &[DomainHead],
) -> RpcResult<()> {
    let binding = policy.transaction.as_ref().ok_or_else(invalid)?;
    binding.frame()?;
    if binding.author != subject || binding.previous_signature != previous {
        return Err(conflict());
    }
    let mut packets = objects
        .iter()
        .map(|object| object.envelope.signature.as_str())
        .collect::<Vec<_>>();
    packets.sort();
    let mut snapshots = heads
        .iter()
        .map(|head| (head.domain.as_str(), head.sequence.as_str()))
        .collect::<Vec<_>>();
    snapshots.sort();
    if !binding.binds_packets(&packets)?
        || binding
            .heads
            .iter()
            .map(|head| (head.domain.as_str(), head.sequence.as_str()))
            .collect::<Vec<_>>()
            != snapshots
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod policy_transaction_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn prepared_publications_allow_more_read_prerequisites_without_unbounding_ordinary_batches() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-policy-transactions.json"
        ))
        .unwrap();
        let mut heads = fixture["heads"].as_array().unwrap().clone();
        heads.extend((0..128).map(|index| {
            json!({
                "domain": format!("testing:prerequisite{index}:master-data"), "sequence": "0"
            })
        }));
        let input: BatchInput = serde_json::from_value(json!({
            "objects": fixture["objects"], "heads": heads
        }))
        .unwrap();
        assert!(validate_batch(&input, false).is_err());
        assert!(validate_batch(&input, true).is_ok());
        let mut oversized = input;
        oversized
            .heads
            .as_mut()
            .unwrap()
            .extend((128..20_001).map(|index| DomainHead {
                domain: format!("testing:prerequisite{index}:master-data"),
                sequence: "0".to_owned(),
            }));
        assert!(validate_batch(&oversized, true).is_err());
    }

    #[test]
    fn browser_policy_transactions_bind_origins_writes_read_heads_and_previous_policy() {
        let value: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-policy-transactions.json"
        ))
        .unwrap();
        let key = sized::<32>(value["signer"].as_str().unwrap()).unwrap();
        let previous: SignedPolicy = serde_json::from_value(value["previous"].clone()).unwrap();
        previous.verify(&key).unwrap();
        let objects: Vec<SaveInput> = serde_json::from_value(value["objects"].clone()).unwrap();
        let heads: Vec<DomainHead> = serde_json::from_value(value["heads"].clone()).unwrap();
        for candidate in value["policies"].as_array().unwrap() {
            let policy: SignedPolicy = serde_json::from_value(candidate.clone()).unwrap();
            policy.verify(&key).unwrap();
            policy_batch_binding(&policy, "user:1", &previous.signature, &objects, &heads).unwrap();
            assert!(
                policy_batch_binding(&policy, "user:2", &previous.signature, &objects, &heads)
                    .is_err()
            );
            assert!(
                policy_batch_binding(&policy, "user:1", &policy.signature, &objects, &heads)
                    .is_err()
            );
            assert!(
                policy_batch_binding(&policy, "user:1", &previous.signature, &[], &heads).is_err()
            );
            assert!(
                policy_batch_binding(&policy, "user:1", &previous.signature, &objects, &[])
                    .is_err()
            );
            let mut changed = policy.clone();
            changed.transaction = None;
            assert!(changed.verify(&key).is_err());
            let mut changed = policy.clone();
            changed.rules[0].origin = None;
            assert!(changed.verify(&key).is_err());
            let mut changed = policy.clone();
            changed.transaction.as_mut().unwrap().heads[0].sequence = "9".into();
            assert!(changed.verify(&key).is_err());
            let mut changed = policy.clone();
            let duplicate = changed.transaction.as_ref().unwrap().heads[0].clone();
            changed.transaction.as_mut().unwrap().heads.push(duplicate);
            assert!(changed.frame().is_err());
        }
    }
}

fn check_box(
    box_: &SealedBox,
    tenant: &str,
    id: &str,
    generation: &str,
    author: &str,
) -> RpcResult<()> {
    if box_.tenant != tenant
        || box_.purpose != "area-key"
        || box_.object != id
        || box_.generation != generation
        || box_.author != author
    {
        return Err(invalid());
    }
    Ok(())
}

// Domain locks order commits across API replicas. A page token is invalidated
// by every committed write in its domain, including a write to another prefix.

struct BatchShape<'a> {
    domains: std::collections::BTreeSet<String>,
    opaque_scopes: std::collections::BTreeSet<&'a str>,
}
fn validate_batch(input: &BatchInput, allow_large: bool) -> RpcResult<BatchShape<'_>> {
    let file_metadata = input.objects.iter().all(|object| {
        object.envelope.facet == Facet::Attachment
            && object.envelope.object.starts_with("project-files:")
    });
    let document_heads = input.documents.as_deref().unwrap_or_default();
    if (input.objects.is_empty()
        && document_heads.is_empty()
        && input.policy.is_none()
        && input.live_checkpoints.as_ref().is_none_or(Vec::is_empty))
        || document_heads.len() > 16
        || input.objects.len()
            > if allow_large {
                40_001
            } else if file_metadata {
                200
            } else {
                64
            }
    {
        return Err(invalid());
    }
    let mut domains = std::collections::BTreeSet::new();
    let mut ids = std::collections::BTreeSet::new();
    let mut messages = std::collections::HashSet::new();
    let mut bytes = 0usize;
    let mut opaque_scopes = std::collections::BTreeSet::new();
    for object in &input.objects {
        tool_object_binding(object)?;
        tombstone_binding(object)?;
        if let Some(area) = super::absences::binding(&object.envelope)?
            && (object.references.is_some()
                || object.domain != format!("{}:{}", area.scope, object.envelope.facet.name())
                || area.domains().iter().any(|domain| {
                    !input
                        .heads
                        .as_ref()
                        .is_some_and(|heads| heads.iter().any(|head| head.domain == *domain))
                }))
        {
            return Err(invalid());
        }
        if let Some(scope) = opaque_scope(object)? {
            opaque_scopes.insert(scope);
        }
        identifier(&object.domain)?;
        identifier(&object.message_id)?;
        identifier(&object.envelope.object)?;
        if !ids.insert(&object.envelope.object) || !messages.insert(&object.message_id) {
            return Err(invalid());
        }
        domains.insert(object.domain.clone());
        bytes += object.envelope.ciphertext.len();
    }
    if bytes
        > if allow_large {
            256 * 1024 * 1024
        } else {
            24 * 1024 * 1024
        }
    {
        return Err(invalid());
    }
    if !allow_large && input.objects.len() > 64 && domains.len() != 1 {
        return Err(invalid());
    }
    if input.heads.is_none()
        && input.objects.iter().any(|obj| {
            obj.envelope.is_tombstone()
                || obj.envelope.object.starts_with("product:")
                || obj.envelope.object.starts_with("vendor:")
                || obj.envelope.object.starts_with("product-price:")
                || obj.envelope.object.starts_with("customer:")
                || obj.envelope.object.starts_with("contact:")
                || obj.envelope.object.starts_with("project:")
                || obj.envelope.object.starts_with("project-files:")
                || obj.envelope.object.starts_with("project-folder:")
                || obj.envelope.object.starts_with("delivery-note:")
                || obj.envelope.object.starts_with("delivery-price:")
                || obj.envelope.object.starts_with("delivery-create:")
                || obj.envelope.object.starts_with("tool:")
                || obj.envelope.object.starts_with("tool-tracking:")
                || obj.envelope.object == "tool-index"
        })
    {
        return Err(invalid());
    }
    if let Some(heads) = &input.heads {
        let mut seen = std::collections::HashSet::new();
        let maximum_heads = if allow_large || input.policy.is_some() {
            20_001
        } else {
            128
        };
        if heads.len() < domains.len() || heads.len() > maximum_heads {
            return Err(invalid());
        }
        for head in heads {
            identifier(&head.domain)?;
            if !seen.insert(&head.domain) {
                return Err(invalid());
            }
            if head.sequence != "0" {
                revision(&head.sequence)?;
            }
        }
        if domains.iter().any(|domain| !seen.contains(domain)) {
            return Err(invalid());
        }
    }
    for scope in &opaque_scopes {
        for facet in super::creation::COMMERCIAL_FACETS {
            let id = format!("{scope}:{}", facet.name());
            if !input
                .heads
                .as_ref()
                .is_some_and(|heads| heads.iter().any(|head| head.domain == id))
            {
                return Err(invalid());
            }
        }
    }
    Ok(BatchShape {
        domains,
        opaque_scopes,
    })
}

/// Resource names bind public tool metadata to exactly one key area. Content
/// and business relationships remain encrypted and are checked by the client.
fn tool_object_binding(input: &SaveInput) -> RpcResult<()> {
    let object = &input.envelope.object;
    if object == "tool-index" {
        if input.domain != "catalog:tools:master-data"
            || input.envelope.scope != "catalog:tools"
            || input.envelope.facet != Facet::MasterData
        {
            return Err(invalid());
        }
    } else if object.starts_with("tool:") || object.starts_with("tool-tracking:") {
        let (namespace, tail) = object.split_once(':').ok_or_else(invalid)?;
        let (token, _) = tail.split_once(':').ok_or_else(invalid)?;
        let id = Id::decode(token).map_err(|_| invalid())?;
        let facet = input.envelope.facet;
        let allowed = match namespace {
            "tool" => matches!(
                facet,
                Facet::MasterData | Facet::Procurement | Facet::Measurement
            ),
            "tool-tracking" => {
                matches!(facet, Facet::MasterData | Facet::Procurement | Facet::Scope)
            }
            _ => false,
        };
        let scope = format!("{namespace}:{token}");
        if !allowed
            || id.0 <= 0
            || id.encode() != token
            || input.envelope.scope != scope
            || input.domain != format!("{scope}:{}", facet.name())
            || *object != format!("{}:record", input.domain)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Opaque GAEB extensions require all nine keys and all nine update rights,
/// although their outer envelope lives in the scope domain.
fn opaque_scope(input: &SaveInput) -> RpcResult<Option<&str>> {
    let object = &input.envelope.object;
    if !object.starts_with("commercial:") {
        return Ok(None);
    }
    let Some((scope, suffix)) = object.split_once(":scope:opaque:") else {
        return Ok(None);
    };
    let token = scope.strip_prefix("commercial:").ok_or_else(invalid)?;
    let id = Id::decode(token).map_err(|_| invalid())?;
    if id.0 <= 0
        || id.encode() != token
        || suffix.is_empty()
        || input.envelope.scope != scope
        || input.envelope.facet != Facet::Scope
        || input.domain != format!("{scope}:scope")
    {
        return Err(invalid());
    }
    Ok(Some(scope))
}

/// Private import receipts are immutable and namespaced by their actual
/// author. Another price editor cannot overwrite a caller's retry evidence.
fn import_receipt(input: &SaveInput, subject: &str) -> RpcResult<bool> {
    let Some(tail) = input.envelope.object.strip_prefix("price-import:") else {
        return Ok(false);
    };
    let (user, request) = tail.split_once(':').ok_or_else(invalid)?;
    let decoded = Id::decode(user).map_err(|_| invalid())?;
    if decoded.0 <= 0
        || decoded.encode() != user
        || request.len() < 16
        || request.len() > 80
        || !request
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(invalid());
    }
    if subject != format!("user:{user}") {
        return Err(forbidden());
    }
    if input.domain != "catalog:products:procurement"
        || input.envelope.scope != "catalog:products"
        || input.envelope.facet != Facet::Procurement
        || input.envelope.revision != "1"
    {
        return Err(invalid());
    }
    Ok(true)
}

/// Stock deletions have additional referential checks. Immutable receipts and
/// document blobs must likewise retain their original publication protocol.
fn tombstone_binding(input: &SaveInput) -> RpcResult<()> {
    if !input.envelope.is_tombstone() {
        return Ok(());
    }
    let id = &input.envelope.object;
    if input.references.is_some()
        || super::stock::kind(id)?.is_some()
        || super::documents::blob(id)?.is_some()
        || [
            "price-import:",
            "delivery-price:",
            "delivery-create:",
            "file-data:",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix))
    {
        return Err(invalid());
    }
    Ok(())
}
fn write_action(envelope: &EncryptedObject, exists: bool) -> RpcResult<Action> {
    if let Some(action) = super::immutable::write_action(envelope)? {
        return Ok(action);
    }
    if envelope.object.starts_with("legacy-activity:") {
        if envelope.is_tombstone() || envelope.revision != "1" {
            return Err(invalid());
        }
        return Ok(Action::Create);
    }
    if let Some(action) = super::absences::write_action(envelope)? {
        if envelope.is_tombstone() && !exists {
            return Err(conflict());
        }
        return Ok(action);
    }
    if envelope.is_tombstone() {
        if !exists {
            return Err(conflict());
        }
        Ok(Action::Delete)
    } else {
        Ok(if exists {
            Action::Update
        } else {
            Action::Create
        })
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;
    #[test]
    fn logical_deletions_need_delete_not_update_and_cannot_bypass_reference_protocols() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-tombstones.json"
        ))
        .unwrap();
        let deleted: EncryptedObject = serde_json::from_value(source["deleted"].clone()).unwrap();
        assert!(matches!(
            write_action(&deleted, true).unwrap(),
            Action::Delete
        ));
        assert!(write_action(&deleted, false).is_err());
        let initial = serde_json::from_value(source["initial"].clone()).unwrap();
        assert!(matches!(
            write_action(&initial, true).unwrap(),
            Action::Update
        ));
        let policy: SignedPolicy = serde_json::from_value(serde_json::json!({"tenant":"test","version":"1","signature":"unused","rules":[
            {"subject":"user:1","scope":deleted.scope,"facet":"master-data","actions":["read","delete"],"effect":"allow"}
        ]})).unwrap();
        assert!(policy.allows(
            "user:1",
            &deleted.scope,
            deleted.facet,
            write_action(&deleted, true).unwrap()
        ));
        assert!(!policy.allows(
            "user:1",
            &deleted.scope,
            deleted.facet,
            write_action(&initial, true).unwrap()
        ));
        let input = SaveInput {
            domain: format!("{}:master-data", deleted.scope),
            message_id: "test".into(),
            envelope: deleted,
            references: None,
            migration_origin: None,
            resource_access: None,
            recipient_key: None,
        };
        tombstone_binding(&input).unwrap();
        let mut delivery = input.clone();
        delivery.envelope.object = "delivery-note:2:3".into();
        tombstone_binding(&delivery).unwrap();
        assert_eq!(
            crate::zerotrust::delivery::deletion_price_domain(&delivery).unwrap(),
            Some("project:2:delivery-notes:procurement".into())
        );
        for id in [
            "product:2",
            "vendor:2",
            "product-price:2",
            "price-import:1:request",
            "delivery-price:2:3",
            "delivery-create:1:request",
            "file-data:2:3:part",
        ] {
            let mut changed = input.clone();
            changed.envelope.object = id.into();
            assert!(tombstone_binding(&changed).is_err(), "{id}");
        }
    }
    #[test]
    fn tool_object_names_bind_the_scope_facet_record_and_number_index() {
        let value: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-recovery.json"))
                .unwrap();
        let mut envelope: EncryptedObject =
            serde_json::from_value(value["initialObject"].clone()).unwrap();
        envelope.object = "tool:abc:master-data:record".into();
        envelope.scope = "tool:abc".into();
        envelope.facet = Facet::MasterData;
        let mut input = SaveInput {
            domain: "tool:abc:master-data".into(),
            message_id: "test".into(),
            envelope,
            references: None,
            migration_origin: None,
            resource_access: None,
            recipient_key: None,
        };
        tool_object_binding(&input).unwrap();
        for object in [
            "tool:def:master-data:record",
            "tool:0abc:master-data:record",
            "tool:abc:procurement:record",
            "tool:abc:master-data:other",
            "tool-tracking:abc:master-data:record",
        ] {
            let mut changed = input.clone();
            changed.envelope.object = object.into();
            assert!(tool_object_binding(&changed).is_err());
        }
        input.envelope.object = "tool-index".into();
        assert!(tool_object_binding(&input).is_err());
        input.domain = "catalog:tools:master-data".into();
        input.envelope.scope = "catalog:tools".into();
        tool_object_binding(&input).unwrap();
        input.envelope.facet = Facet::Procurement;
        assert!(tool_object_binding(&input).is_err());
    }
    #[test]
    fn import_receipts_bind_the_author_area_and_immutable_first_version() {
        let value: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-recovery.json"))
                .unwrap();
        let mut envelope: EncryptedObject =
            serde_json::from_value(value["initialObject"].clone()).unwrap();
        envelope.object = "price-import:1:import-request-20261111".into();
        envelope.scope = "catalog:products".into();
        envelope.facet = Facet::Procurement;
        envelope.revision = "1".into();
        let mut input = SaveInput {
            domain: "catalog:products:procurement".into(),
            message_id: "test".into(),
            envelope,
            references: None,
            migration_origin: None,
            resource_access: None,
            recipient_key: None,
        };
        assert!(import_receipt(&input, "user:1").unwrap());
        assert!(import_receipt(&input, "user:2").is_err());
        input.envelope.revision = "2".into();
        assert!(import_receipt(&input, "user:1").is_err());
        input.envelope.revision = "1".into();
        input.domain = "other:procurement".into();
        assert!(import_receipt(&input, "user:1").is_err());
        input.domain = "catalog:products:procurement".into();
        input.envelope.object = "price-import:01:import-request-20261111".into();
        assert!(import_receipt(&input, "user:1").is_err());
    }
    #[test]
    fn reader_inventory_preserves_denials_and_separates_scopes_facets_and_write_only_grants() {
        let policy: SignedPolicy = serde_json::from_value(serde_json::json!({"tenant":"test","version":"1","signature":"unused","rules":[
            {"subject":"user:1","scope":"catalog:a","facet":"master-data","actions":["read"],"effect":"allow"},
            {"subject":"user:1","scope":"catalog:a","facet":"master-data","actions":["read"],"effect":"deny"},
            {"subject":"user:1","scope":"catalog:a","facet":"procurement","actions":["read"],"effect":"allow"},
            {"subject":"user:1","scope":"catalog:b","facet":"master-data","actions":["read"],"effect":"allow"},
            {"subject":"user:2","scope":"catalog:a","facet":"master-data","actions":["update"],"effect":"allow"},
            {"subject":"user:3","scope":"catalog:a","facet":"master-data","actions":["read","update"],"effect":"allow"}
        ]})).unwrap();
        let readers = policy_readers(policy.rules.iter());
        for rule in &policy.rules {
            for subject in ["user:1", "user:2", "user:3"] {
                assert_eq!(
                    readers
                        .get(&(rule.scope.clone(), rule.facet.name().to_owned()))
                        .is_some_and(|set| set.contains(subject)),
                    policy.allows(subject, &rule.scope, rule.facet, Action::Read)
                );
            }
        }
    }
}
