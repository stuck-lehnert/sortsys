//! Public delivery-note numbering and immutable identifier bindings. No content keys.
mod persistence;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

use super::{
    access::Security,
    crypto::{invalid, revision},
    objects::{SaveInput, conflict},
    wire::{Action, Facet},
};
use crate::{
    api::Success, error::RpcResult, error::forbidden, ids::Id, rpc::ProcedureRegistryBuilder,
};

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryInitializeInput {
    generation: String,
    policy_version: String,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryAllocateInput {
    project_id: Id,
    request_id: String,
    generation: String,
    policy_version: String,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct DeliveryReferencesInput {
    objects: Vec<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryLocateInput {
    #[ts(optional)]
    id: Option<Id>,
    #[ts(optional)]
    number: Option<String>,
    #[ts(optional)]
    include_deleted: Option<bool>,
}
#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryAllocation {
    id: Id,
    project_id: Id,
    number: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryAdoptionInput {
    context: String,
    generation: String,
    policy_version: String,
    allocations: Vec<DeliveryAllocation>,
    proof: String,
}
#[derive(Serialize, TS)]
struct DeliveryReference {
    object: String,
    allocation: DeliveryAllocation,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Kind {
    Note,
    Price,
    Receipt,
}
pub(super) struct Binding {
    pub project: Id,
    pub note: Option<Id>,
    pub kind: Kind,
}
fn canonical(value: &str) -> RpcResult<Id> {
    let id = Id::decode(value).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != value {
        return Err(invalid());
    }
    Ok(id)
}
pub(super) fn binding(object: &str) -> RpcResult<Option<Binding>> {
    for (prefix, kind) in [
        ("delivery-note:", Kind::Note),
        ("delivery-price:", Kind::Price),
        ("delivery-create:", Kind::Receipt),
    ] {
        if let Some(value) = object.strip_prefix(prefix) {
            let mut parts = value.split(':');
            let project = canonical(parts.next().ok_or_else(invalid)?)?;
            let next = parts.next().ok_or_else(invalid)?;
            let note = if matches!(kind, Kind::Receipt) {
                canonical(next)?;
                let request = parts.next().ok_or_else(invalid)?;
                request_id(request)?;
                None
            } else {
                Some(canonical(next)?)
            };
            if parts.next().is_some() {
                return Err(invalid());
            }
            return Ok(Some(Binding {
                project,
                note,
                kind,
            }));
        }
    }
    Ok(None)
}
fn request_id(value: &str) -> RpcResult<()> {
    if !(16..=80).contains(&value.len())
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid());
    }
    Ok(())
}
fn area(project: Id, price: bool) -> (String, String, Facet) {
    let scope = format!("project:{}:delivery-notes", project.encode());
    let facet = if price {
        Facet::Procurement
    } else {
        Facet::MasterData
    };
    (format!("{scope}:{}", facet.name()), scope, facet)
}
fn authorize(guard: &Security, project: Id, action: Action) -> RpcResult<()> {
    let (_, scope, facet) = area(project, false);
    if !guard.allows(&guard.subject, &scope, facet, Action::Read)
        || !guard.allows(&guard.subject, &scope, facet, action)
    {
        return Err(forbidden());
    }
    Ok(())
}
fn current(guard: &Security, generation: &str, policy: &str) -> RpcResult<()> {
    if revision(generation)? != guard.root.generation
        || revision(policy)? != guard.root.policy_version
    {
        return Err(conflict());
    }
    Ok(())
}

pub(super) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    persistence::register(builder, service)
}

pub(super) async fn metadata_validate_packet(
    context: &mut super::access::MetadataContext,
    input: &SaveInput,
) -> RpcResult<()> {
    persistence::validate_packet(context, input).await
}

pub(super) fn deletion_price_domain(input: &SaveInput) -> RpcResult<Option<String>> {
    if !input.envelope.is_tombstone() {
        return Ok(None);
    }
    let Some(selected) = binding(&input.envelope.object)? else {
        return Ok(None);
    };
    if !matches!(selected.kind, Kind::Note) {
        return Ok(None);
    }
    Ok(Some(area(selected.project, true).0))
}

pub(super) async fn metadata_apply_visibility(
    transaction: &mut crate::control::Transaction,
    records: &mut [super::objects::ObjectRecord],
) -> RpcResult<()> {
    persistence::apply_visibility(transaction, records).await
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<DeliveryLocateInput, DeliveryAllocation>("zerotrust.deliveryNotes.locate")
        .mutation_stub::<DeliveryInitializeInput, Success>("zerotrust.deliveryNotes.initialize")
        .mutation_stub::<DeliveryAdoptionInput, Success>("zerotrust.deliveryNotes.adopt")
        .mutation_stub::<DeliveryAllocateInput, DeliveryAllocation>(
            "zerotrust.deliveryNotes.allocate",
        )
        .query_stub::<DeliveryReferencesInput, Vec<DeliveryReference>>(
            "zerotrust.deliveryNotes.references",
        )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespaces_have_canonical_project_and_note_bindings() {
        for value in [
            "delivery-note:1:2",
            "delivery-price:1:2",
            "delivery-create:1:2:request_0123456789",
        ] {
            assert!(binding(value).unwrap().is_some());
        }
        for value in [
            "delivery-note:01:2",
            "delivery-note:1:02",
            "delivery-note:1:2:x",
            "delivery-create:1:2:x",
            "delivery-price:0:1",
            "delivery-note:1:8000000000000",
        ] {
            assert!(binding(value).is_err(), "{value}");
        }
        assert!(binding("unrelated:1").unwrap().is_none());
    }
}
