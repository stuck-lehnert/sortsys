//! Signed public relationships enforce stock lifecycle rules without price keys.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

use super::{
    access::Security,
    crypto::{frame, identifier, invalid, revision, sized, verify},
    objects::{conflict, packet_hash},
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    api::Success,
    error::RpcResult,
    error::{forbidden, internal, not_found},
    ids::Id,
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
pub(super) async fn metadata_save_references(
    transaction: &mut crate::control::Transaction,
    guard: &Security,
    input: &super::objects::SaveInput,
    written: bool,
) -> RpcResult<()> {
    verify_references(
        guard,
        &guard.policy.tenant,
        &input.domain,
        &input.envelope,
        input.references.as_ref(),
    )?;
    let Some(reference) = &input.references else {
        return Ok(());
    };
    let record = crate::control::key("stock-references", &reference.object);
    if !written {
        let previous: Value = transaction.read(record).await?.ok_or_else(conflict)?;
        if previous != serde_json::to_value(reference).map_err(internal)? {
            return Err(conflict());
        }
    } else {
        transaction.put(record, reference).await?;
    }
    Ok(())
}

pub(super) async fn metadata_validate_references(
    transaction: &mut crate::control::Transaction,
    inputs: &[super::objects::SaveInput],
) -> RpcResult<()> {
    for input in inputs {
        let Some(reference) = input
            .references
            .as_ref()
            .filter(|reference| reference.kind == StockKind::Price)
        else {
            continue;
        };
        for (target, expected) in [
            (reference.product.as_ref(), StockKind::Product),
            (reference.vendor.as_ref(), StockKind::Vendor),
        ] {
            let Some(target) = target else {
                continue;
            };
            let record: StockReferences = transaction
                .read(crate::control::key("stock-references", target))
                .await?
                .ok_or_else(conflict)?;
            let object = super::objects::metadata_object(transaction, target)
                .await?
                .ok_or_else(conflict)?;
            check_reference_record(&record, &object)?;
            if record.kind != expected || object.deleted || object.tombstone {
                return Err(conflict());
            }
        }
    }
    Ok(())
}

fn check_reference_record(
    reference: &StockReferences,
    record: &super::objects::ObjectRecord,
) -> RpcResult<()> {
    reference.frame()?;
    if reference.object != record.object
        || reference.domain != record.domain
        || reference.revision != record.revision
    {
        return Err(invalid());
    }
    Ok(())
}

/// Product deletion also hides its price revisions. The durable product head
/// controls visibility; deleting optional proof records cannot resurrect them.
pub(super) async fn metadata_apply_visibility(
    transaction: &mut crate::control::Transaction,
    records: &mut [super::objects::ObjectRecord],
) -> RpcResult<()> {
    let mut positions = Vec::new();
    let mut keys = Vec::new();
    for (index, record) in records.iter().enumerate() {
        if !record.deleted && kind(&record.object)? == Some(StockKind::Price) {
            positions.push(index);
            keys.push(crate::control::key("stock-references", &record.object));
        }
    }
    let references = transaction.many::<StockReferences>(keys).await?;
    let mut products = Vec::new();
    for (index, reference) in positions.iter().zip(references) {
        let reference = reference.ok_or_else(conflict)?;
        check_reference_record(&reference, &records[*index])?;
        if reference.kind != StockKind::Price {
            return Err(invalid());
        }
        let product = reference.product.ok_or_else(invalid)?;
        products.push((
            product.clone(),
            super::objects::metadata_record_key(StockKind::Product.domain(), &product),
        ));
    }
    let parents = transaction
        .many::<super::objects::ObjectRecord>(products.iter().map(|(_, key)| key.clone()).collect())
        .await?;
    for ((index, (product, _)), parent) in positions.into_iter().zip(products).zip(parents) {
        let parent = parent.ok_or_else(conflict)?;
        if parent.object != product || parent.domain != StockKind::Product.domain() {
            return Err(invalid());
        }
        records[index].deleted = parent.deleted || parent.tombstone;
    }
    Ok(())
}

async fn metadata_deletion(
    transaction: &mut crate::control::Transaction,
    object: &str,
) -> RpcResult<Option<StockDeletion>> {
    use crate::control::key;
    let Some(record) = super::objects::metadata_raw_object(transaction, object).await? else {
        return Ok(None);
    };
    let root = if record.deleted {
        object.to_owned()
    } else if kind(object)? == Some(StockKind::Price) {
        let reference: StockReferences = transaction
            .read(key("stock-references", object))
            .await?
            .ok_or_else(invalid)?;
        check_reference_record(&reference, &record)?;
        let product = reference.product.ok_or_else(invalid)?;
        let parent = super::objects::metadata_raw_object(transaction, &product)
            .await?
            .ok_or_else(invalid)?;
        if !parent.deleted {
            return Ok(None);
        }
        product
    } else {
        return Ok(None);
    };
    let deletion: StockDeletion = transaction
        .read(key("stock-deletions", &root))
        .await?
        .ok_or_else(invalid)?;
    deletion.frame()?;
    if deletion.object != root || Some(deletion.kind) != kind(&root)? {
        return Err(invalid());
    }
    Ok(Some(deletion))
}

pub(crate) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let references = Arc::clone(&service);
    let deleted = Arc::clone(&service);
    builder
        .query(
            "zerotrust.stock.references",
            move |ctx, input: ObjectsInput| {
                let service = Arc::clone(&references);
                async move {
                    use crate::control::key;
                    if input.objects.is_empty()
                        || input.objects.len() > 64
                        || input.objects.iter().collect::<BTreeSet<_>>().len()
                            != input.objects.len()
                    {
                        return Err(invalid());
                    }
                    let mut context = super::access::metadata_context(&service, &ctx).await?;
                    let mut object_keys = Vec::new();
                    for object in &input.objects {
                        let kind = kind(object)?.ok_or_else(invalid)?;
                        authorize(&context.security, kind, Action::Read)?;
                        object_keys
                            .push(super::objects::metadata_record_key(kind.domain(), object));
                    }
                    let rows = context
                        .transaction
                        .many::<super::objects::ObjectRecord>(object_keys)
                        .await?;
                    let mut rows = rows
                        .into_iter()
                        .map(|row| row.ok_or_else(conflict))
                        .collect::<RpcResult<Vec<_>>>()?;
                    metadata_apply_visibility(&mut context.transaction, &mut rows).await?;
                    if rows
                        .iter()
                        .zip(&input.objects)
                        .any(|(row, object)| row.deleted || row.tombstone || row.object != *object)
                    {
                        return Err(conflict());
                    }
                    let definitions = context
                        .transaction
                        .many::<StockReferences>(
                            input
                                .objects
                                .iter()
                                .map(|object| key("stock-references", object))
                                .collect(),
                        )
                        .await?;
                    let mut result = Vec::new();
                    for ((object, definition), record) in
                        input.objects.into_iter().zip(definitions).zip(rows)
                    {
                        let definition = definition.ok_or_else(conflict)?;
                        check_reference_record(&definition, &record)?;
                        let vendor_deletion = if let Some(vendor) = &definition.vendor {
                            metadata_deletion(&mut context.transaction, vendor).await?
                        } else {
                            None
                        };
                        result.push(ReferenceState {
                            object,
                            references: definition,
                            vendor_deletion,
                        });
                    }
                    context.transaction.validate().await?;
                    Ok(result)
                }
            },
        )
        .query("zerotrust.stock.deleted", move |ctx, input: ObjectInput| {
            let service = Arc::clone(&deleted);
            async move {
                let mut context = super::access::metadata_context(&service, &ctx).await?;
                let kind = kind(&input.object)?.ok_or_else(invalid)?;
                authorize(&context.security, kind, Action::Read)?;
                let deletion = metadata_deletion(&mut context.transaction, &input.object).await?;
                let result = if let Some(deletion) = deletion {
                    let references: StockReferences = context
                        .transaction
                        .read(crate::control::key("stock-references", &input.object))
                        .await?
                        .ok_or_else(invalid)?;
                    let record = super::objects::metadata_raw_object(
                        &mut context.transaction,
                        &input.object,
                    )
                    .await?
                    .ok_or_else(invalid)?;
                    check_reference_record(&references, &record)?;
                    Some(DeletionState {
                        object: input.object,
                        deletion,
                        references,
                    })
                } else {
                    None
                };
                context.transaction.validate().await?;
                Ok(result)
            }
        })
        .mutation(
            "zerotrust.stock.delete",
            move |ctx, input: StockDeletion| {
                let service = Arc::clone(&service);
                async move { metadata_delete(&service, &ctx, input).await }
            },
        )
}

