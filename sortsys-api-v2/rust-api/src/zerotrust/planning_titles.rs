//! Publish a small encrypted title alongside a project rename. The title's
//! recipients come from independently authorized assignment shares.
use super::{
    access::{MetadataContext, metadata_context_for_domains},
    crypto::{encode, frame, invalid},
    domain_proofs::DomainProof,
    object_shares::{RecipientAccess, allows_recipient, writer_proofs},
    objects::{ObjectRecord, SaveInput, metadata_check_read, persistence, registry},
    wire::{Action, EncryptedObject, Facet, SealedBox},
};
use crate::{
    auth::AuthService,
    control::{Transaction, conflict, key},
    error::{ErrorCode, RpcResult, forbidden},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use ts_rs::TS;

const COLLECTION: &str = "project-planning-titles";
const PURPOSE: &str = "project-planning-title";

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct Publication {
    snapshot: String,
    boxes: Vec<SealedBox>,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct AudienceInput {
    project: String,
}

#[derive(Serialize, TS)]
struct Audience {
    snapshot: String,
    recipients: Vec<AudienceRecipient>,
}

#[derive(Serialize, TS)]
struct AudienceRecipient {
    assignment: EncryptedObject,
    access: RecipientAccess,
    proofs: Vec<DomainProof>,
}

struct EligibleShare {
    user: String,
    access: RecipientAccess,
    record: ObjectRecord,
}

struct AudienceSelection {
    snapshot: String,
    shares: Vec<EligibleShare>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredTitle {
    source_generation: String,
    boxes: BTreeMap<String, SealedBox>,
}

#[derive(Serialize, TS)]
pub(super) struct SharedTitle {
    project: String,
    envelope: SealedBox,
    proofs: Vec<DomainProof>,
}

fn check_project(project: &str) -> RpcResult<()> {
    let id = Id::decode(project).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != project {
        return Err(invalid());
    }
    Ok(())
}

fn domains(project: &str) -> [String; 2] {
    [
        format!("project:{project}:master-data"),
        format!("project:{project}:planning:master-data"),
    ]
}

async fn audience(context: &mut MetadataContext, project: &str) -> RpcResult<AudienceSelection> {
    let scope = format!("project:{project}");
    let planning_scope = format!("{scope}:planning");
    for action in [Action::Read, Action::Update] {
        if !context
            .security
            .allows(&context.security.subject, &scope, Facet::MasterData, action)
        {
            return Err(forbidden());
        }
    }
    let [_, planning_domain] = domains(project);
    let planning = registry::domain(&mut context.transaction, &planning_domain).await?;
    let content_number = super::content::content_number(&mut context.transaction).await?;
    let sequence = planning.content_sequence(content_number)?;
    let generation = context.security.root.generation.to_string();
    let prefix = format!("schedule:{project}:deployment:");
    let mut recipients = BTreeMap::new();
    let mut after = None;
    loop {
        let page = context
            .transaction
            .scan_prefix::<RecipientAccess>("object-recipient-access", &prefix, after, 128)
            .await?;
        after = page.after;
        let ids: Vec<_> = page
            .records
            .iter()
            .map(|row| row.record.key.as_str())
            .collect();
        let records = persistence::objects(&mut context.transaction, &ids).await?;
        for (row, stored) in page.records.into_iter().zip(records) {
            let share = row.value.ok_or_else(invalid)?;
            if share.access.object != row.record.key
                || share.domain != planning_domain
                || share.access.active != share.recipient_key.is_some()
            {
                return Err(invalid());
            }
            let Some(recipient) = share.recipient_key.as_ref().map(|entry| &entry.recipient) else {
                continue;
            };
            let Some(record) = stored else { continue };
            if record.deleted
                || record.tombstone
                || record.domain != share.domain
                || record.revision != share.access.revision
                || share.access.generation != generation
                || recipients.contains_key(&recipient.user)
                || !allows_recipient(
                    &context.security,
                    &recipient.user,
                    &planning_scope,
                    Facet::MasterData,
                )
            {
                continue;
            }
            match registry::check_encryption_recipient(
                &mut context.transaction,
                &context.security,
                recipient,
            )
            .await
            {
                Ok(()) => {
                    recipients.insert(
                        recipient.user.clone(),
                        EligibleShare {
                            user: recipient.user.clone(),
                            access: share,
                            record,
                        },
                    );
                }
                Err(error) if error.code == ErrorCode::Forbidden => continue,
                Err(error) => return Err(error),
            }
        }
        if after.is_none() {
            break;
        }
    }
    let shares: Vec<_> = recipients.into_values().collect();
    let mut fields = vec![
        context.auth.tenant.as_str(),
        project,
        &generation,
        &context.security.policy.signature,
        &sequence,
    ];
    fields.extend(
        shares
            .iter()
            .map(|share| share.access.access.signature.as_str()),
    );
    let snapshot = encode(&Sha256::digest(frame(
        "sortsys/planning-title-audience/v1",
        &fields,
    )));
    Ok(AudienceSelection { snapshot, shares })
}

async fn audience_evidence(context: &mut MetadataContext, project: &str) -> RpcResult<Audience> {
    let selected = audience(context, project).await?;
    let [_, planning] = domains(project);
    let area = registry::domain(&mut context.transaction, &planning).await?;
    let mut recipients = Vec::with_capacity(selected.shares.len());
    for group in selected.shares.chunks(32) {
        let references = group
            .iter()
            .map(|entry| entry.record.reference.clone())
            .collect();
        let ciphertexts = context.repository.ciphertexts(references).await?;
        if ciphertexts.len() != group.len() {
            return Err(invalid());
        }
        for (share, body) in group.iter().zip(ciphertexts) {
            let assignment = persistence::decode_envelope(&body)?;
            metadata_check_read(
                &assignment,
                &share.record,
                &context.auth.tenant,
                &area.scope,
                area.facet,
            )?;
            let proofs = writer_proofs(context, &area, &assignment.generation).await?;
            recipients.push(AudienceRecipient {
                assignment,
                access: share.access.clone(),
                proofs,
            });
        }
    }
    Ok(Audience {
        snapshot: selected.snapshot,
        recipients,
    })
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    builder.query(
        "zerotrust.planningTitles.audience",
        move |request: RequestContext, input: AudienceInput| {
            let service = Arc::clone(&service);
            async move {
                check_project(&input.project)?;
                let mut context = metadata_context_for_domains(
                    &service,
                    &request,
                    Some(&domains(&input.project)),
                )
                .await?;
                let result = audience_evidence(&mut context, &input.project).await?;
                context.transaction.validate().await?;
                Ok(result)
            }
        },
    )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<AudienceInput, Audience>("zerotrust.planningTitles.audience")
}

pub(super) async fn save(
    context: &mut MetadataContext,
    packet: &SaveInput,
    written: bool,
) -> RpcResult<()> {
    let Some(publication) = &packet.planning_title else {
        return Ok(());
    };
    let source = &packet.envelope;
    let project = source.scope.strip_prefix("project:").ok_or_else(invalid)?;
    check_project(project)?;
    if source.object != source.scope
        || source.facet != Facet::MasterData
        || source.revision == "1"
        || source.is_tombstone()
    {
        return Err(invalid());
    }
    if !written {
        return Ok(());
    }
    let eligible = audience(context, project).await?;
    if eligible.snapshot != publication.snapshot || eligible.shares.len() != publication.boxes.len()
    {
        return Err(conflict());
    }
    let generation = context.security.root.generation.to_string();
    let binding = format!(
        "planning-title:{project}:{}:{}:{}:{}",
        source.revision, source.policy_version, source.generation, source.signature,
    );
    let mut boxes = BTreeMap::new();
    for (recipient, sealed) in eligible.shares.into_iter().zip(&publication.boxes) {
        if sealed.tenant != source.tenant
            || sealed.purpose != PURPOSE
            || sealed.object != binding
            || sealed.generation != generation
            || sealed.recipient != recipient.user
            || sealed.author != source.author
            || sealed.ciphertext.len() > 1024
        {
            return Err(invalid());
        }
        sealed.verify(&context.security.signing_key)?;
        boxes.insert(recipient.user, sealed.clone());
    }
    let value = StoredTitle {
        source_generation: source.generation.clone(),
        boxes,
    };
    context
        .transaction
        .put(key(COLLECTION, project), &value)
        .await?;
    let domain = format!("project:{project}:planning:master-data");
    for subject in value.boxes.keys() {
        context.transaction.notify(
            "object-recipient",
            &serde_json::json!({"subject": subject, "domain": domain}),
        )?;
    }
    Ok(())
}

pub(super) async fn for_recipient(
    context: &mut MetadataContext,
    objects: impl Iterator<Item = &EncryptedObject>,
    generation: &str,
) -> RpcResult<Vec<SharedTitle>> {
    let projects = objects
        .map(|object| object.scope.split(':').nth(1).ok_or_else(invalid))
        .collect::<RpcResult<BTreeSet<_>>>()?;
    let titles = context
        .transaction
        .many::<StoredTitle>(
            projects
                .iter()
                .map(|project| key(COLLECTION, project))
                .collect(),
        )
        .await?;
    let mut result = Vec::new();
    for (project, title) in projects.into_iter().zip(titles) {
        let Some(mut title) = title else { continue };
        let Some(envelope) = title
            .boxes
            .remove(&context.security.subject)
            .filter(|envelope| envelope.generation == generation)
        else {
            continue;
        };
        let [master, _] = domains(project);
        let area = registry::domain(&mut context.transaction, &master).await?;
        // Reader access to an assignment also conveys this title's public
        // writer evidence. No area key packages are part of the response.
        let proofs = writer_proofs(context, &area, &title.source_generation).await?;
        result.push(SharedTitle {
            project: project.to_owned(),
            envelope,
            proofs,
        });
    }
    Ok(result)
}

pub(super) async fn version(transaction: &mut Transaction) -> RpcResult<String> {
    transaction.collection_version(COLLECTION).await
}
