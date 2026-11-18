//! Per-record recipient keys. No project area key or business contents are exposed.
use super::{
    access::{MetadataContext, MetadataRequest, Security},
    crypto::{encode, frame, identifier, invalid, sized},
    objects::{SaveInput, conflict, metadata_check_read, metadata_object, metadata_read, registry},
    wire::{Action, Effect, EncryptedObject, Facet, IdentityCertificate, Rule, SealedBox},
};
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    error::{RpcResult, forbidden},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sortsys_zerotrust::resource_access::{ResourceAccessContext, ResourceAccessState};
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

const PAGE_SIZE: usize = 32;
const MAX_ASSIGNMENT_CIPHERTEXT: usize = 64 * 1024;

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct RecipientKey {
    pub recipient: IdentityCertificate,
    pub envelope: SealedBox,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecipientAccess {
    pub domain: String,
    pub access: ResourceAccessState,
    pub recipient_key: Option<RecipientKey>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SharedObject {
    envelope: EncryptedObject,
    access: RecipientAccess,
    proofs: Vec<super::domain_proofs::DomainProof>,
}

#[derive(Clone, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct SharedPageInput {
    prefix: String,
    snapshot: Option<String>,
    after: Option<String>,
}

#[derive(Serialize, TS)]
struct SharedPage {
    snapshot: String,
    objects: Vec<SharedObject>,
    after: Option<String>,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct InspectInput {
    objects: Vec<String>,
}

/// Match only the application's public assignment address, never decrypted fields.
pub(super) fn is_assignment(envelope: &EncryptedObject) -> RpcResult<bool> {
    let scope = envelope.scope.split(':').collect::<Vec<_>>();
    if scope.len() != 3 || scope[0] != "project" || scope[2] != "planning" {
        return Ok(false);
    }
    let object = envelope.object.split(':').collect::<Vec<_>>();
    if object.get(2) != Some(&"deployment") {
        return Ok(false);
    }
    if envelope.facet != Facet::MasterData
        || object.len() != 5
        || object[0] != "schedule"
        || object[1] != scope[1]
    {
        return Err(invalid());
    }
    for token in [scope[1], object[3], object[4]] {
        let id = Id::decode(token).map_err(|_| invalid())?;
        if id.0 <= 0 || id.encode() != token {
            return Err(invalid());
        }
    }
    Ok(true)
}

fn reader_collection(generation: &str, recipient: &str) -> String {
    format!(
        "object-reader-{generation}-{}",
        crate::control::fingerprint(recipient)
    )
}

fn allows_recipient(guard: &Security, recipient: &str, scope: &str, facet: Facet) -> bool {
    let mut derived = guard.inherited.clone();
    derived.push(Rule {
        subject: recipient.into(),
        scope: scope.into(),
        facet,
        actions: vec![Action::Read],
        effect: Effect::Allow,
        origin: None,
    });
    // This derived read is evaluated only for this particular object's key.
    // It never becomes a domain permission; explicit signed denials still win.
    guard
        .policy
        .allows_with(&derived, recipient, scope, facet, Action::Read)
}

pub(super) fn verify_access(
    value: &RecipientAccess,
    envelope: &EncryptedObject,
    generation: &str,
    authority: &[u8],
) -> RpcResult<()> {
    if !is_assignment(envelope)?
        || envelope.ciphertext.len() > MAX_ASSIGNMENT_CIPHERTEXT
        || value.domain != format!("{}:{}", envelope.scope, envelope.facet.name())
        || value.access.revision != envelope.revision
        || value.access.packet_signature != envelope.signature
        || value.access.author.user != envelope.author
        || value.access.active != value.recipient_key.is_some()
        || (envelope.is_tombstone() && value.access.active)
    {
        return Err(invalid());
    }
    let binding = sortsys_zerotrust::object_shares::recipient_binding(
        value.recipient_key.as_ref().map(|key| &key.recipient),
        value.recipient_key.as_ref().map(|key| &key.envelope),
    )?;
    value.access.verify(
        &ResourceAccessContext {
            tenant: &envelope.tenant,
            resource: &envelope.scope,
            object: &envelope.object,
            generation,
            binding: &binding,
        },
        authority,
    )?;
    let signer = sized::<32>(&value.access.author.signing_key)?;
    envelope.verify(&signer)?;
    if let Some(key) = &value.recipient_key {
        key.recipient.verify(authority)?;
        sortsys_zerotrust::object_shares::verify(
            &key.envelope,
            envelope,
            &sortsys_zerotrust::object_shares::ObjectShareContext {
                authority_generation: generation,
                recipient: &key.recipient.user,
                author: &value.access.author.user,
            },
            &signer,
            &signer,
        )?;
    }
    Ok(())
}

pub(super) async fn save(
    context: &mut MetadataContext,
    packet: &SaveInput,
    written: bool,
) -> RpcResult<()> {
    let envelope = &packet.envelope;
    let value = RecipientAccess {
        domain: packet.domain.clone(),
        access: packet.resource_access.clone().ok_or_else(invalid)?,
        recipient_key: packet.recipient_key.clone(),
    };
    let generation = context.security.root.generation.to_string();
    verify_access(&value, envelope, &generation, &context.security.authority)?;
    if value.access.author.user != context.security.subject
        || sized::<32>(&value.access.author.signing_key)?.as_slice() != context.security.signing_key
    {
        return Err(forbidden());
    }
    if let Some(key) = &value.recipient_key {
        registry::check_encryption_recipient(
            &mut context.transaction,
            &context.security,
            &key.recipient,
        )
        .await?;
        if !allows_recipient(
            &context.security,
            &key.recipient.user,
            &envelope.scope,
            envelope.facet,
        ) {
            return Err(forbidden());
        }
    }
    let record = key("object-recipient-access", &envelope.object);
    let previous: Option<RecipientAccess> = context.transaction.read(record.clone()).await?;
    if !written {
        let previous = previous.ok_or_else(conflict)?;
        if previous.access.signature != value.access.signature
            || previous.access.frame()? != value.access.frame()?
        {
            return Err(conflict());
        }
        return Ok(());
    }
    let mut notified = BTreeSet::new();
    if let Some(previous) = previous
        && let Some(key) = previous.recipient_key
    {
        notified.insert(key.recipient.user.clone());
        context
            .transaction
            .delete(key_for_reader(
                &previous.access.generation,
                &key.recipient.user,
                &envelope.object,
            ))
            .await?;
    }
    context.transaction.put_protected(record, &value).await?;
    if let Some(key) = &value.recipient_key {
        notified.insert(key.recipient.user.clone());
        context
            .transaction
            .put(
                key_for_reader(&generation, &key.recipient.user, &envelope.object),
                &value,
            )
            .await?;
    }
    for subject in notified {
        context.transaction.notify(
            "object-recipient",
            &serde_json::json!({"subject": subject, "domain": packet.domain}),
        )?;
    }
    Ok(())
}

fn key_for_reader(
    generation: &str,
    subject: &str,
    object: &str,
) -> sortsys_zerotrust::metadata::RecordKey {
    key(&reader_collection(generation, subject), object)
}

pub(super) async fn states(
    transaction: &mut Transaction,
    objects: &[EncryptedObject],
) -> RpcResult<Vec<RecipientAccess>> {
    let selected = objects
        .iter()
        .filter_map(|object| match is_assignment(object) {
            Ok(true) => Some(Ok(key("object-recipient-access", &object.object))),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<RpcResult<Vec<_>>>()?;
    Ok(transaction
        .many::<RecipientAccess>(selected)
        .await?
        .into_iter()
        .flatten()
        .collect())
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let inspect = Arc::clone(&service);
    builder
        .query(
            "zerotrust.objects.shared",
            move |ctx, input: SharedPageInput| {
                let service = Arc::clone(&service);
                async move {
                    crate::control::read_snapshot(|| shared_page(&service, &ctx, input.clone()))
                        .await
                }
            },
        )
        .query(
            "zerotrust.objects.recipientAccess",
            move |ctx, input: InspectInput| {
                let service = Arc::clone(&inspect);
                async move { inspect_access(&service, &ctx, input).await }
            },
        )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<SharedPageInput, SharedPage>("zerotrust.objects.shared")
        .query_stub::<InspectInput, Vec<Option<RecipientAccess>>>(
            "zerotrust.objects.recipientAccess",
        )
}

async fn shared_page(
    service: &AuthService,
    request: &RequestContext,
    input: SharedPageInput,
) -> RpcResult<SharedPage> {
    identifier(&input.prefix)?;
    if input.after.is_some() && input.snapshot.is_none() {
        return Err(invalid());
    }
    let mut context = MetadataRequest::open(service, request)
        .await?
        .authorize_origins(&[])
        .await?;
    let generation = context.security.root.generation.to_string();
    let collection = reader_collection(&generation, &context.security.subject);
    let page = context
        .transaction
        .scan_prefix::<RecipientAccess>(&collection, &input.prefix, input.after, PAGE_SIZE)
        .await?;
    let snapshot = encode(&Sha256::digest(frame(
        "sortsys/object-recipient-page/v1",
        &[
            &context.auth.tenant,
            &generation,
            &context.security.subject,
            &context.security.policy.signature,
            &encode(&context.security.signing_key),
            &input.prefix,
            &page.version,
        ],
    )));
    if input
        .snapshot
        .as_ref()
        .is_some_and(|previous| *previous != snapshot)
    {
        return Err(conflict());
    }
    let mut objects = Vec::new();
    for row in page.records {
        let value = row.value.ok_or_else(invalid)?;
        let recipient = value.recipient_key.as_ref().ok_or_else(invalid)?;
        if !value.access.active || recipient.recipient.user != context.security.subject {
            return Err(invalid());
        }
        let record = metadata_object(&mut context.transaction, &value.access.object)
            .await?
            .ok_or_else(conflict)?;
        if record.deleted
            || record.tombstone
            || record.domain != value.domain
            || record.revision != value.access.revision
        {
            return Err(conflict());
        }
        let current: RecipientAccess = context
            .transaction
            .read(key("object-recipient-access", &record.object))
            .await?
            .ok_or_else(conflict)?;
        if current.access.signature != value.access.signature {
            return Err(conflict());
        }
        let area = registry::domain(&mut context.transaction, &record.domain).await?;
        if !allows_recipient(
            &context.security,
            &context.security.subject,
            &area.scope,
            area.facet,
        ) {
            continue;
        }
        registry::check_encryption_recipient(
            &mut context.transaction,
            &context.security,
            &recipient.recipient,
        )
        .await?;
        let envelope = metadata_read(&context.repository, &record.reference).await?;
        metadata_check_read(
            &envelope,
            &record,
            &context.auth.tenant,
            &area.scope,
            area.facet,
        )?;
        verify_access(&value, &envelope, &generation, &context.security.authority)?;
        let mut proofs = Vec::new();
        for key_generation in BTreeSet::from(["1", envelope.generation.as_str()]) {
            let definition = registry::definition_at(
                &mut context.transaction,
                &context.security,
                &area,
                key_generation,
            )
            .await?;
            proofs.push(super::domain_proofs::public_proof(definition)?);
        }
        objects.push(SharedObject {
            envelope,
            access: value,
            proofs,
        });
    }
    context.transaction.validate().await?;
    Ok(SharedPage {
        snapshot,
        objects,
        after: page.after,
    })
}

async fn inspect_access(
    service: &AuthService,
    request: &RequestContext,
    input: InspectInput,
) -> RpcResult<Vec<Option<RecipientAccess>>> {
    if input.objects.is_empty() || input.objects.len() > 64 {
        return Err(invalid());
    }
    let mut pending = MetadataRequest::open(service, request).await?;
    let mut unique = BTreeSet::new();
    let mut records = Vec::new();
    let mut domains = BTreeSet::new();
    for object in &input.objects {
        identifier(object)?;
        if !unique.insert(object) {
            return Err(invalid());
        }
        let record = metadata_object(&mut pending.transaction, object)
            .await?
            .ok_or_else(forbidden)?;
        if record.deleted {
            return Err(forbidden());
        }
        domains.insert(record.domain.clone());
        records.push(record);
    }
    let domains = domains.into_iter().collect::<Vec<_>>();
    let mut context = pending.authorize(Some(&domains)).await?;
    for record in &records {
        let area = registry::domain(&mut context.transaction, &record.domain).await?;
        if !context.security.allows(
            &context.security.subject,
            &area.scope,
            area.facet,
            Action::Read,
        ) {
            return Err(forbidden());
        }
    }
    let values = context
        .transaction
        .many::<RecipientAccess>(
            records
                .iter()
                .map(|record| key("object-recipient-access", &record.object))
                .collect(),
        )
        .await?;
    context.transaction.validate().await?;
    Ok(values)
}
