//! Shared numbering and immutable allocation receipts in the tenant file.
use super::{
    Binding, DeliveryAdoptionInput, DeliveryAllocateInput, DeliveryAllocation,
    DeliveryInitializeInput, DeliveryLocateInput, DeliveryReference, DeliveryReferencesInput, Kind,
    area, authorize, binding, current, request_id,
};
use crate::{
    api::Success,
    auth::AuthService,
    control::{Transaction, key},
    error::{ErrorCode, RpcResult},
    error::{forbidden, internal, not_found},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
    zerotrust::{
        access::{MetadataContext, metadata_context},
        crypto::{frame, invalid, verify},
        objects::{SaveInput, conflict, persistence as objects, registry},
    },
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

const MAX_NUMBER: u64 = 9_007_199_254_740_991;
#[derive(Deserialize, Serialize)]
struct Counter {
    number: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Allocation {
    id: i64,
    project: i64,
    number: u64,
    author: String,
    request: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}
impl Allocation {
    fn result(&self) -> RpcResult<DeliveryAllocation> {
        if self.id <= 0 || self.project <= 0 || self.number == 0 || self.number > MAX_NUMBER {
            return Err(invalid());
        }
        request_id(&self.request)?;
        Ok(DeliveryAllocation {
            id: Id(self.id),
            project_id: Id(self.project),
            number: self.number.to_string(),
        })
    }
}
fn allocation_key(id: Id) -> sortsys_zerotrust::metadata::RecordKey {
    key("delivery-allocations", &id.encode())
}
fn request_key(subject: &str, request: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key("delivery-requests", &format!("{subject}:{request}"))
}
async fn read(transaction: &mut Transaction, id: Id) -> RpcResult<Allocation> {
    let record: Allocation = transaction
        .read(allocation_key(id))
        .await?
        .ok_or_else(not_found)?;
    record.result()?;
    if record.id != id.0 {
        return Err(invalid());
    }
    Ok(record)
}
async fn random_id(transaction: &mut Transaction) -> RpcResult<Id> {
    for _ in 0..8 {
        let mut random = [0; 8];
        getrandom::fill(&mut random).map_err(internal)?;
        let id = Id((u64::from_le_bytes(random) & i64::MAX as u64) as i64);
        if id.0 > 0
            && transaction
                .read::<Allocation>(allocation_key(id))
                .await?
                .is_none()
        {
            return Ok(id);
        }
    }
    Err(conflict())
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let initialize = Arc::clone(&service);
    let allocate = Arc::clone(&service);
    let lookup = Arc::clone(&service);
    let adoption = Arc::clone(&service);
    builder
        .mutation(
            "zerotrust.deliveryNotes.initialize",
            move |ctx, input: DeliveryInitializeInput| {
                let service = Arc::clone(&initialize);
                async move { prepare(&service, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.deliveryNotes.adopt",
            move |ctx, input: DeliveryAdoptionInput| {
                let service = Arc::clone(&adoption);
                async move { adopt(&service, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.deliveryNotes.allocate",
            move |ctx, input: DeliveryAllocateInput| {
                let service = Arc::clone(&allocate);
                async move { allocate_note(&service, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.deliveryNotes.locate",
            move |ctx, input: DeliveryLocateInput| {
                let service = Arc::clone(&lookup);
                async move { locate(&service, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.deliveryNotes.references",
            move |ctx, input: DeliveryReferencesInput| {
                let service = Arc::clone(&service);
                async move { references(&service, &ctx, input).await }
            },
        )
}
async fn prepare(
    service: &AuthService,
    request: &RequestContext,
    input: DeliveryInitializeInput,
) -> RpcResult<Success> {
    let mut context = metadata_context(service, request).await?;
    if !context.auth.is_admin() {
        return Err(forbidden());
    }
    current(&context.security, &input.generation, &input.policy_version)?;
    verify(
        &context.security.signing_key,
        &input.proof,
        &frame(
            "sortsys/delivery-initialize/v1",
            &[
                &context.auth.tenant,
                &context.security.subject,
                &input.generation,
                &input.policy_version,
            ],
        ),
    )?;
    let counter = key("delivery-state", "current");
    if let Some(current) = context.transaction.read::<Counter>(counter.clone()).await? {
        if current.number > MAX_NUMBER {
            return Err(invalid());
        }
        context.transaction.validate().await?;
    } else {
        context
            .transaction
            .put(counter, &Counter { number: 0 })
            .await?;
        context.transaction.commit().await?;
    }
    Ok(Success { success: true })
}

async fn adopt(
    service: &AuthService,
    request: &RequestContext,
    input: DeliveryAdoptionInput,
) -> RpcResult<Success> {
    if input.allocations.is_empty() || input.allocations.len() > 64 {
        return Err(invalid());
    }
    let mut context = metadata_context(service, request).await?;
    super::super::bootstrap::require_pending_context(&mut context, &input.context).await?;
    current(&context.security, &input.generation, &input.policy_version)?;
    let mut fields = vec![
        context.auth.tenant.clone(),
        context.security.subject.clone(),
        input.context.clone(),
        input.generation.clone(),
        input.policy_version.clone(),
        input.allocations.len().to_string(),
    ];
    let mut ids = BTreeSet::new();
    let mut numbers = BTreeSet::new();
    for allocation in &input.allocations {
        if allocation.id.0 <= 0 || allocation.project_id.0 <= 0 || !ids.insert(allocation.id.0) {
            return Err(invalid());
        }
        let number = allocation.number.parse::<u64>().map_err(|_| invalid())?;
        if number == 0
            || number > MAX_NUMBER
            || number.to_string() != allocation.number
            || !numbers.insert(number)
        {
            return Err(invalid());
        }
        fields.extend([
            allocation.id.encode(),
            allocation.project_id.encode(),
            allocation.number.clone(),
        ]);
    }
    let borrowed = fields.iter().map(String::as_str).collect::<Vec<_>>();
    verify(
        &context.security.authority,
        &input.proof,
        &frame("sortsys/delivery-adopt/v1", &borrowed),
    )?;
    let counter_key = key("delivery-state", "current");
    let mut counter: Counter = context
        .transaction
        .read(counter_key.clone())
        .await?
        .ok_or_else(conflict)?;
    let mut changed = false;
    for value in &input.allocations {
        let number = value.number.parse::<u64>().map_err(|_| invalid())?;
        let number_key = key("delivery-numbers", &value.number);
        let existing: Option<Allocation> =
            context.transaction.read(allocation_key(value.id)).await?;
        let reserved: Option<Id> = context.transaction.read(number_key.clone()).await?;
        if reserved.is_some_and(|id| id.0 != value.id.0) {
            return Err(conflict());
        }
        if let Some(existing) = existing {
            if existing.id != value.id.0
                || existing.project != value.project_id.0
                || existing.number != number
                || existing.source.as_deref() != Some(input.context.as_str())
                || reserved.is_none()
            {
                return Err(conflict());
            }
            continue;
        }
        let allocation = Allocation {
            id: value.id.0,
            project: value.project_id.0,
            number,
            author: context.security.subject.clone(),
            request: format!("backup_restore_{}", value.id.encode()),
            source: Some(input.context.clone()),
        };
        allocation.result()?;
        context
            .transaction
            .put(allocation_key(value.id), &allocation)
            .await?;
        context.transaction.put(number_key, &value.id).await?;
        counter.number = counter.number.max(number);
        changed = true;
    }
    if changed {
        context.transaction.put(counter_key, &counter).await?;
        context.transaction.commit().await?;
    } else {
        context.transaction.validate().await?;
    }
    Ok(Success { success: true })
}

async fn allocate_note(
    service: &AuthService,
    request: &RequestContext,
    input: DeliveryAllocateInput,
) -> RpcResult<DeliveryAllocation> {
    if input.project_id.0 <= 0 {
        return Err(invalid());
    }
    request_id(&input.request_id)?;
    for _ in 0..32 {
        if let Some(allocation) = allocation_attempt(service, request, &input).await? {
            return Ok(allocation);
        }
        // Independent writers only retry a failed publication CAS. Invalid
        // proofs, changed permissions and stale generations return directly.
        let mut jitter = [0; 1];
        getrandom::fill(&mut jitter).map_err(internal)?;
        tokio::time::sleep(std::time::Duration::from_millis(
            1 + u64::from(jitter[0] % 5),
        ))
        .await;
    }
    Err(conflict())
}
async fn allocation_attempt(
    service: &AuthService,
    request: &RequestContext,
    input: &DeliveryAllocateInput,
) -> RpcResult<Option<DeliveryAllocation>> {
    let mut context = metadata_context(service, request).await?;
    current(&context.security, &input.generation, &input.policy_version)?;
    authorize(&context.security, input.project_id, super::Action::Create)?;
    verify(
        &context.security.signing_key,
        &input.proof,
        &frame(
            "sortsys/delivery-allocate/v1",
            &[
                &context.auth.tenant,
                &context.security.subject,
                &input.project_id.encode(),
                &input.request_id,
                &input.generation,
                &input.policy_version,
            ],
        ),
    )?;
    let domain =
        registry::domain(&mut context.transaction, &area(input.project_id, false).0).await?;
    let mut rotations = registry::RotationChecks::new(&context.security);
    let (_, expected_scope, expected_facet) = area(input.project_id, false);
    if domain.scope != expected_scope
        || domain.facet != expected_facet
        || rotations
            .required(&mut context.transaction, &context.security, &domain)
            .await?
    {
        return Err(conflict());
    }
    let receipt = request_key(&context.security.subject, &input.request_id);
    if let Some(id) = context.transaction.read::<Id>(receipt.clone()).await? {
        let existing = read(&mut context.transaction, id).await?;
        if existing.project != input.project_id.0
            || existing.author != context.security.subject
            || existing.request != input.request_id
        {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(Some(existing.result()?));
    }
    let counter_key = key("delivery-state", "current");
    let mut counter: Counter = context
        .transaction
        .read(counter_key.clone())
        .await?
        .ok_or_else(conflict)?;
    counter.number = counter
        .number
        .checked_add(1)
        .filter(|number| *number <= MAX_NUMBER)
        .ok_or_else(conflict)?;
    let id = random_id(&mut context.transaction).await?;
    let allocation = Allocation {
        id: id.0,
        project: input.project_id.0,
        number: counter.number,
        author: context.security.subject.clone(),
        request: input.request_id.clone(),
        source: None,
    };
    let number_key = key("delivery-numbers", &allocation.number.to_string());
    if context
        .transaction
        .read::<Id>(number_key.clone())
        .await?
        .is_some()
    {
        // A competing API may have published after the counter read. Distinguish
        // that normal CAS race from a genuinely inconsistent persisted counter.
        return match context.transaction.validate().await {
            Err(error) if error.code == ErrorCode::Conflict => Ok(None),
            Err(error) => Err(error),
            Ok(()) => Err(invalid()),
        };
    }
    context.transaction.put(counter_key, &counter).await?;
    context
        .transaction
        .put(allocation_key(id), &allocation)
        .await?;
    context.transaction.put(number_key, &id).await?;
    context.transaction.put(receipt, &id).await?;
    match context.transaction.commit().await {
        Ok(_) => Ok(Some(allocation.result()?)),
        Err(error) if error.code == ErrorCode::Conflict => Ok(None),
        Err(error) => Err(error),
    }
}
async fn locate(
    service: &AuthService,
    request: &RequestContext,
    input: DeliveryLocateInput,
) -> RpcResult<DeliveryAllocation> {
    if input.id.is_some() == input.number.is_some() || input.id.is_some_and(|id| id.0 <= 0) {
        return Err(invalid());
    }
    let mut context = metadata_context(service, request).await?;
    let id = if let Some(id) = input.id {
        id
    } else {
        let value = input.number.ok_or_else(invalid)?;
        let number: u64 = value.parse().map_err(|_| invalid())?;
        if number == 0 || number > MAX_NUMBER || number.to_string() != value {
            return Err(invalid());
        }
        context
            .transaction
            .read(key("delivery-numbers", &value))
            .await?
            .ok_or_else(not_found)?
    };
    let allocation = read(&mut context.transaction, id).await?;
    authorize(
        &context.security,
        Id(allocation.project),
        super::Action::Read,
    )?;
    if input.include_deleted == Some(true) {
        authorize(
            &context.security,
            Id(allocation.project),
            super::Action::Delete,
        )?;
    }
    let note = format!(
        "delivery-note:{}:{}",
        Id(allocation.project).encode(),
        id.encode()
    );
    let record = objects::object(&mut context.transaction, &note)
        .await?
        .ok_or_else(not_found)?;
    if record.deleted
        || (record.tombstone && input.include_deleted != Some(true))
        || record.domain != area(Id(allocation.project), false).0
    {
        return Err(not_found());
    }
    context.transaction.validate().await?;
    allocation.result()
}
async fn references(
    service: &AuthService,
    request: &RequestContext,
    input: DeliveryReferencesInput,
) -> RpcResult<Vec<DeliveryReference>> {
    if input.objects.is_empty()
        || input.objects.len() > 64
        || input.objects.iter().collect::<BTreeSet<_>>().len() != input.objects.len()
    {
        return Err(invalid());
    }
    let mut context = metadata_context(service, request).await?;
    let mut result = Vec::new();
    for object in input.objects {
        let selected = binding(&object)?.ok_or_else(invalid)?;
        if !matches!(selected.kind, Kind::Note) {
            return Err(invalid());
        }
        authorize(&context.security, selected.project, super::Action::Read)?;
        let allocation = read(&mut context.transaction, selected.note.ok_or_else(invalid)?).await?;
        if allocation.project != selected.project.0 {
            return Err(conflict());
        }
        result.push(DeliveryReference {
            object,
            allocation: allocation.result()?,
        });
    }
    context.transaction.validate().await?;
    Ok(result)
}

pub(super) async fn validate_packet(
    context: &mut MetadataContext,
    input: &SaveInput,
) -> RpcResult<()> {
    let Some(Binding {
        project,
        note,
        kind,
    }) = binding(&input.envelope.object)?
    else {
        return Ok(());
    };
    let (domain, scope, facet) = area(project, matches!(kind, Kind::Price));
    if input.domain != domain || input.envelope.scope != scope || input.envelope.facet != facet {
        return Err(invalid());
    }
    if !context.security.allows(
        &context.security.subject,
        &scope,
        facet,
        super::Action::Read,
    ) {
        return Err(forbidden());
    }
    if let Some(note) = note {
        let allocation = read(&mut context.transaction, note).await?;
        if allocation.project != project.0 {
            return Err(conflict());
        }
        if matches!(kind, Kind::Price) {
            let object = format!("delivery-note:{}:{}", project.encode(), note.encode());
            let parent = objects::raw_object(&mut context.transaction, &object).await?;
            if !parent.is_some_and(|record| {
                !record.deleted && !record.tombstone && record.domain == area(project, false).0
            }) {
                return Err(conflict());
            }
        }
        if input.envelope.revision == "1"
            && let Some(source) = &allocation.source
        {
            if input.migration_origin.is_none() {
                return Err(forbidden());
            }
            super::super::bootstrap::require_pending_context(context, source).await?;
        }
        if input.envelope.revision == "1" && allocation.author != context.security.subject {
            let object = format!("delivery-note:{}:{}", project.encode(), note.encode());
            let existing = objects::object(&mut context.transaction, &object).await?;
            let published = existing
                .is_some_and(|record| !record.deleted && record.domain == area(project, false).0);
            if allocation.source.is_none() && (matches!(kind, Kind::Note) || !published) {
                return Err(forbidden());
            }
        }
    } else {
        let prefix = format!("delivery-create:{}:", project.encode());
        let suffix = input
            .envelope
            .object
            .strip_prefix(&prefix)
            .ok_or_else(invalid)?;
        let (actor, request) = suffix.split_once(':').ok_or_else(invalid)?;
        if context.security.subject != format!("user:{actor}") || input.envelope.revision != "1" {
            return Err(forbidden());
        }
        let id: Id = context
            .transaction
            .read(request_key(&context.security.subject, request))
            .await?
            .ok_or_else(conflict)?;
        let allocation = read(&mut context.transaction, id).await?;
        if allocation.project != project.0
            || allocation.author != context.security.subject
            || allocation.request != request
        {
            return Err(conflict());
        }
    }
    Ok(())
}

/// The signed note head controls the visibility of its private prices. Deletion
/// therefore needs neither a price key nor permission to rewrite cost contents.
pub(super) async fn apply_visibility(
    transaction: &mut Transaction,
    records: &mut [objects::ObjectRecord],
) -> RpcResult<()> {
    let mut selected = Vec::new();
    let mut parents = Vec::new();
    for (index, record) in records.iter().enumerate() {
        if record.deleted {
            continue;
        }
        let Some(selected_binding) = binding(&record.object)? else {
            continue;
        };
        if !matches!(selected_binding.kind, Kind::Price) {
            continue;
        }
        let note = selected_binding.note.ok_or_else(invalid)?;
        let domain = area(selected_binding.project, false).0;
        let object = format!(
            "delivery-note:{}:{}",
            selected_binding.project.encode(),
            note.encode()
        );
        parents.push(objects::record_key(&domain, &object));
        selected.push((index, domain, object));
    }
    let states = transaction.many::<objects::ObjectRecord>(parents).await?;
    for ((index, domain, object), parent) in selected.into_iter().zip(states) {
        if let Some(parent) = parent {
            if parent.domain != domain || parent.object != object {
                return Err(invalid());
            }
            records[index].deleted = parent.deleted || parent.tombstone;
        } else {
            records[index].deleted = true;
        }
    }
    Ok(())
}
