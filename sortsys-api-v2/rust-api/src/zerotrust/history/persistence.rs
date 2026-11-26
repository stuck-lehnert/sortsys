//! Authorized historical ciphertext, addressed by immutable shared journal IDs.
use super::super::{
    access::{MetadataContext, metadata_context, metadata_context_for_domains},
    objects::{
        ChangeRecord, DomainDescriptor, metadata_catalog, metadata_check_read, metadata_has_key,
        metadata_journal_id, metadata_raw_object, metadata_read,
    },
};
use super::*;
use crate::{auth::AuthService, control::key};
use sortsys_zerotrust::journal::{JournalEntry, JournalQuery};
use std::collections::{BTreeMap, BTreeSet};

fn recorded(entry: &JournalEntry) -> RpcResult<ChangeRecord> {
    let change: ChangeRecord = serde_json::from_str(&entry.entry.value).map_err(|_| invalid())?;
    if entry.entry.stream != change.object.domain
        || entry.entry.object != change.object.object
        || entry.entry.occurred_micros != change.occurred_micros
        || change.deletion.is_some() != change.references.is_some()
    {
        return Err(invalid());
    }
    Ok(change)
}
fn allowed(guard: &Security, area: &DomainDescriptor) -> RpcResult<()> {
    if !guard.allows(&guard.subject, &area.scope, area.facet, Action::Read) {
        return Err(forbidden());
    }
    Ok(())
}

fn initial_publication(row: ChangeRecord, stream: &str, object: &str) -> RpcResult<String> {
    if row.object.object != object
        || row.object.revision != "1"
        || row.object.domain != stream
        || row.deletion.is_some()
        || row.previous.is_some()
    {
        return Err(invalid());
    }

    Ok(row.publication)
}

