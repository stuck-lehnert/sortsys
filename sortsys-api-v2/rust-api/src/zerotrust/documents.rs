//! Signed public document revision vectors. Payloads stay encrypted in Quack.
mod registrations;
pub(super) use registrations::COLLECTION as REGISTRATIONS;

use super::{
    crypto::{encode, frame, identifier, invalid, revision, sized, verify},
    objects::{conflict, packet_hash},
    wire::{Action, Facet},
};
use crate::{
    error::RpcResult,
    error::{forbidden, internal},
    ids::Id,
    rpc::ProcedureRegistryBuilder,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

pub(super) const CONTENT_FACETS: [&str; 9] = [
    "scope",
    "contract-quantities",
    "measurement",
    "offer-prices",
    "calculation",
    "procurement",
    "billing",
    "attachment",
    "opaque",
];
#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PartKey {
    pub facet: Facet,
    pub generation: String,
}
#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DocumentPart {
    pub facet: String,
    pub object: String,
    pub hash: String,
    pub keys: Vec<PartKey>,
}
#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DocumentHead {
    pub format: String,
    pub tenant: String,
    pub scope: String,
    pub id: String,
    pub version: String,
    pub previous: String,
    pub generation: String,
    pub policy_version: String,
    pub author: String,
    pub modified_micros: String,
    pub read_only: bool,
    pub locked: bool,
    pub parts: Vec<DocumentPart>,
    pub signature: String,
}
pub(super) struct BlobId<'a> {
    pub scope: &'a str,
    pub id: &'a str,
    pub facet: &'a str,
    pub manifest: bool,
}
fn checked_id(value: &str) -> RpcResult<()> {
    let id = Id::decode(value).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != value {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn blob(value: &str) -> RpcResult<Option<BlobId<'_>>> {
    if !value.starts_with("commercial:") {
        return Ok(None);
    }
    let parts: Vec<_> = value.split(':').collect();
    if parts
        .get(3)
        .is_none_or(|value| !["document", "opaque"].contains(value))
    {
        return Ok(None);
    }
    if parts.len() != 7 {
        return Err(invalid());
    }
    checked_id(parts[1])?;
    checked_id(parts[4])?;
    let facet = if parts[3] == "opaque" {
        if parts[2] != "scope" {
            return Err(invalid());
        }
        "opaque"
    } else {
        parts[2]
    };
    if !CONTENT_FACETS.contains(&facet)
        || facet == "opaque" && parts[3] != "opaque"
        || parts[5].len() != 32
        || !parts[5]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    let manifest = parts[6] == "manifest";
    if !manifest
        && (parts[6]
            .parse::<u32>()
            .ok()
            .filter(|n| *n < 1_000_000)
            .map(|n| n.to_string())
            .as_deref()
            != Some(parts[6]))
    {
        return Err(invalid());
    }
    identifier(value)?;
    Ok(Some(BlobId {
        scope: &value[..11 + parts[1].len()],
        id: parts[4],
        facet,
        manifest,
    }))
}
pub(super) fn facet(value: &str) -> RpcResult<Facet> {
    match value {
        "scope" => Ok(Facet::Scope),
        "contract-quantities" => Ok(Facet::ContractQuantities),
        "measurement" => Ok(Facet::Measurement),
        "offer-prices" => Ok(Facet::OfferPrices),
        "calculation" => Ok(Facet::Calculation),
        "procurement" => Ok(Facet::Procurement),
        "billing" => Ok(Facet::Billing),
        "attachment" => Ok(Facet::Attachment),
        _ => Err(invalid()),
    }
}
impl DocumentHead {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.author)?;
        checked_id(self.author.strip_prefix("user:").ok_or_else(invalid)?)?;
        checked_id(self.scope.strip_prefix("commercial:").ok_or_else(invalid)?)?;
        checked_id(&self.id)?;
        revision(&self.version)?;
        revision(&self.generation)?;
        revision(&self.policy_version)?;
        revision(&self.modified_micros)?;
        if self.format != "sortsys-document-head-v1"
            || self.locked && !self.read_only
            || self.parts.is_empty()
            || self.parts.len() > 9
            || !self.parts.iter().any(|part| part.facet == "scope")
        {
            return Err(invalid());
        }
        if !self.previous.is_empty() {
            sized::<32>(&self.previous)?;
        }
        let mut hashes = Vec::new();
        let mut previous = "";
        for part in &self.parts {
            if part.facet.as_str() <= previous {
                return Err(invalid());
            }
            previous = &part.facet;
            sized::<32>(&part.hash)?;
            let object = blob(&part.object)?.ok_or_else(invalid)?;
            if object.scope != self.scope
                || object.id != self.id
                || object.facet != part.facet
                || !object.manifest
            {
                return Err(invalid());
            }
            let mut expected = if part.facet == "opaque" {
                super::creation::COMMERCIAL_FACETS.to_vec()
            } else {
                vec![facet(&part.facet)?]
            };
            expected.sort_by_key(|facet| facet.name());
            if part.keys.len() != expected.len() {
                return Err(invalid());
            }
            let count = part.keys.len().to_string();
            let mut fields = vec![
                part.facet.as_str(),
                part.object.as_str(),
                part.hash.as_str(),
                count.as_str(),
            ];
            for (key, expected) in part.keys.iter().zip(expected) {
                if key.facet != expected {
                    return Err(invalid());
                }
                revision(&key.generation)?;
                fields.extend([key.facet.name(), &key.generation]);
            }
            hashes.push(encode(&Sha256::digest(frame(
                "sortsys/document-part/v1",
                &fields,
            ))));
        }
        let count = hashes.len().to_string();
        let mut fields = vec![
            self.tenant.as_str(),
            self.scope.as_str(),
            self.id.as_str(),
            self.version.as_str(),
            self.previous.as_str(),
            self.generation.as_str(),
            self.policy_version.as_str(),
            self.author.as_str(),
            self.modified_micros.as_str(),
            if self.read_only { "true" } else { "false" },
            if self.locked { "true" } else { "false" },
            count.as_str(),
        ];
        fields.extend(hashes.iter().map(String::as_str));
        Ok(frame("sortsys/document-head/v1", &fields))
    }
    pub fn hash(&self) -> RpcResult<String> {
        packet_hash(self.frame()?, &self.signature)
    }
    pub(super) fn part_target(&self, facet: &str) -> RpcResult<String> {
        self.frame()?;
        if !CONTENT_FACETS.contains(&facet) {
            return Err(invalid());
        }
        let mut fields = vec![
            self.tenant.as_str(),
            self.scope.as_str(),
            self.id.as_str(),
            facet,
        ];
        if let Some(part) = self.parts.iter().find(|part| part.facet == facet) {
            fields.extend(["present", part.object.as_str(), part.hash.as_str()]);
            for key in &part.keys {
                fields.extend([key.facet.name(), key.generation.as_str()]);
            }
        } else {
            fields.push("absent");
        }
        Ok(encode(&Sha256::digest(frame(
            "sortsys/document-part-target/v1",
            &fields,
        ))))
    }
    pub fn domains(&self) -> Vec<String> {
        let mut keys = BTreeSet::from([format!("{}:master-data", self.scope)]);
        for part in &self.parts {
            for key in &part.keys {
                keys.insert(format!("{}:{}", self.scope, key.facet.name()));
            }
        }
        keys.into_iter().collect()
    }
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetInput {
    id: String,
    #[ts(optional)]
    scope: Option<String>,
    #[ts(optional)]
    version: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct HistoryInput {
    scope: String,
    id: String,
    before: String,
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<GetInput, Option<DocumentHead>>("zerotrust.documents.get")
        .query_stub::<HistoryInput, Vec<DocumentHead>>("zerotrust.documents.history")
        .query_stub::<registrations::ListInput, registrations::Page>(
            "zerotrust.documents.registrations",
        )
}

fn metadata_history_key(
    id: &str,
    version: &str,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    Ok(crate::control::key(
        "document-history",
        &format!("{id}:{:020}", revision(version)?),
    ))
}

async fn history_records(
    transaction: &mut crate::control::Transaction,
    current: &DocumentHead,
    keys: Vec<sortsys_zerotrust::metadata::RecordKey>,
) -> RpcResult<Vec<Option<DocumentHead>>> {
    if current.locked {
        let witness = crate::control::key("documents", &current.id);
        return transaction.many_at_retained_epoch(&witness, keys).await;
    }
    transaction.many(keys).await
}

async fn first_publication_missing(
    transaction: &mut crate::control::Transaction,
    locked: &DocumentHead,
) -> RpcResult<bool> {
    let first = metadata_history_key(&locked.id, "1")?;
    let selected: Option<DocumentHead> = transaction.read_in_selected_epoch(first.clone()).await?;
    let retained = history_records(transaction, locked, vec![first])
        .await?
        .pop()
        .flatten()
        .ok_or_else(invalid)?;
    match selected {
        Some(selected) if selected != retained => Err(conflict()),
        Some(_) => Ok(false),
        None => Ok(true),
    }
}

pub(super) async fn check_restore_origin(
    transaction: &mut crate::control::Transaction,
    locked: &DocumentHead,
) -> RpcResult<bool> {
    let missing = first_publication_missing(transaction, locked).await?;
    if missing {
        registrations::require_restore_registration(transaction, locked).await?;
    }
    Ok(missing)
}

pub(crate) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let get = Arc::clone(&service);
    let registry = Arc::clone(&service);
    builder
        .query(
            "zerotrust.documents.registrations",
            move |ctx, input: registrations::ListInput| {
                let service = Arc::clone(&registry);
                async move { registrations::list(&service, &ctx, input).await }
            },
        )
        .query("zerotrust.documents.get", move |ctx, input: GetInput| {
            let service = Arc::clone(&get);
            async move {
                checked_id(&input.id)?;
                let mut request = super::access::MetadataRequest::open(&service, &ctx).await?;
                let current: Option<DocumentHead> = request
                    .transaction
                    .read(crate::control::key("documents", &input.id))
                    .await?;
                let domains = current
                    .as_ref()
                    .map(|head| format!("{}:master-data", head.scope))
                    .into_iter()
                    .collect::<Vec<_>>();
                let mut context = request.authorize(Some(&domains)).await?;
                let Some(current) = current else {
                    context.transaction.validate().await?;
                    return Ok(None);
                };
                if input
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope != &current.scope)
                    || !context.security.allows(
                        &context.security.subject,
                        &current.scope,
                        Facet::MasterData,
                        Action::Read,
                    )
                {
                    return Err(forbidden());
                }
                let result: Option<DocumentHead> = if let Some(version) = input.version {
                    let key = metadata_history_key(&input.id, &version)?;
                    history_records(&mut context.transaction, &current, vec![key])
                        .await?
                        .pop()
                        .flatten()
                } else {
                    Some(current)
                };
                if let Some(head) = &result {
                    head.frame()?;
                    if head.tenant != context.auth.tenant || head.id != input.id {
                        return Err(invalid());
                    }
                }
                context.transaction.validate().await?;
                Ok(result)
            }
        })
        .query(
            "zerotrust.documents.history",
            move |ctx, input: HistoryInput| {
                let service = Arc::clone(&service);
                async move {
                    checked_id(&input.id)?;
                    let before = revision(&input.before)?;
                    let domains = [format!("{}:master-data", input.scope)];
                    let mut context =
                        super::access::metadata_context_for_domains(&service, &ctx, Some(&domains))
                            .await?;
                    let current: DocumentHead = context
                        .transaction
                        .read(crate::control::key("documents", &input.id))
                        .await?
                        .ok_or_else(forbidden)?;
                    if current.scope != input.scope
                        || !context.security.allows(
                            &context.security.subject,
                            &current.scope,
                            Facet::MasterData,
                            Action::Read,
                        )
                    {
                        return Err(forbidden());
                    }
                    let latest = revision(&current.version)?.min(before - 1);
                    let mut keys = Vec::new();
                    for index in 0..32 {
                        if latest - index > 0 {
                            keys.push(metadata_history_key(
                                &input.id,
                                &(latest - index).to_string(),
                            )?);
                        }
                    }
                    let result = history_records(&mut context.transaction, &current, keys)
                        .await?
                        .into_iter()
                        .map(|value| value.ok_or_else(invalid))
                        .collect::<RpcResult<Vec<_>>>()?;
                    context.transaction.validate().await?;
                    Ok(result)
                }
            },
        )
}

