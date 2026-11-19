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
use serde::{Deserialize, Serialize};
use sortsys_zerotrust::metadata::RecordKey;

pub(super) const REVIEWED_BOOKINGS: &str = "tool-booking-revisions";
const COMMAND_BINDINGS: &str = "tool-booking-command-bindings";
const BOOKING_COMMANDS: &str = "tool-booking-commands";
const BOOKING_RENEWALS: &str = "tool-booking-renewals";

#[derive(Deserialize, Serialize)]
struct BookingRenewal {
    origin_signature: String,
    source_revision: String,
}

pub(super) async fn record_booking_renewal(
    transaction: &mut Transaction,
    origin: &CreationOrigin,
    source_revision: &str,
) -> RpcResult<()> {
    transaction
        .put_protected(
            key(BOOKING_RENEWALS, &origin.scope),
            &BookingRenewal {
                origin_signature: origin.signature.clone(),
                source_revision: source_revision.to_owned(),
            },
        )
        .await
}

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

async fn bind_booking_command(
    context: &mut MetadataContext,
    origin: &CreationOrigin,
    next: &sortsys_zerotrust::resource_access::ResourceAccessState,
) -> RpcResult<()> {
    let booking = key(BOOKING_COMMANDS, &origin.scope);
    let previous: Option<String> = context.transaction.read(booking.clone()).await?;
    let Some(old_binding) = previous.as_deref() else {
        return check_command_binding(
            &mut context.transaction,
            &origin.scope,
            next.command_binding.as_deref(),
            true,
        )
        .await;
    };
    let renewal = if next.active && origin.access.is_none() {
        context
            .transaction
            .read::<BookingRenewal>(key(BOOKING_RENEWALS, &origin.scope))
            .await?
            .filter(|renewal| renewal.origin_signature == origin.signature)
    } else {
        None
    };
    if next.command_binding.as_deref() == Some(old_binding) {
        if renewal.is_some() {
            return Err(conflict());
        }
        return check_command_binding(
            &mut context.transaction,
            &origin.scope,
            Some(old_binding),
            false,
        )
        .await;
    }

    let new_binding = next.command_binding.as_deref().ok_or_else(conflict)?;
    // Only the administrator who reattested this exact booking under the
    // replacement authority may replace its key in the first new checkpoint.
    if !context.auth.is_admin() || origin.capability.creator.user != context.security.subject {
        return Err(conflict());
    }
    let renewal = renewal.ok_or_else(conflict)?;
    if revision(&renewal.source_revision)?.checked_add(1) != Some(revision(&next.revision)?) {
        return Err(conflict());
    }
    check_command_binding(
        &mut context.transaction,
        &origin.scope,
        Some(old_binding),
        false,
    )
    .await?;
    if super::tool_returns::existing_command(
        &mut context.transaction,
        &context.auth.tenant,
        &origin.scope,
        old_binding,
    )
    .await?
    .is_some()
    {
        return Err(conflict());
    }
    let replacement = key(COMMAND_BINDINGS, new_binding);
    if context
        .transaction
        .read::<String>(replacement.clone())
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    // Keep the old reverse reservation. It cannot be selected again or
    // assigned to another booking even when a previous backup is restored.
    context.transaction.put(replacement, &origin.scope).await?;
    context.transaction.put(booking, &new_binding).await
}

/// Checkout pointers and tracking parents are decrypted during a restore
/// review. Keep a per-object revision for an inexpensive collection CAS.
pub(super) fn booking_review_key(envelope: &EncryptedObject) -> Option<RecordKey> {
    (envelope.facet == Facet::MasterData
        && (envelope.scope.starts_with("tool:") || envelope.scope.starts_with("tool-tracking:"))
        && retains_tool_booking(envelope))
    .then(|| key(REVIEWED_BOOKINGS, &envelope.object))
}

pub(super) fn booking_write_keys(packet: &SaveInput) -> Vec<RecordKey> {
    let mut records = Vec::new();
    if let Some(review) = booking_review_key(&packet.envelope) {
        records.push(review);
    }
    if let Some(state) = &packet.resource_access {
        records.push(key(BOOKING_COMMANDS, &packet.envelope.scope));
        if state.active {
            records.push(key(BOOKING_RENEWALS, &packet.envelope.scope));
        }
        if let Some(binding) = &state.command_binding
            && super::crypto::sized::<32>(binding).is_ok()
        {
            records.push(key(COMMAND_BINDINGS, binding));
            records.push(super::tool_returns::receipt_key(binding));
        }
    }
    records
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
        // A publication prepared before reattestation must not consume the
        // revision reserved for the replacement key without a checkpoint.
        if context
            .transaction
            .read::<BookingRenewal>(key(BOOKING_RENEWALS, &original.scope))
            .await?
            .is_some_and(|renewal| renewal.origin_signature == original.signature)
        {
            return Err(conflict());
        }
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
    let returned = if let Some(binding) = state.command_binding.as_deref() {
        super::tool_returns::existing_command(
            &mut context.transaction,
            &context.auth.tenant,
            &original.scope,
            binding,
        )
        .await?
    } else {
        None
    };
    if state.active && returned.is_some() {
        return Err(conflict());
    }
    if let Some(previous) = &original.access {
        if revision(&previous.revision)?.checked_add(1) != Some(revision(&state.revision)?)
            || (!original.is_active_booking() && state.active)
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
        bind_booking_command(context, &original, state).await?;
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
        origin.returned = returned.clone();
        origin.verify(&context.security.authority)?;
        context.transaction.put_protected(record, &origin).await?;
    }
    let changed_access = original.access.is_none() || original.is_active_booking() != state.active;
    Ok(changed_access)
}
