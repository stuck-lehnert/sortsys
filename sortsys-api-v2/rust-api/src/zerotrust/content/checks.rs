//! Public dependencies that cross from the selected view to current controls.
use super::super::{
    access::{MetadataContext, inherited_rules},
    creation::{CreationOrigin, metadata_origins},
    crypto::{invalid, sized},
    documents::DocumentHead,
    object_shares::{RecipientAccess, verify_access},
    objects::{conflict, metadata_object, metadata_read, packet_hash, registry},
    wire::{Action, EncryptedObject, Facet},
};
use crate::error::RpcResult;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct RestoredDocuments {
    pub scopes: Vec<String>,
    pub unchecked: u32,
}

pub(super) async fn visible_registrations(
    context: &mut MetadataContext,
    registrations: BTreeMap<String, u32>,
) -> RpcResult<RestoredDocuments> {
    let mut report = RestoredDocuments::default();
    let selected = registrations.into_iter().collect::<Vec<_>>();
    let security = &context.security;
    for cases in selected.chunks(16) {
        let domains = cases
            .iter()
            .map(|(scope, _)| format!("{scope}:master-data"))
            .collect::<Vec<_>>();
        let origins = metadata_origins(
            &mut context.transaction,
            &context.auth,
            security.root.generation,
            &security.authority,
            &security.subject,
            &security.policy,
            Some(&domains),
        )
        .await?;
        let inherited = inherited_rules(&origins, &security.policy);
        for (scope, count) in cases {
            if security.policy.allows_with(
                &inherited,
                &security.subject,
                scope,
                Facet::MasterData,
                Action::Read,
            ) {
                report.scopes.push(scope.clone());
            } else {
                report.unchecked = report.unchecked.checked_add(*count).ok_or_else(invalid)?;
            }
        }
    }
    Ok(report)
}

async fn record(context: &mut MetadataContext, id: &str) -> RpcResult<EncryptedObject> {
    let record = metadata_object(&mut context.transaction, id)
        .await?
        .filter(|record| !record.deleted)
        .ok_or_else(conflict)?;
    let envelope = metadata_read(&context.repository, &record.reference).await?;
    if envelope.tenant != context.auth.tenant
        || envelope.object != id
        || envelope.revision != record.revision
        || envelope.is_tombstone() != record.tombstone
        || format!("{}:{}", envelope.scope, envelope.facet.name()) != record.domain
    {
        return Err(invalid());
    }
    Ok(envelope)
}

async fn signing_key(context: &mut MetadataContext, generation: &str) -> RpcResult<[u8; 32]> {
    if generation == context.security.root.generation.to_string() {
        return context
            .security
            .authority
            .as_slice()
            .try_into()
            .map_err(|_| invalid());
    }
    let historical =
        registry::authority_at(&mut context.transaction, &context.auth.tenant, generation).await?;
    sized::<32>(&historical.authority_signing_key)
}

async fn assignments(context: &mut MetadataContext) -> RpcResult<()> {
    let mut after = None;
    loop {
        let page = context
            .transaction
            .scan::<RecipientAccess>("object-recipient-access", after)
            .await?;
        for row in page.records {
            let value = row.value.ok_or_else(invalid)?;
            if value.access.object != row.record.key {
                return Err(invalid());
            }
            let envelope = record(context, &value.access.object).await?;
            let authority = signing_key(context, &value.access.generation).await?;
            verify_access(&value, &envelope, &value.access.generation, &authority)?;
            if value.access.active {
                let project = envelope
                    .scope
                    .strip_suffix(":planning")
                    .ok_or_else(invalid)?;
                let parent = record(context, project).await?;
                if parent.is_tombstone()
                    || parent.scope != project
                    || parent.facet != Facet::MasterData
                {
                    return Err(conflict());
                }
            }
        }
        let Some(next) = page.after else {
            return Ok(());
        };
        after = Some(next);
    }
}

async fn responsible_bookings(context: &mut MetadataContext) -> RpcResult<()> {
    let collection = registry::origin_collection(context.security.root.generation);
    let mut after = None;
    loop {
        let page = context
            .transaction
            .scan_prefix::<CreationOrigin>(&collection, "tool-tracking:", after, 128)
            .await?;
        for row in page.records {
            let origin = row.value.ok_or_else(invalid)?;
            if origin.facet != Facet::MasterData {
                continue;
            }
            let Some(access) = origin.access.as_ref() else {
                continue;
            };
            let object = format!("{}:master-data:record", origin.scope);
            let envelope = record(context, &object).await?;
            access.verify(
                &sortsys_zerotrust::resource_access::ResourceAccessContext {
                    tenant: &context.auth.tenant,
                    resource: &origin.scope,
                    object: &object,
                    generation: &origin.capability.generation,
                    binding: &origin.resource_binding()?,
                },
                &context.security.authority,
            )?;
            if envelope.revision != access.revision
                || envelope.signature != access.packet_signature
                || envelope.scope != origin.scope
                || envelope.facet != Facet::MasterData
                || envelope.is_tombstone() && access.active
            {
                return Err(conflict());
            }
        }
        let Some(next) = page.after else {
            return Ok(());
        };
        after = Some(next);
    }
}

async fn closed_documents(context: &mut MetadataContext) -> RpcResult<BTreeMap<String, u32>> {
    let mut restored = BTreeMap::<String, u32>::new();
    let mut after = None;
    loop {
        let page = context
            .transaction
            .scan::<DocumentHead>("documents", after)
            .await?;
        for row in page.records {
            let head = row.value.ok_or_else(invalid)?;
            if !head.locked {
                continue;
            }
            head.frame()?;
            if head.id != row.record.key || head.tenant != context.auth.tenant {
                return Err(invalid());
            }
            if super::super::documents::check_restore_origin(&mut context.transaction, &head)
                .await?
            {
                let count = restored.entry(head.scope.clone()).or_default();
                *count = count.checked_add(1).ok_or_else(invalid)?;
            }
            let case = record(context, &format!("{}:master-data:case", head.scope)).await?;
            if case.is_tombstone() || case.scope != head.scope || case.facet != Facet::MasterData {
                return Err(conflict());
            }
            for part in head.parts {
                let envelope = record(context, &part.object).await?;
                let owner = if part.facet == "opaque" {
                    "scope"
                } else {
                    &part.facet
                };
                if envelope.is_tombstone()
                    || envelope.scope != head.scope
                    || envelope.facet.name() != owner
                    || !part.keys.iter().any(|key| {
                        key.facet == envelope.facet && key.generation == envelope.generation
                    })
                    || packet_hash(envelope.frame()?, &envelope.signature)? != part.hash
                {
                    return Err(conflict());
                }
            }
        }
        let Some(next) = page.after else {
            return Ok(restored);
        };
        after = Some(next);
    }
}

pub(super) async fn dependencies(
    context: &mut MetadataContext,
) -> RpcResult<BTreeMap<String, u32>> {
    assignments(context).await?;
    responsible_bookings(context).await?;
    closed_documents(context).await
}
