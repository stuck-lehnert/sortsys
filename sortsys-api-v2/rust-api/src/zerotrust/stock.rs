//! Signed public relationships enforce stock lifecycle rules without price keys.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

use super::{
    access::{Security, security},
    crypto::{frame, identifier, invalid, revision, sized, verify},
    objects::{conflict, domain_lock, packet_hash, read_envelope},
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(super) enum StockKind {
    Product,
    Vendor,
    Price,
}
impl StockKind {
    fn name(self) -> &'static str {
        match self {
            Self::Product => "product",
            Self::Vendor => "vendor",
            Self::Price => "price",
        }
    }
    fn domain(self) -> &'static str {
        match self {
            Self::Product => "catalog:products:master-data",
            Self::Vendor => "catalog:vendors:master-data",
            Self::Price => "catalog:products:procurement",
        }
    }
    fn scope(self) -> &'static str {
        if self == Self::Vendor {
            "catalog:vendors"
        } else {
            "catalog:products"
        }
    }
    fn facet(self) -> Facet {
        if self == Self::Price {
            Facet::Procurement
        } else {
            Facet::MasterData
        }
    }
}
pub(super) fn kind(object: &str) -> RpcResult<Option<StockKind>> {
    for (prefix, kind) in [
        ("product:", StockKind::Product),
        ("vendor:", StockKind::Vendor),
        ("product-price:", StockKind::Price),
    ] {
        if let Some(id) = object.strip_prefix(prefix) {
            let decoded = Id::decode(id).map_err(|_| invalid())?;
            if decoded.0 <= 0 || decoded.encode() != id {
                return Err(invalid());
            }
            return Ok(Some(kind));
        }
    }
    Ok(None)
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StockReferences {
    tenant: String,
    domain: String,
    object: String,
    revision: String,
    envelope_hash: String,
    authority_generation: String,
    policy_version: String,
    author: String,
    kind: StockKind,
    product: Option<String>,
    vendor: Option<String>,
    signature: String,
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StockDeletion {
    tenant: String,
    domain: String,
    object: String,
    revision: String,
    envelope_hash: String,
    authority_generation: String,
    policy_version: String,
    author: String,
    kind: StockKind,
    signature: String,
}
fn binding(fields: [&str; 8], expected: StockKind) -> RpcResult<Vec<&str>> {
    let [
        tenant,
        domain,
        object,
        version,
        hash,
        generation,
        policy,
        author,
    ] = fields;
    identifier(tenant)?;
    identifier(author)?;
    if kind(object)? != Some(expected)
        || domain != expected.domain()
        || kind(&format!(
            "product:{}",
            author.strip_prefix("user:").ok_or_else(invalid)?
        ))? != Some(StockKind::Product)
    {
        return Err(invalid());
    }
    revision(version)?;
    revision(generation)?;
    revision(policy)?;
    sized::<32>(hash)?;
    Ok(vec![
        tenant,
        domain,
        object,
        version,
        hash,
        generation,
        policy,
        author,
        expected.name(),
    ])
}
impl StockReferences {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        let mut fields = binding(
            [
                &self.tenant,
                &self.domain,
                &self.object,
                &self.revision,
                &self.envelope_hash,
                &self.authority_generation,
                &self.policy_version,
                &self.author,
            ],
            self.kind,
        )?;
        if self.kind == StockKind::Price {
            if self.product.as_deref().map(kind).transpose()?.flatten() != Some(StockKind::Product)
                || self
                    .vendor
                    .as_deref()
                    .map(kind)
                    .transpose()?
                    .is_some_and(|kind| kind != Some(StockKind::Vendor))
            {
                return Err(invalid());
            }
        } else if self.product.is_some() || self.vendor.is_some() {
            return Err(invalid());
        }
        fields.extend([
            self.product.as_deref().unwrap_or(""),
            self.vendor.as_deref().unwrap_or(""),
        ]);
        Ok(frame("sortsys/stock-reference/v1", &fields))
    }
}
impl StockDeletion {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        Ok(frame(
            "sortsys/stock-deletion/v1",
            &binding(
                [
                    &self.tenant,
                    &self.domain,
                    &self.object,
                    &self.revision,
                    &self.envelope_hash,
                    &self.authority_generation,
                    &self.policy_version,
                    &self.author,
                ],
                self.kind,
            )?,
        ))
    }
}