async fn first_publications(
    context: &MetadataContext,
    entries: &[JournalEntry],
) -> RpcResult<BTreeMap<(String, String), String>> {
    let objects = entries
        .iter()
        .map(|entry| (entry.entry.stream.clone(), entry.entry.object.clone()))
        .collect::<BTreeSet<_>>();
    if objects.is_empty() {
        return Ok(BTreeMap::new());
    }
    let first = context
        .repository
        .journal_origins(
            objects
                .iter()
                .map(|(stream, object)| key(stream, object))
                .collect(),
        )
        .await?;
    if first.len() != objects.len() {
        return Err(invalid());
    }
    objects
        .into_iter()
        .zip(first)
        .map(|((stream, object), first)| {
            let first = first.ok_or_else(invalid)?;
            let publication = initial_publication(recorded(&first)?, &stream, &object)?;
            Ok(((stream, object), publication))
        })
        .collect()
}
async fn change(
    context: &mut MetadataContext,
    area: &DomainDescriptor,
    entry: JournalEntry,
    initial_publication: String,
) -> RpcResult<Option<Change>> {
    allowed(&context.security, area)?;
    let row = recorded(&entry)?;
    if row.object.domain != area.id {
        return Err(invalid());
    }
    if !super::super::commercial_links::hidden_objects(
        &mut context.transaction,
        std::slice::from_ref(&row.object),
    )
    .await?
    .is_empty()
    {
        return Ok(None);
    }

    let envelope = metadata_read(&context.repository, &row.object.reference).await?;
    metadata_check_read(
        &envelope,
        &row.object,
        &context.auth.tenant,
        &area.scope,
        area.facet,
    )?;
    if !metadata_has_key(
        &mut context.transaction,
        &area.id,
        &envelope.generation,
        &context.security.subject,
    )
    .await?
    {
        return Ok(None);
    }
    let mut previous = None;
    if let Some(reference) = row.previous {
        let before = metadata_read(&context.repository, &reference).await?;
        if before.object != envelope.object
            || before.tenant != envelope.tenant
            || before.scope != envelope.scope
            || before.facet != envelope.facet
            || revision(&before.revision)?.checked_add(1) != Some(revision(&envelope.revision)?)
        {
            return Err(invalid());
        }
        if metadata_has_key(
            &mut context.transaction,
            &area.id,
            &before.generation,
            &context.security.subject,
        )
        .await?
        {
            previous = Some(before);
        }
    }
    let micros = sortsys_zerotrust::journal::instant(&row.occurred_micros)?;
    let occurred_at = DateTime::from_timestamp_micros(micros).ok_or_else(invalid)?;
    Ok(Some(Change {
        access: Access::for_guard(&context.security),
        sequence: entry.sequence,
        order_id: entry.order,
        publication: row.publication,
        initial_publication,
        domain: area.id.clone(),
        envelope,
        previous,
        migration_origin: row.migration_origin,
        deletion: row.deletion,
        references: row.references,
        occurred_at,
        occurred_micros: row.occurred_micros,
    }))
}
async fn list(service: &AuthService, request: &RequestContext, input: List) -> RpcResult<Page> {
    let mut context = metadata_context(service, request).await?;
    let areas = metadata_catalog(&mut context.transaction, |area| {
        allowed(&context.security, area).is_ok()
    })
    .await?
    .into_iter()
    .map(|area| (area.id.clone(), area))
    .collect::<BTreeMap<_, _>>();
    let query = JournalQuery {
        streams: areas.keys().cloned().collect(),
        prefixes: input.prefixes,
        before: input.before,
        snapshot: input.snapshot,
        known: input.known,
        known_total: input.known_total,
        limit: 16,
    };
    query.validate()?;
    let page = context.repository.journal_list(query).await?;
    let first = first_publications(&context, &page.entries).await?;
    let mut after = page.after;
    let mut after_micros = page.after_micros;
    let mut after_order = page.after_order;
    let mut changes = Vec::new();
    let mut bytes = 0usize;
    let mut scanned: Option<(String, String, String)> = None;
    for entry in page.entries {
        let cursor = (
            entry.sequence.clone(),
            entry.entry.occurred_micros.clone(),
            entry.order.clone(),
        );
        let area = areas.get(&entry.entry.stream).ok_or_else(invalid)?;
        let initial = first
            .get(&(entry.entry.stream.clone(), entry.entry.object.clone()))
            .ok_or_else(invalid)?;
        if let Some(value) = change(&mut context, area, entry, initial.clone()).await? {
            let size = value.envelope.ciphertext.len()
                + value
                    .previous
                    .as_ref()
                    .map(|previous| previous.ciphertext.len())
                    .unwrap_or(0);
            if bytes + size > 8 * 1024 * 1024 && !changes.is_empty() {
                let (sequence, micros, order) = scanned.ok_or_else(invalid)?;
                after = Some(sequence);
                after_micros = Some(micros);
                after_order = Some(order);
                break;
            }
            bytes += size;
            changes.push(value);
        }
        scanned = Some(cursor);
    }
    let access = Access::for_guard(&context.security);
    context.transaction.validate().await?;
    Ok(Page {
        access,
        current: page.current,
        total: page.total,
        snapshot: page.snapshot,
        after,
        after_micros,
        after_order,
        unchanged: page.unchanged,
        changes,
    })
}
async fn get(
    service: &AuthService,
    request: &RequestContext,
    input: Get,
) -> RpcResult<Option<Change>> {
    identifier(&input.id)?;
    if let Some(version) = &input.revision {
        revision(version)?;
    }

    let mut context = metadata_context_for_domains(service, request, Some(&[])).await?;
    let Some(record) = metadata_raw_object(&mut context.transaction, &input.id).await? else {
        context.transaction.validate().await?;
        return Ok(None);
    };
    let area: DomainDescriptor = context
        .transaction
        .read(key("domain-catalog", &record.domain))
        .await?
        .ok_or_else(invalid)?;
    if area.id != record.domain {
        return Err(invalid());
    }

    context.select_creation_for(&area.scope, area.facet).await?;
    allowed(&context.security, &area)?;

    let id: Option<String> = if input.revision.is_none() && record.deleted {
        context
            .transaction
            .read(key("object-deletions", &input.id))
            .await?
    } else {
        let version = input.revision.as_deref().unwrap_or(&record.revision);
        context
            .transaction
            .read(key(
                "object-history",
                &format!("{}:{:020}", input.id, revision(version)?),
            ))
            .await?
            .map(|message: String| metadata_journal_id(&message))
    };
    let result = if let Some(id) = id {
        let origins = context
            .repository
            .journal_origins(vec![key(&area.id, &input.id)])
            .await?;
        let [Some(origin)]: [Option<JournalEntry>; 1] =
            origins.try_into().map_err(|_| invalid())?
        else {
            return Err(invalid());
        };
        let initial = initial_publication(recorded(&origin)?, &area.id, &input.id)?;

        // A read of the creation event needs only the origin lookup. A
        // different indexed publication must still use its own journal entry.
        let entry = if origin.entry.id == id {
            origin
        } else {
            context
                .repository
                .journal_get(&area.id, &id)
                .await?
                .ok_or_else(invalid)?
        };

        let row = recorded(&entry)?;
        if entry.entry.id != id
            || row.object.object != input.id
            || input
                .revision
                .as_ref()
                .is_some_and(|revision| *revision != row.object.revision || row.deletion.is_some())
        {
            return Err(invalid());
        }

        change(&mut context, &area, entry, initial).await?
    } else {
        None
    };
    context.transaction.validate().await?;
    Ok(result)
}
pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let list_service = Arc::clone(&service);
    builder
        .query("zerotrust.history.list", move |ctx, input: List| {
            let service = Arc::clone(&list_service);
            async move { list(&service, &ctx, input).await }
        })
        .query("zerotrust.history.get", move |ctx, input: Get| {
            let service = Arc::clone(&service);
            async move { get(&service, &ctx, input).await }
        })
}