pub(super) async fn metadata_commit(
    context: &mut super::access::MetadataContext,
    head: &DocumentHead,
    metadata_changed: bool,
) -> RpcResult<bool> {
    use crate::control::key;
    let guard = &context.security;
    if head.tenant != context.auth.tenant
        || head.author != guard.subject
        || revision(&head.generation)? != guard.root.generation
        || head.policy_version != guard.policy.version
    {
        return Err(conflict());
    }
    verify(&guard.signing_key, &head.signature, &head.frame()?)?;
    if !guard.allows(&guard.subject, &head.scope, Facet::MasterData, Action::Read) {
        return Err(forbidden());
    }
    let previous: Option<DocumentHead> =
        context.transaction.read(key("documents", &head.id)).await?;
    if let Some(old) = &previous {
        if old.scope != head.scope {
            return Err(forbidden());
        }
        if serde_json::to_value(old).map_err(internal)?
            == serde_json::to_value(head).map_err(internal)?
        {
            return Ok(false);
        }
        if old.locked
            || old.read_only && !head.read_only
            || revision(&old.version)?.checked_add(1) != Some(revision(&head.version)?)
            || old.hash()? != head.previous
        {
            return Err(conflict());
        }
    } else if !head.previous.is_empty()
        || head.version != "1"
        || !guard.allows(
            &guard.subject,
            &head.scope,
            Facet::MasterData,
            Action::Update,
        )
    {
        return Err(forbidden());
    }
    if !metadata_changed
        && previous.as_ref().is_some_and(|old| {
            old.parts == head.parts && old.locked == head.locked && old.read_only == head.read_only
        })
    {
        return Err(invalid());
    }
    if (head.locked || head.read_only || previous.as_ref().is_some_and(|old| old.read_only))
        && !guard.allows(
            &guard.subject,
            &head.scope,
            Facet::MasterData,
            Action::Update,
        )
    {
        return Err(forbidden());
    }
    for old in previous.as_ref().into_iter().flat_map(|head| &head.parts) {
        if !head.parts.iter().any(|part| part.facet == old.facet) {
            return Err(invalid());
        }
    }
    for part in &head.parts {
        let old = previous
            .as_ref()
            .and_then(|head| head.parts.iter().find(|old| old.facet == part.facet));
        if old == Some(part) {
            continue;
        }
        for key in &part.keys {
            let action = if part.facet == "opaque" || old.is_some() {
                Action::Update
            } else {
                Action::Create
            };
            if !guard.allows(&guard.subject, &head.scope, key.facet, Action::Read)
                || !guard.allows(&guard.subject, &head.scope, key.facet, action)
            {
                return Err(forbidden());
            }
            let area = super::objects::metadata_current_domain(
                &mut context.transaction,
                guard,
                &format!("{}:{}", head.scope, key.facet.name()),
            )
            .await?;
            if area.scope != head.scope
                || area.facet != key.facet
                || area.generation != key.generation
            {
                return Err(conflict());
            }
        }
        let record = super::objects::metadata_object(&mut context.transaction, &part.object)
            .await?
            .filter(|record| !record.deleted)
            .ok_or_else(invalid)?;
        let owner = if part.facet == "opaque" {
            "scope"
        } else {
            &part.facet
        };
        if record.domain != format!("{}:{owner}", head.scope) {
            return Err(invalid());
        }
        let envelope =
            super::objects::metadata_read(&context.repository, &record.reference).await?;
        if envelope.object != part.object
            || envelope.scope != head.scope
            || envelope.facet.name() != owner
            || !part
                .keys
                .iter()
                .any(|key| key.facet.name() == owner && key.generation == envelope.generation)
            || packet_hash(envelope.frame()?, &envelope.signature)? != part.hash
        {
            return Err(invalid());
        }
    }
    let historical = metadata_history_key(&head.id, &head.version)?;
    if context
        .transaction
        .read::<Value>(historical.clone())
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    let current = key("documents", &head.id);
    context.transaction.put(current.clone(), head).await?;
    context.transaction.put(historical.clone(), head).await?;
    if head.locked {
        registrations::capture(&mut context.transaction, head).await?;
    }
    super::timestamps::metadata_record_document(
        &mut context.transaction,
        head,
        &[current, historical],
    )
    .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_receipt_targets_match_browser_vectors() {
        let document: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-document.json"))
                .unwrap();
        let channel: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-live-channels.json"
        ))
        .unwrap();
        let head: DocumentHead = serde_json::from_value(document["head"].clone()).unwrap();
        for facet in ["scope", "billing", "opaque"] {
            assert_eq!(head.part_target(facet).unwrap(), channel["targets"][facet]);
        }
        let mut metadata = head.clone();
        metadata.version = "8".into();
        metadata.read_only = true;
        metadata.locked = true;
        assert_eq!(
            head.part_target("scope").unwrap(),
            metadata.part_target("scope").unwrap()
        );
        metadata.parts[0].keys[0].generation = "5".into();
        assert_ne!(
            head.part_target("scope").unwrap(),
            metadata.part_target("scope").unwrap()
        );
    }

    #[test]
    fn browser_document_vector_has_identical_native_frame_and_hash() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-document.json"))
                .unwrap();
        let head: DocumentHead = serde_json::from_value(fixture["head"].clone()).unwrap();
        let key = sized::<32>(fixture["publicKey"].as_str().unwrap()).unwrap();
        assert_eq!(encode(&head.frame().unwrap()), fixture["frame"]);
        assert_eq!(head.hash().unwrap(), fixture["hash"]);
        let transported = crate::superjson::encode(serde_json::to_value(&head).unwrap());
        assert!(
            transported.get("meta").is_none(),
            "Signed headers must survive RPC transport without Date conversion"
        );
        verify(&key, &head.signature, &head.frame().unwrap()).unwrap();
        for field in ["version", "modifiedMicros", "policyVersion"] {
            let mut value = fixture["head"].clone();
            value[field] = if field == "modifiedMicros" {
                "1794309134123456"
            } else {
                "8"
            }
            .into();
            let changed: DocumentHead = serde_json::from_value(value).unwrap();
            assert!(verify(&key, &changed.signature, &changed.frame().unwrap()).is_err());
        }
        let mut received = head.clone();
        received.read_only = true;
        assert!(verify(&key, &received.signature, &received.frame().unwrap()).is_err());
        let mut invalid_lock = head.clone();
        invalid_lock.locked = true;
        assert!(invalid_lock.frame().is_err());
        let mut bad = head.clone();
        bad.parts[0].object = bad.parts[0]
            .object
            .replace("commercial:123:", "commercial:124:");
        assert!(bad.frame().is_err());
        bad = head.clone();
        bad.parts[0].facet = "opaque".into();
        assert!(bad.frame().is_err());
        bad = head;
        bad.parts[0].keys[0].facet = Facet::OfferPrices;
        assert!(bad.frame().is_err());
    }
}