/// Take these locks even on a price-only edit; deletion and rebinding on other
/// API replicas must participate in the same deterministic lock order.
pub(super) fn reference_domains(reference: &StockReferences) -> RpcResult<Vec<String>> {
    reference.frame()?;
    let mut domains = vec![reference.domain.clone()];
    if reference.product.is_some() {
        domains.push(StockKind::Product.domain().into());
    }
    if reference.vendor.is_some() {
        domains.push(StockKind::Vendor.domain().into());
    }
    Ok(domains)
}
pub(super) fn verify_references(
    guard: &Security,
    tenant: &str,
    domain: &str,
    envelope: &EncryptedObject,
    reference: Option<&StockReferences>,
) -> RpcResult<()> {
    let Some(expected) = kind(&envelope.object)? else {
        return if reference.is_none() {
            Ok(())
        } else {
            Err(invalid())
        };
    };
    let reference = reference.ok_or_else(invalid)?;
    verify(
        &guard.signing_key,
        &reference.signature,
        &reference.frame()?,
    )?;
    if reference.tenant != tenant
        || reference.domain != domain
        || reference.kind != expected
        || reference.object != envelope.object
        || reference.author != guard.subject
        || reference.author != envelope.author
        || reference.revision != envelope.revision
        || revision(&reference.authority_generation)? != guard.root.generation
        || reference.policy_version != envelope.policy_version
        || reference.envelope_hash != packet_hash(envelope.frame()?, &envelope.signature)?
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) async fn save_references(
    tx: &mut PgConnection,
    guard: &Security,
    tenant: &str,
    domain: &str,
    envelope: &EncryptedObject,
    reference: Option<&StockReferences>,
    written: bool,
) -> RpcResult<()> {
    verify_references(guard, tenant, domain, envelope, reference)?;
    save_verified_references(tx, reference, written).await
}
pub(super) async fn save_verified_references(
    tx: &mut PgConnection,
    reference: Option<&StockReferences>,
    written: bool,
) -> RpcResult<()> {
    let Some(reference) = reference else {
        return Ok(());
    };
    let definition = serde_json::to_value(reference).map_err(internal)?;
    if !written {
        let previous: Option<Value> = sqlx::query_scalar(
            "SELECT definition FROM __zerotrust_stock_references WHERE object_id=$1",
        )
        .bind(&reference.object)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        if previous != Some(definition) {
            return Err(conflict());
        }
        return Ok(());
    }
    sqlx::query("INSERT INTO __zerotrust_stock_references(object_id,kind,product_object_id,vendor_object_id,definition) VALUES($1,$2,$3,$4,$5) ON CONFLICT(object_id) DO UPDATE SET product_object_id=EXCLUDED.product_object_id,vendor_object_id=EXCLUDED.vendor_object_id,definition=EXCLUDED.definition")
        .bind(&reference.object).bind(reference.kind.name()).bind(&reference.product).bind(&reference.vendor).bind(definition).execute(tx).await.map_err(internal)?;
    Ok(())
}
pub(super) async fn validate_references(
    tx: &mut PgConnection,
    objects: &[String],
) -> RpcResult<()> {
    let invalid_reference: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_stock_references r WHERE r.object_id=ANY($1) AND r.kind='price' AND (NOT EXISTS(SELECT 1 FROM __zerotrust_stock_references p JOIN __zerotrust_objects o ON o.id=p.object_id WHERE p.object_id=r.product_object_id AND p.kind='product' AND o.deleted_at IS NULL) OR (r.vendor_object_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __zerotrust_stock_references v JOIN __zerotrust_objects o ON o.id=v.object_id WHERE v.object_id=r.vendor_object_id AND v.kind='vendor' AND o.deleted_at IS NULL))))")
        .bind(objects).fetch_one(tx).await.map_err(internal)?;
    if invalid_reference {
        return Err(conflict());
    }
    Ok(())
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ObjectsInput {
    objects: Vec<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ObjectInput {
    object: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ReferenceState {
    object: String,
    references: StockReferences,
    vendor_deletion: Option<StockDeletion>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DeletionState {
    object: String,
    deletion: StockDeletion,
    references: StockReferences,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let references = Arc::clone(&state);
    let deleted = Arc::clone(&state);
    builder
        .query(
            "zerotrust.stock.references",
            move |ctx, input: ObjectsInput| {
                let state = Arc::clone(&references);
                async move { references_for(&state, &ctx, input).await }
            },
        )
        .query("zerotrust.stock.deleted", move |ctx, input: ObjectInput| {
            let state = Arc::clone(&deleted);
            async move { deletion_for(&state, &ctx, input).await }
        })
        .mutation(
            "zerotrust.stock.delete",
            move |ctx, input: StockDeletion| {
                let state = Arc::clone(&state);
                async move { delete(&state, &ctx, input).await }
            },
        )
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ObjectsInput, Vec<ReferenceState>>("zerotrust.stock.references")
        .query_stub::<ObjectInput, Option<DeletionState>>("zerotrust.stock.deleted")
        .mutation_stub::<StockDeletion, Success>("zerotrust.stock.delete")
}
fn authorize(guard: &Security, kind: StockKind, action: Action) -> RpcResult<()> {
    if !guard.allows(&guard.subject, kind.scope(), kind.facet(), Action::Read)
        || !guard.allows(&guard.subject, kind.scope(), kind.facet(), action)
    {
        return Err(forbidden());
    }
    Ok(())
}
async fn references_for(
    state: &AppState,
    ctx: &RequestContext,
    input: ObjectsInput,
) -> RpcResult<Vec<ReferenceState>> {
    if input.objects.is_empty()
        || input.objects.len() > 64
        || input.objects.iter().collect::<BTreeSet<_>>().len() != input.objects.len()
    {
        return Err(invalid());
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let mut domains = BTreeSet::new();
    for object in &input.objects {
        let kind = kind(object)?.ok_or_else(invalid)?;
        authorize(&guard, kind, Action::Read)?;
        domains.insert(kind.domain());
        if kind == StockKind::Price {
            domains.insert(StockKind::Vendor.domain());
        }
    }
    for domain in domains {
        domain_lock(&mut tx, domain, false).await?;
    }
    let rows: Vec<(String, Value, Option<Value>)> = sqlx::query_as("SELECT r.object_id,r.definition,d.definition FROM __zerotrust_stock_references r JOIN __zerotrust_objects o ON o.id=r.object_id LEFT JOIN __zerotrust_stock_deletions d ON d.object_id=r.vendor_object_id WHERE r.object_id=ANY($1) AND o.deleted_at IS NULL")
        .bind(&input.objects).fetch_all(&mut *tx).await.map_err(internal)?;
    if rows.len() != input.objects.len() {
        return Err(conflict());
    }
    let mut rows = rows
        .into_iter()
        .map(|(id, reference, deleted)| (id, (reference, deleted)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut result = Vec::new();
    for object in input.objects {
        let (reference, deleted) = rows.remove(&object).ok_or_else(conflict)?;
        result.push(ReferenceState {
            object,
            references: serde_json::from_value(reference).map_err(internal)?,
            vendor_deletion: deleted
                .map(serde_json::from_value)
                .transpose()
                .map_err(internal)?,
        });
    }
    Ok(result)
}
async fn deletion_for(
    state: &AppState,
    ctx: &RequestContext,
    input: ObjectInput,
) -> RpcResult<Option<DeletionState>> {
    let kind = kind(&input.object)?.ok_or_else(invalid)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    authorize(&guard, kind, Action::Read)?;
    domain_lock(&mut tx, kind.domain(), false).await?;
    let row: Option<(Value, Value)> = sqlx::query_as("SELECT d.definition,r.definition FROM __zerotrust_stock_deletions d JOIN __zerotrust_stock_references r ON r.object_id=d.object_id WHERE d.object_id=$1")
        .bind(&input.object).fetch_optional(&mut *tx).await.map_err(internal)?;
    row.map(|(deletion, references)| {
        Ok(DeletionState {
            object: input.object,
            deletion: serde_json::from_value(deletion).map_err(internal)?,
            references: serde_json::from_value(references).map_err(internal)?,
        })
    })
    .transpose()
}
async fn delete(
    state: &AppState,
    ctx: &RequestContext,
    input: StockDeletion,
) -> RpcResult<Success> {
    let message = input.frame()?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    authorize(&guard, input.kind, Action::Delete)?;
    verify(&guard.signing_key, &input.signature, &message)?;
    if input.tenant != auth.tenant
        || input.author != guard.subject
        || revision(&input.authority_generation)? != guard.root.generation
        || revision(&input.policy_version)? != guard.root.policy_version
    {
        return Err(conflict());
    }
    let mut domains = BTreeSet::from([input.kind.domain()]);
    if input.kind != StockKind::Price {
        domains.insert(StockKind::Price.domain());
    }
    for domain in &domains {
        domain_lock(&mut tx, domain, true).await?;
    }
    let definition = serde_json::to_value(&input).map_err(internal)?;
    let old: Option<Value> =
        sqlx::query_scalar("SELECT definition FROM __zerotrust_stock_deletions WHERE object_id=$1")
            .bind(&input.object)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if let Some(old) = old {
        return if old == definition {
            Ok(Success { success: true })
        } else {
            Err(conflict())
        };
    }
    let row: Option<(String, i64, Value, bool)> = sqlx::query_as("SELECT domain_id,revision,envelope,deleted_at IS NOT NULL FROM __zerotrust_objects WHERE id=$1 FOR UPDATE")
        .bind(&input.object).fetch_optional(&mut *tx).await.map_err(internal)?;
    let (domain, version, reference, deleted) = row.ok_or_else(not_found)?;
    if deleted || domain != input.domain || version != revision(&input.revision)? {
        return Err(conflict());
    }
    let envelope = read_envelope(state, &auth.tenant, reference).await?;
    if packet_hash(envelope.frame()?, &envelope.signature)? != input.envelope_hash {
        return Err(conflict());
    }
    let registered: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM __zerotrust_stock_references WHERE object_id=$1 AND kind=$2)",
    )
    .bind(&input.object)
    .bind(input.kind.name())
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if !registered {
        return Err(conflict());
    }
    let mut affected = vec![input.object.clone()];
    if input.kind == StockKind::Product {
        let children: Vec<String> = sqlx::query_scalar("SELECT r.object_id FROM __zerotrust_stock_references r JOIN __zerotrust_objects o ON o.id=r.object_id WHERE r.product_object_id=$1 AND r.kind='price' AND o.deleted_at IS NULL ORDER BY r.object_id").bind(&input.object).fetch_all(&mut *tx).await.map_err(internal)?;
        affected.extend(children);
    }
    for object in &affected {
        sqlx::query("INSERT INTO __zerotrust_stock_deletions(object_id,root_object_id,definition) VALUES($1,$2,$3)").bind(object).bind(&input.object).bind(&definition).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query(
        "UPDATE __zerotrust_objects SET deleted_at=now(),updated_at=now() WHERE id=ANY($1)",
    )
    .bind(&affected)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    // Invalidation heads use the same sequence as ordinary object commits.
    // Notifications contain no prices, descriptions, relationship lists or keys.
    for domain in domains {
        let seq: i64 = sqlx::query_scalar("UPDATE __zerotrust_domains SET head_sequence=nextval(pg_get_serial_sequence('__zerotrust_changes','seq')) WHERE id=$1 RETURNING head_sequence").bind(domain).fetch_optional(&mut *tx).await.map_err(internal)?.unwrap_or(0);
        if seq > 0 {
            sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)").bind(serde_json::json!({"kind":"object","seq":seq.to_string(),"id":input.object,"domain":domain}).to_string()).execute(&mut *tx).await.map_err(internal)?;
        }
    }
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