async fn metadata_delete(
    service: &crate::auth::AuthService,
    request: &RequestContext,
    input: StockDeletion,
) -> RpcResult<Success> {
    use crate::control::key;
    let message = input.frame()?;
    let mut context = super::access::metadata_context(service, request).await?;
    let guard = &context.security;
    authorize(guard, input.kind, Action::Delete)?;
    verify(&guard.signing_key, &input.signature, &message)?;
    if input.tenant != context.auth.tenant
        || input.author != guard.subject
        || revision(&input.authority_generation)? != guard.root.generation
        || input.policy_version != guard.policy.version
    {
        return Err(conflict());
    }
    let mut record = super::objects::metadata_object(&mut context.transaction, &input.object)
        .await?
        .ok_or_else(not_found)?;
    let proof_key = key("stock-deletions", &input.object);
    if let Some(previous) = context
        .transaction
        .read::<StockDeletion>(proof_key.clone())
        .await?
    {
        if serde_json::to_value(previous).map_err(internal)?
            != serde_json::to_value(&input).map_err(internal)?
            || !record.deleted
        {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(Success { success: true });
    }
    if record.deleted || record.domain != input.domain || record.revision != input.revision {
        return Err(conflict());
    }
    let envelope = super::objects::metadata_read(&context.repository, &record.reference).await?;
    if packet_hash(envelope.frame()?, &envelope.signature)? != input.envelope_hash {
        return Err(conflict());
    }
    let reference: StockReferences = context
        .transaction
        .read(key("stock-references", &input.object))
        .await?
        .ok_or_else(conflict)?;
    check_reference_record(&reference, &record)?;
    if reference.kind != input.kind || reference.envelope_hash != input.envelope_hash {
        return Err(conflict());
    }
    record.deleted = true;
    let event_id = format!("deletion:{}", input.signature);
    let event = super::objects::ChangeRecord {
        object: record.clone(),
        previous: None,
        publication: event_id.clone(),
        occurred_micros: chrono::Utc::now().timestamp_micros().to_string(),
        deletion: Some(serde_json::to_value(&input).map_err(internal)?),
        references: Some(serde_json::to_value(&reference).map_err(internal)?),
        migration_origin: None,
    };
    context.transaction.append(
        &input.domain,
        &event_id,
        &input.object,
        &event.occurred_micros,
        None,
        &event,
    )?;
    context
        .transaction
        .put(key("object-deletions", &input.object), &event_id)
        .await?;
    context.transaction.put(proof_key, &input).await?;
    context
        .transaction
        .put(
            super::objects::metadata_record_key(&input.domain, &input.object),
            &record,
        )
        .await?;
    let mut domains = BTreeSet::from([input.kind.domain()]);
    if input.kind != StockKind::Price {
        domains.insert(StockKind::Price.domain());
    }
    for domain in domains {
        if let Some(mut area) = context
            .transaction
            .read::<super::objects::DomainRecord>(key("domains", domain))
            .await?
        {
            area.sequence = revision(&area.sequence)?
                .checked_add(1)
                .ok_or_else(conflict)?
                .to_string();
            context
                .transaction
                .put(key("domains", domain), &area)
                .await?;
            context.transaction.notify(
                "object",
                &serde_json::json!({"domain": domain, "sequence": area.sequence}),
            )?;
        }
    }
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
