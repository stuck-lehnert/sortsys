//! Resource-specific access states commit with their exact ciphertext packet.
use super::{
    access::MetadataContext,
    creation::CreationOrigin,
    crypto::{invalid, revision},
    objects::{SaveInput, conflict, registry},
    wire::{EncryptedObject, Facet},
};
use crate::{
    control::{Transaction, key},
    error::{RpcResult, forbidden},
    ids::Id,
};

pub(super) const REVIEWED_BOOKINGS: &str = "tool-booking-revisions";
const COMMAND_BINDINGS: &str = "tool-booking-command-bindings";
const BOOKING_COMMANDS: &str = "tool-booking-commands";

pub(super) async fn check_command_binding(
    transaction: &mut Transaction,
    scope: &str,
    binding: Option<&str>,
    register: bool,
) -> RpcResult<()> {
    let by_booking = key(BOOKING_COMMANDS, scope);
    let Some(binding) = binding else {
        if transaction.read::<String>(by_booking).await?.is_some() {
            return Err(conflict());
        }
        return Ok(());
    };
    let by_binding = key(COMMAND_BINDINGS, binding);
    let saved = transaction
        .many::<String>(vec![by_binding.clone(), by_booking.clone()])
        .await?;
    match saved.as_slice() {
        [None, None] if register => {
            transaction.put(by_binding, &scope).await?;
            transaction.put(by_booking, &binding).await?;
        }
        [Some(owner), Some(previous)] if owner == scope && previous == binding => {}
        _ => return Err(conflict()),
    }
    Ok(())
}

/// Checkout pointers and tracking parents are decrypted during a restore
/// review. Keep a per-object revision for an inexpensive collection CAS.
pub(super) fn booking_review_key(
    envelope: &EncryptedObject,
) -> Option<sortsys_zerotrust::metadata::RecordKey> {
    (envelope.facet == Facet::MasterData
        && (envelope.scope.starts_with("tool:") || envelope.scope.starts_with("tool-tracking:"))
        && retains_tool_booking(envelope))
    .then(|| key(REVIEWED_BOOKINGS, &envelope.object))
}

fn canonical_id(token: &str) -> bool {
    Id::decode(token).is_ok_and(|id| id.0 > 0 && id.encode() == token)
}

/// These encrypted records represent the same physical checkout even when
/// mutable descriptions or other project data are restored from a backup.
pub(super) fn retains_tool_booking(envelope: &EncryptedObject) -> bool {
    let object = envelope.object.as_str();
    let Some((namespace, resource)) = envelope.scope.split_once(':') else {
        return false;
    };
    let facet = envelope.facet;
    match namespace {
        "tool" => {
            facet == Facet::MasterData
                && canonical_id(resource)
                && object == format!("tool:{resource}:master-data:booking")
        }
        "tool-tracking" => {
            matches!(facet, Facet::MasterData | Facet::Scope | Facet::Procurement)
                && canonical_id(resource)
                && object == format!("{}:{}:record", envelope.scope, facet.name())
        }
        "project" => {
            if !matches!(facet, Facet::MasterData | Facet::Procurement) {
                return false;
            }
            let Some(project) = resource.strip_suffix(":tool-usage") else {
                return false;
            };
            let prefix = format!("tool-usage:{project}:{}:", facet.name());
            canonical_id(project) && object.strip_prefix(&prefix).is_some_and(canonical_id)
        }
        _ => false,
    }
}

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
            || previous.command_binding.is_some()
                && previous.command_binding != state.command_binding
        {
            return Err(conflict());
        }
    } else if original.assignee.is_some() && state.revision != "1" {
        return Err(conflict());
    }
    if original
        .access
        .as_ref()
        .is_none_or(|previous| previous.command_binding.is_none())
    {
        // A new or renewed origin must reserve or re-use the exact existing
        // commitment. Both index directions survive content restoration.
        check_command_binding(
            &mut context.transaction,
            &original.scope,
            state.command_binding.as_deref(),
            true,
        )
        .await?;
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
