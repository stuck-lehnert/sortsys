//! Atomic ciphertext references and versioned collections in the shared store.
use super::super::access::{
    MetadataContext, MetadataRequest, metadata_context, metadata_context_for_domains,
};
use super::*;
use crate::{
    auth::AuthService,
    control::{Repository, Transaction, key},
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct ObjectRecord {
    pub object: String,
    pub domain: String,
    pub revision: String,
    pub reference: String,
    pub deleted: bool,
    pub tombstone: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct ChangeRecord {
    pub object: ObjectRecord,
    pub previous: Option<String>,
    pub publication: String,
    pub occurred_micros: String,
    pub deletion: Option<Value>,
    pub references: Option<Value>,
    pub migration_origin: Option<super::super::history::MigrationOrigin>,
}
pub(super) fn collection(domain: &str) -> String {
    format!(
        "objects-{}",
        super::super::crypto::encode(&Sha256::digest(domain.as_bytes()))
    )
}
pub(in crate::zerotrust) async fn raw_object(
    transaction: &mut Transaction,
    id: &str,
) -> RpcResult<Option<ObjectRecord>> {
    identifier(id)?;
    let Some(domain) = transaction
        .read::<String>(key("object-locations", id))
        .await?
    else {
        return Ok(None);
    };
    let record: ObjectRecord = transaction
        .read(key(&collection(&domain), id))
        .await?
        .ok_or_else(invalid)?;
    if record.object != id || record.domain != domain {
        return Err(invalid());
    }
    Ok(Some(record))
}
pub(in crate::zerotrust) fn record_key(
    domain: &str,
    object: &str,
) -> sortsys_zerotrust::metadata::RecordKey {
    key(&collection(domain), object)
}
pub(in crate::zerotrust) async fn object(
    transaction: &mut Transaction,
    id: &str,
) -> RpcResult<Option<ObjectRecord>> {
    let Some(record) = raw_object(transaction, id).await? else {
        return Ok(None);
    };
    let mut records = vec![record];
    super::super::stock::metadata_apply_visibility(transaction, &mut records).await?;
    super::super::delivery::metadata_apply_visibility(transaction, &mut records).await?;
    Ok(records.pop())
}
pub(in crate::zerotrust) async fn read(
    repository: &Repository,
    reference: &str,
) -> RpcResult<EncryptedObject> {
    let data = repository.ciphertext(reference).await?;
    let envelope: EncryptedObject = serde_json::from_str(&data).map_err(|_| invalid())?;
    envelope.frame()?;
    Ok(envelope)
}
fn encoded(envelope: &EncryptedObject) -> RpcResult<String> {
    Ok(serde_json::to_value(envelope)
        .map_err(internal)?
        .to_string())
}
fn reference(envelope: &EncryptedObject) -> RpcResult<String> {
    Ok(crate::quack_store::content_id(&encoded(envelope)?))
}
pub(in crate::zerotrust) fn journal_id(message_id: &str) -> String {
    format!(
        "object:{}",
        super::super::crypto::encode(&Sha256::digest(message_id.as_bytes()))
    )
}
fn history_key(
    object: &str,
    revision_number: &str,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    Ok(key(
        "object-history",
        &format!("{object}:{:020}", revision(revision_number)?),
    ))
}
pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let get = Arc::clone(&service);
    let list = Arc::clone(&service);
    let pages = Arc::clone(&service);
    let save = Arc::clone(&service);
    builder
        .query("zerotrust.objects.get", move |ctx, input: IdInput| {
            let service = Arc::clone(&get);
            async move {
                let mut request = MetadataRequest::open(&service, &ctx).await?;
                let record = object(&mut request.transaction, &input.id)
                    .await?
                    .filter(|record| !record.deleted)
                    .ok_or_else(not_found)?;
                let mut context = request
                    .authorize(Some(std::slice::from_ref(&record.domain)))
                    .await?;
                let area = registry::domain(&mut context.transaction, &record.domain).await?;
                require_read(&context.security, &area)?;
                let envelope = read(&context.repository, &record.reference).await?;
                check_read(
                    &envelope,
                    &record,
                    &context.auth.tenant,
                    &area.scope,
                    area.facet,
                )?;
                context.transaction.validate().await?;
                Ok(envelope)
            }
        })
        .query("zerotrust.objects.list", move |ctx, input: ListInput| {
            let service = Arc::clone(&list);
            async move { list_objects(&service, &ctx, input).await }
        })
        .query(
            "zerotrust.objects.pages",
            move |ctx, input: ListBatchInput| {
                let service = Arc::clone(&pages);
                async move { list_object_pages(&service, &ctx, input).await }
            },
        )
        .mutation("zerotrust.objects.save", move |ctx, input: SaveInput| {
            let service = Arc::clone(&save);
            async move {
                commit_batch(
                    &service,
                    &ctx,
                    BatchInput {
                        objects: vec![input],
                        heads: None,
                        documents: None,
                        live_checkpoints: None,
                        member: None,
                        policy: None,
                    },
                )
                .await?;
                Ok(Success { success: true })
            }
        })
        .mutation("zerotrust.objects.batch", move |ctx, input: BatchInput| {
            let service = Arc::clone(&service);
            async move { commit_batch(&service, &ctx, input).await }
        })
}
fn require_read(guard: &Security, area: &registry::DomainRecord) -> RpcResult<()> {
    if !guard.allows(&guard.subject, &area.scope, area.facet, Action::Read) {
        return Err(forbidden());
    }
    Ok(())
}
pub(in crate::zerotrust) fn check_read(
    envelope: &EncryptedObject,
    record: &ObjectRecord,
    tenant: &str,
    scope: &str,
    facet: Facet,
) -> RpcResult<()> {
    if envelope.object != record.object
        || envelope.tenant != tenant
        || envelope.scope != scope
        || envelope.facet != facet
        || envelope.revision != record.revision
        || envelope.is_tombstone() != record.tombstone
    {
        return Err(invalid());
    }
    Ok(())
}
async fn list_objects(
    service: &AuthService,
    request: &RequestContext,
    input: ListInput,
) -> RpcResult<ObjectPage> {
    validate_list_input(&input)?;
    let mut context =
        metadata_context_for_domains(service, request, Some(std::slice::from_ref(&input.domain)))
            .await?;
    let page = object_page(&mut context, input).await?;
    context.transaction.validate().await?;
    Ok(page)
}

fn validate_list_input(input: &ListInput) -> RpcResult<()> {
    identifier(&input.domain)?;
    identifier(&input.prefix)?;
    if input.head_only == Some(true) && input.snapshot.is_none() {
        return Err(invalid());
    }
    if let Some(after) = &input.after {
        identifier(after)?;
        if !after.starts_with(&input.prefix) || input.snapshot.is_none() {
            return Err(invalid());
        }
    }
    Ok(())
}

async fn list_object_pages(
    service: &AuthService,
    request: &RequestContext,
    input: ListBatchInput,
) -> RpcResult<Vec<ObjectPage>> {
    if input.selections.is_empty() || input.selections.len() > 16 {
        return Err(invalid());
    }
    for selection in &input.selections {
        validate_list_input(selection)?;
    }
    let domains = input
        .selections
        .iter()
        .map(|selection| selection.domain.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut context = metadata_context_for_domains(service, request, Some(&domains)).await?;
    let mut pages = Vec::with_capacity(input.selections.len());
    let mut bytes = 0usize;
    for selection in input.selections {
        let page = object_page(&mut context, selection).await?;
        bytes += serde_json::to_vec(&page).map_err(internal)?.len();
        if bytes > 32 * 1024 * 1024 {
            return Err(RpcError::new(
                ErrorCode::BadRequest,
                "Protected collection batch exceeds the response limit",
            )
            .with_http_code(413));
        }
        pages.push(page);
    }
    // Every page, key package and authorization record belongs to this same
    // verified read. A race discards the entire response, never just one page.
    context.transaction.validate().await?;
    Ok(pages)
}

async fn object_page(context: &mut MetadataContext, input: ListInput) -> RpcResult<ObjectPage> {
    let area = registry::domain(&mut context.transaction, &input.domain).await?;
    require_read(&context.security, &area)?;
    if input
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot != &area.sequence)
    {
        return Err(conflict());
    }
    if input.head_only == Some(true) {
        return Ok(ObjectPage {
            snapshot: area.sequence,
            key_generation: area.generation,
            objects: Vec::new(),
            recipient_access: Vec::new(),
            after: None,
            openings: None,
        });
    }
    let page = context
        .transaction
        .scan_prefix::<ObjectRecord>(&collection(&input.domain), &input.prefix, input.after, 32)
        .await?;
    let mut references = Vec::new();
    for row in page.records {
        let record = row.value.ok_or_else(invalid)?;
        if record.object != row.record.key || record.domain != input.domain {
            return Err(invalid());
        }
        references.push(record);
    }
    super::super::stock::metadata_apply_visibility(&mut context.transaction, &mut references)
        .await?;
    super::super::delivery::metadata_apply_visibility(&mut context.transaction, &mut references)
        .await?;
    references.retain(|record| !record.deleted);
    let mut objects = Vec::new();
    if !references.is_empty() {
        let data = context
            .repository
            .ciphertext_prefix(
                references
                    .iter()
                    .map(|record| record.reference.clone())
                    .collect(),
                16 * 1024 * 1024,
            )
            .await?;
        if data.is_empty() || data.len() > references.len() {
            return Err(invalid());
        }
        for (record, data) in references.iter().zip(data) {
            let envelope: EncryptedObject = serde_json::from_str(&data).map_err(|_| invalid())?;
            envelope.frame()?;
            check_read(
                &envelope,
                record,
                &context.auth.tenant,
                &area.scope,
                area.facet,
            )?;
            objects.push(envelope);
        }
    }
    let after = if objects.len() < references.len() {
        objects.last().map(|object| object.object.clone())
    } else {
        page.after
    };
    let openings = if input.include_openings == Some(true) {
        let mut openings = Vec::new();
        let mut bytes = 0usize;
        let generations = objects
            .iter()
            .map(|object| object.generation.clone())
            .collect::<BTreeSet<_>>();
        for generation in generations {
            let definition = registry::definition_at(
                &mut context.transaction,
                &context.security,
                &area,
                &generation,
            )
            .await?;
            let envelope: SealedBox = context
                .transaction
                .read(registry::envelope_key(
                    &area.id,
                    &generation,
                    &context.security.subject,
                )?)
                .await?
                .ok_or_else(forbidden)?;
            let opening = DomainOpening {
                key_authority: registry::key_authority_for_box(
                    &mut context.transaction,
                    &context.security,
                    &area,
                    &envelope,
                )
                .await?,
                generation,
                definition,
                envelope,
            };
            bytes += serde_json::to_vec(&opening).map_err(internal)?.len();
            if bytes > 8 * 1024 * 1024 {
                // Large historical key directories remain available through
                // the individual endpoints; opening a page never requires
                // copying an unbounded directory into its response.
                break;
            }
            openings.push(opening);
        }
        Some(openings)
    } else {
        None
    };
    let recipient_access =
        super::super::object_shares::states(&mut context.transaction, &objects).await?;
    Ok(ObjectPage {
        snapshot: area.sequence,
        key_generation: area.generation,
        objects,
        after,
        recipient_access,
        openings,
    })
}

pub(in crate::zerotrust) async fn commit_batch(
    service: &AuthService,
    request: &RequestContext,
    input: BatchInput,
) -> RpcResult<BatchResult> {
    commit_batch_inner(service, request, input, false).await
}

pub(in crate::zerotrust) async fn commit_staged_batch(
    service: &AuthService,
    request: &RequestContext,
    input: BatchInput,
) -> RpcResult<BatchResult> {
    commit_batch_inner(service, request, input, true).await
}

async fn commit_batch_inner(
    service: &AuthService,
    request: &RequestContext,
    input: BatchInput,
    preuploaded: bool,
) -> RpcResult<BatchResult> {
    let shape = validate_batch(&input, preuploaded)?;
    let mut guarded_domains = shape.domains.clone();
    for packet in &input.objects {
        if let Some(domain) = super::super::delivery::deletion_price_domain(packet)? {
            guarded_domains.insert(domain);
        }
    }
    if let Some(heads) = &input.heads {
        guarded_domains.extend(heads.iter().map(|head| head.domain.clone()));
    }
    for head in input.documents.as_deref().unwrap_or_default() {
        guarded_domains.extend(head.domains());
    }
    for proof in input.live_checkpoints.as_deref().unwrap_or_default() {
        let room = super::super::document_messages::Room {
            scope: proof.scope.clone(),
            document: proof.document.clone(),
            facet: proof.facet.clone(),
        };
        guarded_domains.extend(room.access_domains()?);
    }
    let domains = guarded_domains.iter().cloned().collect::<Vec<_>>();
    // A policy or membership change can affect areas outside this publication.
    // Ordinary writes only need the certified grants of their guarded domains.
    let mut context = if input.policy.is_some() || input.member.is_some() {
        metadata_context(service, request).await?
    } else {
        metadata_context_for_domains(service, request, Some(&domains)).await?
    };
    if preuploaded {
        let mut records = Vec::with_capacity(input.objects.len() * 4);
        for packet in &input.objects {
            records.push(key("object-locations", &packet.envelope.object));
            records.push(record_key(&packet.domain, &packet.envelope.object));
            records.push(key("object-changes", &packet.message_id));
            records.push(history_key(
                &packet.envelope.object,
                &packet.envelope.revision,
            )?);
        }
        context.transaction.prefetch(records).await?;
    }
    let checkpoints = super::super::live_checkpoints::persistence::prepare(
        &mut context,
        input.documents.as_deref().unwrap_or_default(),
        &input.objects,
        input.live_checkpoints.as_deref().unwrap_or_default(),
    )
    .await?;
    if let Some(policy) = &input.policy {
        if !context.auth.is_admin()
            || input
                .documents
                .as_ref()
                .is_some_and(|heads| !heads.is_empty())
        {
            return Err(forbidden());
        }
        policy_batch_binding(
            policy,
            &context.security.subject,
            &context.security.policy.signature,
            &input.objects,
            input.heads.as_deref().ok_or_else(invalid)?,
        )?;
    }
    if let Some(member) = &input.member {
        let changes_permissions = member.action != super::super::members::MemberAction::Rename;
        let has_documents = input
            .documents
            .as_ref()
            .is_some_and(|heads| !heads.is_empty());
        if has_documents || (changes_permissions && input.policy.is_some()) {
            return Err(invalid());
        }
    }
    let mut areas = BTreeMap::new();
    let mut rotation = registry::RotationChecks::new(&context.security);
    for domain in guarded_domains {
        let area = registry::domain(&mut context.transaction, &domain).await?;
        areas.insert(domain, area);
    }
    for scope in &shape.opaque_scopes {
        for facet in super::super::creation::COMMERCIAL_FACETS {
            let area = areas
                .get(&format!("{scope}:{}", facet.name()))
                .ok_or_else(invalid)?;
            if area.scope != *scope
                || area.facet != facet
                || rotation
                    .required(&mut context.transaction, &context.security, area)
                    .await?
            {
                return Err(conflict());
            }
            if !context
                .security
                .allows(&context.security.subject, scope, facet, Action::Read)
                || !context
                    .security
                    .allows(&context.security.subject, scope, facet, Action::Update)
            {
                return Err(forbidden());
            }
        }
    }
    let mut stale = false;
    if let Some(heads) = &input.heads {
        for head in heads {
            let area = areas.get(&head.domain).ok_or_else(invalid)?;
            require_read(&context.security, area)?;
            stale |= area.sequence != head.sequence;
        }
    }
    if stale {
        for packet in &input.objects {
            let current = object(&mut context.transaction, &packet.envelope.object)
                .await?
                .ok_or_else(conflict)?;
            if current.deleted
                || current.domain != packet.domain
                || current.revision != packet.envelope.revision
                || current.reference != reference(&packet.envelope)?
            {
                return Err(conflict());
            }
        }
        for head in input.documents.as_deref().unwrap_or_default() {
            let saved: super::super::documents::DocumentHead = context
                .transaction
                .read(key("documents", &head.id))
                .await?
                .ok_or_else(conflict)?;
            if serde_json::to_value(saved).map_err(internal)?
                != serde_json::to_value(head).map_err(internal)?
            {
                return Err(conflict());
            }
        }
    }
    let publication = super::super::crypto::random_id()?;
    super::super::members::metadata_check_profile_writes(
        &mut context,
        input.member.as_ref(),
        &input.objects,
    )
    .await?;
    let mut changed_domains = BTreeSet::new();
    let mut visible_domains = BTreeSet::new();
    let mut changed_metadata = BTreeSet::new();
    let mut wrote = checkpoints.commit(&mut context.transaction).await?;
    let mut changed_access = false;
    for packet in &input.objects {
        let area = areas.get(&packet.domain).ok_or_else(invalid)?;
        if rotation
            .required(&mut context.transaction, &context.security, area)
            .await?
        {
            return Err(conflict());
        }
        let written = save(&mut context, area, packet, &publication, preuploaded).await?;
        changed_access |=
            super::super::resource_access::save(&mut context, packet, written).await?;
        super::super::stock::metadata_save_references(
            &mut context.transaction,
            &context.security,
            packet,
            written,
        )
        .await?;
        if written {
            changed_domains.insert(packet.domain.clone());
            if let Some(domain) = super::super::delivery::deletion_price_domain(packet)? {
                changed_domains.insert(domain.clone());
                visible_domains.insert(domain);
            }
            if super::super::documents::blob(&packet.envelope.object)?.is_none() {
                visible_domains.insert(packet.domain.clone());
            }
            if packet.envelope.object
                == format!(
                    "{}:{}:case",
                    packet.envelope.scope,
                    packet.envelope.facet.name()
                )
            {
                changed_metadata.insert(packet.envelope.scope.clone());
            }
        }
        wrote |= written;
    }
    super::super::absences::metadata_validate_references(
        &mut context.transaction,
        &context.security,
        &input.objects,
    )
    .await?;
    super::super::stock::metadata_validate_references(&mut context.transaction, &input.objects)
        .await?;
    if let Some(change) = &input.member {
        super::super::members::metadata_apply_change(&mut context, change, &input.objects).await?;
        wrote = true;
    }
    for head in input.documents.as_deref().unwrap_or_default() {
        let changed = super::super::documents::metadata_commit(
            &mut context,
            head,
            changed_metadata.contains(&head.scope),
        )
        .await?;
        if changed {
            changed_domains.extend(head.domains());
            visible_domains.extend(head.domains());
            wrote = true;
        }
    }
    if let Some(policy) = &input.policy {
        registry::replace_policy(&mut context.transaction, &context.security, policy, false)
            .await?;
        wrote = true;
    }
    if changed_access {
        let mut root =
            super::super::setup::metadata_root(&mut context.transaction, &context.auth.tenant)
                .await?;
        root.catalog_version = revision(&root.catalog_version)?
            .checked_add(1)
            .ok_or_else(conflict)?
            .to_string();
        super::super::setup::write_root(&mut context.transaction, &root).await?;
        context.transaction.notify(
            "access",
            &serde_json::json!({"policy": context.security.policy.version}),
        )?;
    }
    for domain in &changed_domains {
        let area = areas.get_mut(domain).ok_or_else(invalid)?;
        area.sequence = revision(&area.sequence)?
            .checked_add(1)
            .ok_or_else(conflict)?
            .to_string();
        context
            .transaction
            .put(key("domains", domain), area)
            .await?;
        context.transaction.notify(
            "object",
            &serde_json::json!({
                "domain": domain,
                "sequence": area.sequence,
                "staged": !visible_domains.contains(domain),
            }),
        )?;
    }
    let heads = shape
        .domains
        .into_iter()
        .map(|domain| {
            let area = areas.get(&domain).ok_or_else(invalid)?;
            Ok(DomainHead {
                domain,
                sequence: area.sequence.clone(),
            })
        })
        .collect::<RpcResult<Vec<_>>>()?;
    if wrote {
        context.transaction.commit().await?;
    } else {
        context.transaction.validate().await?;
    }
    Ok(BatchResult {
        success: true,
        heads,
    })
}

async fn save(
    context: &mut MetadataContext,
    area: &registry::DomainRecord,
    input: &SaveInput,
    publication: &str,
    preuploaded: bool,
) -> RpcResult<bool> {
    let envelope = &input.envelope;
    envelope.verify(&context.security.signing_key)?;
    if let Some(origin) = &input.migration_origin {
        super::super::bootstrap::require_pending(context).await?;
        origin.verify_authority(envelope, &context.security)?;
    } else if envelope.object.starts_with("legacy-activity:") {
        return Err(invalid());
    }
    import_receipt(input, &context.security.subject)?;
    super::super::immutable::validate_packet(input)?;
    if envelope.tenant != context.auth.tenant
        || envelope.author != context.security.subject
        || envelope.scope != area.scope
        || envelope.facet != area.facet
        || envelope.generation != area.generation
        || envelope.policy_version != context.security.policy.version
    {
        return Err(conflict());
    }
    require_read(&context.security, area)?;
    super::super::delivery::metadata_validate_packet(context, input).await?;
    let previous = object(&mut context.transaction, &envelope.object).await?;
    if previous.as_ref().is_some_and(|record| record.deleted) {
        return Err(conflict());
    }
    let action = write_action(envelope, previous.is_some())?;
    // Backup adoption has its own authority-signed, setup-only admission above.
    // An ordinary first publication must still hold the namespace grant.
    if previous.is_none()
        && input.migration_origin.is_none()
        && let Some(scope) = super::super::creation::initial_record_creation_scope(
            &envelope.scope,
            envelope.facet,
            &envelope.object,
        )
        && !context.security.policy.allows(
            &context.security.subject,
            scope,
            Facet::MasterData,
            Action::Create,
        )
    {
        return Err(forbidden());
    }
    let blob = super::super::documents::blob(&envelope.object)?;
    if !context
        .security
        .allows(&context.security.subject, &area.scope, area.facet, action)
        && !(blob.is_some()
            && context.security.allows(
                &context.security.subject,
                &area.scope,
                area.facet,
                Action::Update,
            ))
    {
        return Err(forbidden());
    }
    if let Some(blob) = blob {
        let owner = if blob.facet == "opaque" {
            "scope"
        } else {
            blob.facet
        };
        if blob.scope != area.scope
            || area.facet.name() != owner
            || input.domain != format!("{}:{owner}", blob.scope)
            || envelope.revision != "1"
        {
            return Err(invalid());
        }
        if let Some(head) = context
            .transaction
            .read::<super::super::documents::DocumentHead>(key("documents", blob.id))
            .await?
            && head.locked
        {
            return Err(forbidden());
        }
    }
    let content = encoded(envelope)?;
    let reference = crate::quack_store::content_id(&content);
    if let Some(record) = &previous {
        if record.domain == input.domain
            && record.revision == envelope.revision
            && record.reference == reference
        {
            return Ok(false);
        }
        if record.tombstone
            || record.domain != input.domain
            || revision(&record.revision)?.checked_add(1) != Some(revision(&envelope.revision)?)
        {
            return Err(conflict());
        }
    } else if envelope.revision != "1" {
        return Err(conflict());
    }
    super::super::bootstrap::check_archive_write(context, &envelope.scope, &envelope.revision)
        .await?;
    if context
        .transaction
        .read::<ChangeRecord>(key("object-changes", &input.message_id))
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    if !preuploaded {
        context.repository.put_ciphertext(content).await?;
    }
    let record = ObjectRecord {
        object: envelope.object.clone(),
        domain: input.domain.clone(),
        revision: envelope.revision.clone(),
        reference,
        deleted: false,
        tombstone: envelope.is_tombstone(),
    };
    let mut occurred_at = chrono::Utc::now();
    if let Some(origin) = &input.migration_origin
        && let Some(imported_time) = origin.event_time()?
    {
        occurred_at = imported_time;
    }
    let change = ChangeRecord {
        object: record.clone(),
        previous: previous.map(|record| record.reference),
        publication: publication.into(),
        occurred_micros: occurred_at.timestamp_micros().to_string(),
        deletion: None,
        references: None,
        migration_origin: input.migration_origin.clone(),
    };
    context
        .transaction
        .put(key("object-locations", &envelope.object), &input.domain)
        .await?;
    context
        .transaction
        .put(key(&collection(&input.domain), &envelope.object), &record)
        .await?;
    context
        .transaction
        .put(key("object-changes", &input.message_id), &change)
        .await?;
    let history = history_key(&envelope.object, &envelope.revision)?;
    if context
        .transaction
        .read::<String>(history.clone())
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    context
        .transaction
        .put(history.clone(), &input.message_id)
        .await?;
    context.transaction.append(
        &input.domain,
        &journal_id(&input.message_id),
        &envelope.object,
        &change.occurred_micros,
        input
            .migration_origin
            .as_ref()
            .and_then(super::super::history::MigrationOrigin::event_order),
        &change,
    )?;

    super::super::timestamps::metadata_record_object(
        &mut context.transaction,
        envelope,
        serde_json::json!({"format":"sortsys-quack-ref-v1","id":record.reference}),
        &[
            key("object-locations", &envelope.object),
            record_key(&input.domain, &envelope.object),
            key("object-changes", &input.message_id),
            history,
        ],
    )
    .await?;
    Ok(true)
}
