//! Resource-specific access states commit with their exact ciphertext packet.
use super::{
    access::MetadataContext,
    creation::CreationOrigin,
    crypto::{invalid, revision},
    objects::{SaveInput, conflict, registry},
    wire::Facet,
};
use crate::{
    control::key,
    error::{RpcResult, forbidden},
};

pub(super) async fn save(
    context: &mut MetadataContext,
    packet: &SaveInput,
    written: bool,
) -> RpcResult<bool> {
    let envelope = &packet.envelope;
    if super::object_shares::is_assignment(envelope)? {
        super::object_shares::save(context, packet, written).await?;
        return Ok(false);
    }
    if packet.recipient_key.is_some() {
        return Err(invalid());
    }
    let canonical = super::creation::initial_record_creation_scope(
        &envelope.scope,
        envelope.facet,
        &envelope.object,
    ) == Some("create:tool-tracking");
    if !canonical {
        if packet.resource_access.is_some() {
            return Err(invalid());
        }
        return Ok(false);
    }
    let collection = registry::origin_collection(context.security.root.generation);
    let master_key = key(&collection, &packet.domain);
    let original: Option<CreationOrigin> = context.transaction.read(master_key.clone()).await?;
    let Some(original) = original else {
        if packet.resource_access.is_some() {
            return Err(invalid());
        }
        return Ok(false);
    };
    if packet.resource_access.is_none() && original.assignee.is_none() && original.access.is_none()
    {
        return Ok(false);
    }
    let state = packet.resource_access.as_ref().ok_or_else(invalid)?;
    if envelope.is_tombstone() && state.active {
        return Err(invalid());
    }
    if state.active
        && let Some(assignee) = &original.assignee
    {
        registry::check_member(&mut context.transaction, &context.security, assignee).await?;
    }
    state.verify(
        &sortsys_zerotrust::resource_access::ResourceAccessContext {
            tenant: &context.auth.tenant,
            resource: &original.scope,
            object: &envelope.object,
            generation: &original.capability.generation,
            binding: &original.resource_binding()?,
        },
        &context.security.authority,
    )?;
    if state.revision != envelope.revision
        || state.packet_signature != envelope.signature
        || state.author.user != context.security.subject
        || super::crypto::sized::<32>(&state.author.signing_key)?.as_slice()
            != context.security.signing_key
    {
        return Err(forbidden());
    }
    if !written {
        let previous = original.access.as_ref().ok_or_else(conflict)?;
        if previous.signature != state.signature || previous.frame()? != state.frame()? {
            return Err(conflict());
        }
        return Ok(false);
    }
    if let Some(previous) = &original.access {
        if revision(&previous.revision)?.checked_add(1) != Some(revision(&state.revision)?)
            || (!previous.active && state.active)
        {
            return Err(conflict());
        }
    } else if original.assignee.is_some() && state.revision != "1" {
        return Err(conflict());
    }
    context
        .transaction
        .prefetch_protected(
            [Facet::MasterData, Facet::Scope]
                .into_iter()
                .map(|facet| key(&collection, &format!("{}:{}", original.scope, facet.name())))
                .collect(),
        )
        .await?;
    for facet in [Facet::MasterData, Facet::Scope] {
        let record = key(&collection, &format!("{}:{}", original.scope, facet.name()));
        let Some(mut origin) = context
            .transaction
            .read::<CreationOrigin>(record.clone())
            .await?
        else {
            if facet == Facet::MasterData {
                return Err(invalid());
            }
            continue;
        };
        if origin.capability.signature != original.capability.signature
            || origin.assignee.as_ref().map(|member| &member.signature)
                != original.assignee.as_ref().map(|member| &member.signature)
        {
            return Err(invalid());
        }
        origin.access = Some(state.clone());
        context.transaction.put_protected(record, &origin).await?;
    }
    let changed_access =
        original.access.as_ref().map(|previous| previous.active) != Some(state.active);
    Ok(changed_access)
}
