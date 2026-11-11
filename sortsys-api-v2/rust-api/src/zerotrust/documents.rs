//! Signed public document revision vectors. Payloads stay encrypted in Quack.
use super::{
    access::{Security, security},
    crypto::{encode, frame, identifier, invalid, revision, sized, verify},
    objects::{conflict, packet_hash, read_envelope},
    wire::{Action, Facet},
};
use crate::{
    AppState,
    error::RpcResult,
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

const CONTENT_FACETS: [&str; 9] = [
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
pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.query("zerotrust.documents.get", move |ctx, input: GetInput| {
        let state = Arc::clone(&state);
        async move { get(&state, &ctx, input).await }
    })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<GetInput, Option<DocumentHead>>("zerotrust.documents.get")
}
async fn get(
    state: &AppState,
    ctx: &RequestContext,
    input: GetInput,
) -> RpcResult<Option<DocumentHead>> {
    checked_id(&input.id)?;
    if let Some(scope) = &input.scope {
        checked_id(scope.strip_prefix("commercial:").ok_or_else(invalid)?)?;
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let version = input.version.as_ref().map(|v| revision(v)).transpose()?;
    let value: Option<(String, Value)> =
        sqlx::query_as("SELECT d.scope, CASE WHEN $2::bigint IS NULL THEN d.head ELSE history.head END FROM __zerotrust_documents d LEFT JOIN __zerotrust_document_history history ON history.id=d.id AND history.version=$2 WHERE d.id=$1 AND ($2::bigint IS NULL OR history.id IS NOT NULL)")
            .bind(input.id).bind(version)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    match value {
        Some((scope, head))
            if input
                .scope
                .as_ref()
                .is_none_or(|expected| expected == &scope)
                && guard.allows(&guard.subject, &scope, Facet::MasterData, Action::Read) =>
        {
            Ok(Some(serde_json::from_value(head).map_err(|_| invalid())?))
        }
        Some(_) => Err(forbidden()),
        None => Ok(None),
    }
}
pub(super) async fn lock(tx: &mut PgConnection, heads: &[DocumentHead]) -> RpcResult<()> {
    let mut ids = BTreeSet::new();
    for head in heads {
        head.frame()?;
        if !ids.insert(&head.id) {
            return Err(invalid());
        }
    }
    for id in ids {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("sortsys:zerotrust:document:{id}"))
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    Ok(())
}
pub(super) async fn commit(
    state: &AppState,
    tx: &mut PgConnection,
    guard: &Security,
    tenant: &str,
    head: &DocumentHead,
    metadata_changed: bool,
) -> RpcResult<()> {
    if head.tenant != tenant
        || head.author != guard.subject
        || revision(&head.generation)? != guard.root.generation
        || revision(&head.policy_version)? != guard.root.policy_version
    {
        return Err(conflict());
    }
    verify(&guard.signing_key, &head.signature, &head.frame()?)?;
    let hash = head.hash()?;
    if !guard.allows(&guard.subject, &head.scope, Facet::MasterData, Action::Read) {
        return Err(forbidden());
    }
    let saved: Option<(String, i64, String, Value)> = sqlx::query_as(
        "SELECT scope,version,hash,head FROM __zerotrust_documents WHERE id=$1 FOR UPDATE",
    )
    .bind(&head.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    if let Some((scope, _, known, value)) = &saved {
        if scope != &head.scope {
            return Err(forbidden());
        }
        if known == &hash && value == &serde_json::to_value(head).map_err(internal)? {
            return Ok(());
        }
    }
    let previous = match &saved {
        Some((_, version, hash, value)) => {
            let old: DocumentHead = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
            if old.locked
                || old.read_only && !head.read_only
                || version.checked_add(1) != Some(revision(&head.version)?)
                || hash != &head.previous
            {
                return Err(conflict());
            }
            Some(old)
        }
        None => {
            if !head.previous.is_empty()
                || !guard.allows(
                    &guard.subject,
                    &head.scope,
                    Facet::MasterData,
                    Action::Update,
                )
            {
                return Err(forbidden());
            }
            None
        }
    };
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
        if !head.parts.iter().any(|p| p.facet == old.facet) {
            return Err(invalid());
        }
    }
    let mut notifications = BTreeSet::from([format!("{}:scope", head.scope)]);
    for part in &head.parts {
        let old = previous
            .as_ref()
            .and_then(|head| head.parts.iter().find(|p| p.facet == part.facet));
        if old == Some(part) {
            continue;
        }
        for key in &part.keys {
            notifications.insert(format!("{}:{}", head.scope, key.facet.name()));
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
            let current:Option<(i64,bool)>=sqlx::query_as("SELECT generation,rotation_required FROM __zerotrust_domains WHERE id=$1 AND scope=$2 AND facet=$3")
                .bind(format!("{}:{}",head.scope,key.facet.name())).bind(&head.scope).bind(key.facet.name()).fetch_optional(&mut *tx).await.map_err(internal)?;
            if current != Some((revision(&key.generation)?, false)) {
                return Err(conflict());
            }
        }
        let value: Option<(String, Value)> = sqlx::query_as(
            "SELECT domain_id,envelope FROM __zerotrust_objects WHERE id=$1 AND deleted_at IS NULL",
        )
        .bind(&part.object)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let Some((domain, reference)) = value else {
            return Err(invalid());
        };
        let owner = if part.facet == "opaque" {
            "scope"
        } else {
            &part.facet
        };
        if domain != format!("{}:{owner}", head.scope) {
            return Err(invalid());
        }
        let envelope = read_envelope(state, tenant, reference).await?;
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
    let value = serde_json::to_value(head).map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_documents(id,scope,version,hash,head) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,hash=EXCLUDED.hash,head=EXCLUDED.head")
        .bind(&head.id).bind(&head.scope).bind(revision(&head.version)?).bind(&hash).bind(&value).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query(
        "INSERT INTO __zerotrust_document_history(id,version,hash,head) VALUES($1,$2,$3,$4)",
    )
    .bind(&head.id)
    .bind(revision(&head.version)?)
    .bind(hash)
    .bind(value)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    let sequence: i64 =
        sqlx::query_scalar("SELECT nextval(pg_get_serial_sequence('__zerotrust_changes','seq'))")
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    for domain in notifications {
        sqlx::query("UPDATE __zerotrust_domains SET head_sequence=$1 WHERE id=$2")
            .bind(sequence)
            .bind(&domain)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)").bind(serde_json::json!({"kind":"object","seq":sequence.to_string(),"id":format!("document:{}",head.id),"domain":domain}).to_string()).execute(&mut *tx).await.map_err(internal)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
