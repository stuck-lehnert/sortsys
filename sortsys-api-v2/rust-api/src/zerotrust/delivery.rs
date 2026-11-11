//! Public delivery-note numbering and immutable identifier bindings. No content keys.
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

use super::{
    access::{Security, security},
    crypto::{frame, invalid, revision, verify},
    objects::{SaveInput, conflict, domain_lock},
    wire::{Action, Facet},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
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
#[serde(deny_unknown_fields)]
struct DeliveryLocateInput {
    #[ts(optional)]
    id: Option<Id>,
    #[ts(optional)]
    number: Option<String>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DeliveryAllocation {
    id: Id,
    project_id: Id,
    number: String,
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
    let scope = format!("project:{}", project.encode());
    let facet = if price {
        Facet::Procurement
    } else {
        Facet::ContractQuantities
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
async fn initialize(tx: &mut PgConnection, phase: &str) -> RpcResult<()> {
    let ready: bool = sqlx::query_scalar(
        "SELECT initialized FROM __zerotrust_delivery_state WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if ready {
        return Ok(());
    }
    // Setup's cutover lock has frozen the old source. Copy only the already
    // public identifiers and running number, never business content columns.
    if phase != "enrolling" {
        return Err(conflict());
    }
    sqlx::query("INSERT INTO __zerotrust_delivery_allocations(id,project_id,number) SELECT id,project_id,auto_id FROM product_delivery_notes").execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_delivery_state SET initialized=TRUE,last_number=GREATEST(COALESCE((SELECT max(number) FROM __zerotrust_delivery_allocations),0),(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM product_delivery_notes_auto_id_seq)) WHERE singleton").execute(tx).await.map_err(internal)?;
    Ok(())
}
pub(super) async fn validate_packet(
    tx: &mut PgConnection,
    guard: &Security,
    input: &SaveInput,
) -> RpcResult<()> {
    let Some(binding) = binding(&input.envelope.object)? else {
        return Ok(());
    };
    let (domain, scope, facet) = area(binding.project, matches!(binding.kind, Kind::Price));
    if input.domain != domain || input.envelope.scope != scope || input.envelope.facet != facet {
        return Err(invalid());
    }
    if !guard.allows(&guard.subject, &scope, facet, Action::Read) {
        return Err(forbidden());
    }
    if let Some(note) = binding.note {
        let allocation: Option<Option<String>> = sqlx::query_scalar(
            "SELECT author FROM __zerotrust_delivery_allocations WHERE id=$1 AND project_id=$2",
        )
        .bind(note.0)
        .bind(binding.project.0)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let author = allocation.ok_or_else(conflict)?;
        if input.envelope.revision == "1"
            && author
                .as_ref()
                .is_some_and(|author| author != &guard.subject)
        {
            let published: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_objects WHERE id=$1 AND deleted_at IS NULL)")
                .bind(format!("delivery-note:{}:{}", binding.project.encode(), note.encode())).fetch_one(tx).await.map_err(internal)?;
            if matches!(binding.kind, Kind::Note) || !published {
                return Err(forbidden());
            }
        }
    } else {
        let suffix = input
            .envelope
            .object
            .strip_prefix(&format!("delivery-create:{}:", binding.project.encode()))
            .ok_or_else(invalid)?;
        if !suffix.starts_with(&format!(
            "{}:",
            guard.subject.strip_prefix("user:").ok_or_else(invalid)?
        )) || input.envelope.revision != "1"
        {
            return Err(forbidden());
        }
        let (_, request) = suffix.split_once(':').ok_or_else(invalid)?;
        let allocated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_delivery_allocations WHERE project_id=$1 AND author=$2 AND request_id=$3)")
            .bind(binding.project.0).bind(&guard.subject).bind(request).fetch_one(tx).await.map_err(internal)?;
        if !allocated {
            return Err(conflict());
        }
    }
    Ok(())
}

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let init = state.clone();
    let allocation = state.clone();
    let locate_state = state.clone();
    builder
        .mutation(
            "zerotrust.deliveryNotes.initialize",
            move |ctx, input: DeliveryInitializeInput| {
                let state = init.clone();
                async move { prepare(&state, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.deliveryNotes.allocate",
            move |ctx, input: DeliveryAllocateInput| {
                let state = allocation.clone();
                async move { allocate(&state, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.deliveryNotes.locate",
            move |ctx, input: DeliveryLocateInput| {
                let state = locate_state.clone();
                async move { locate(&state, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.deliveryNotes.references",
            move |ctx, input: DeliveryReferencesInput| {
                let state = state.clone();
                async move { references(&state, &ctx, input).await }
            },
        )
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<DeliveryLocateInput, DeliveryAllocation>("zerotrust.deliveryNotes.locate")
        .mutation_stub::<DeliveryInitializeInput, Success>("zerotrust.deliveryNotes.initialize")
        .mutation_stub::<DeliveryAllocateInput, DeliveryAllocation>(
            "zerotrust.deliveryNotes.allocate",
        )
        .query_stub::<DeliveryReferencesInput, Vec<DeliveryReference>>(
            "zerotrust.deliveryNotes.references",
        )
}
async fn prepare(
    state: &AppState,
    ctx: &RequestContext,
    input: DeliveryInitializeInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    current(&guard, &input.generation, &input.policy_version)?;
    verify(
        &guard.signing_key,
        &input.proof,
        &frame(
            "sortsys/delivery-initialize/v1",
            &[
                &auth.tenant,
                &guard.subject,
                &input.generation,
                &input.policy_version,
            ],
        ),
    )?;
    initialize(&mut tx, &guard.root.phase).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn allocate(
    state: &AppState,
    ctx: &RequestContext,
    input: DeliveryAllocateInput,
) -> RpcResult<DeliveryAllocation> {
    if input.project_id.0 <= 0 {
        return Err(invalid());
    }
    request_id(&input.request_id)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    current(&guard, &input.generation, &input.policy_version)?;
    authorize(&guard, input.project_id, Action::Create)?;
    verify(
        &guard.signing_key,
        &input.proof,
        &frame(
            "sortsys/delivery-allocate/v1",
            &[
                &auth.tenant,
                &guard.subject,
                &input.project_id.encode(),
                &input.request_id,
                &input.generation,
                &input.policy_version,
            ],
        ),
    )?;
    domain_lock(&mut tx, &area(input.project_id, false).0, false).await?;
    let available: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_domains WHERE id=$1 AND scope=$2 AND facet='contract-quantities' AND rotation_required=FALSE)")
        .bind(area(input.project_id, false).0).bind(area(input.project_id, false).1).fetch_one(&mut *tx).await.map_err(internal)?;
    if !available {
        return Err(conflict());
    }
    let initialized: bool = sqlx::query_scalar(
        "SELECT initialized FROM __zerotrust_delivery_state WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if !initialized {
        return Err(conflict());
    }
    let old: Option<(i64, i64, i64)> = sqlx::query_as("SELECT id,project_id,number FROM __zerotrust_delivery_allocations WHERE author=$1 AND request_id=$2").bind(&guard.subject).bind(&input.request_id).fetch_optional(&mut *tx).await.map_err(internal)?;
    if let Some((id, project, number)) = old {
        if project != input.project_id.0 {
            return Err(conflict());
        }
        return Ok(DeliveryAllocation {
            id: Id(id),
            project_id: Id(project),
            number: number.to_string(),
        });
    }
    let number: i64 = sqlx::query_scalar("UPDATE __zerotrust_delivery_state SET last_number=last_number+1 WHERE singleton AND last_number<9007199254740991 RETURNING last_number").fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(conflict)?;
    let id: i64 = sqlx::query_scalar("INSERT INTO __zerotrust_delivery_allocations(project_id,number,author,request_id) VALUES($1,$2,$3,$4) RETURNING id").bind(input.project_id.0).bind(number).bind(&guard.subject).bind(input.request_id).fetch_one(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(DeliveryAllocation {
        id: Id(id),
        project_id: input.project_id,
        number: number.to_string(),
    })
}
async fn locate(
    state: &AppState,
    ctx: &RequestContext,
    input: DeliveryLocateInput,
) -> RpcResult<DeliveryAllocation> {
    let number = input
        .number
        .as_deref()
        .map(|value| {
            let number: i64 = value.parse().map_err(|_| invalid())?;
            if number <= 0 || number.to_string() != value {
                return Err(invalid());
            }
            Ok(number)
        })
        .transpose()?;
    if input.id.is_some() == number.is_some() || input.id.is_some_and(|id| id.0 <= 0) {
        return Err(invalid());
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let row: Option<(i64,i64,i64)> = sqlx::query_as("SELECT id,project_id,number FROM __zerotrust_delivery_allocations WHERE ($1::bigint IS NOT NULL AND id=$1) OR ($2::bigint IS NOT NULL AND number=$2)")
        .bind(input.id.map(|id| id.0)).bind(number).fetch_optional(&mut *tx).await.map_err(internal)?;
    let (id, project, number) = row.ok_or_else(not_found)?;
    authorize(&guard, Id(project), Action::Read)?;
    let published:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_objects WHERE id=$1 AND domain_id=$2 AND deleted_at IS NULL)")
        .bind(format!("delivery-note:{}:{}",Id(project).encode(),Id(id).encode())).bind(area(Id(project),false).0).fetch_one(&mut *tx).await.map_err(internal)?;
    if !published {
        return Err(not_found());
    }
    Ok(DeliveryAllocation {
        id: Id(id),
        project_id: Id(project),
        number: number.to_string(),
    })
}
async fn references(
    state: &AppState,
    ctx: &RequestContext,
    input: DeliveryReferencesInput,
) -> RpcResult<Vec<DeliveryReference>> {
    if input.objects.is_empty()
        || input.objects.len() > 64
        || input.objects.iter().collect::<BTreeSet<_>>().len() != input.objects.len()
    {
        return Err(invalid());
    }
    let selected = input
        .objects
        .iter()
        .map(|object| binding(object)?.ok_or_else(invalid))
        .collect::<RpcResult<Vec<_>>>()?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    for b in &selected {
        if !matches!(b.kind, Kind::Note) {
            return Err(invalid());
        }
        authorize(&guard, b.project, Action::Read)?;
    }
    let ids = selected
        .iter()
        .map(|b| b.note.unwrap().0)
        .collect::<Vec<_>>();
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT id,project_id,number FROM __zerotrust_delivery_allocations WHERE id=ANY($1)",
    )
    .bind(ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(internal)?;
    let by_id = rows
        .into_iter()
        .map(|(id, p, n)| (id, (p, n)))
        .collect::<std::collections::BTreeMap<_, _>>();
    input
        .objects
        .into_iter()
        .zip(selected)
        .map(|(object, b)| {
            let note = b.note.ok_or_else(invalid)?;
            let (project, number) = by_id.get(&note.0).ok_or_else(conflict)?;
            if *project != b.project.0 {
                return Err(conflict());
            }
            Ok(DeliveryReference {
                object,
                allocation: DeliveryAllocation {
                    id: note,
                    project_id: b.project,
                    number: number.to_string(),
                },
            })
        })
        .collect()
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
