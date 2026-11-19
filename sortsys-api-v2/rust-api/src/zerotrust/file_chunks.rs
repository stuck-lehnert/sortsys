//! Immutable ciphertext blocks. File names, contents and manifests stay private.
use super::{
    access::metadata_context_for_domains,
    crypto::{identifier, invalid, packet_hash, verify},
    objects::{conflict, registry},
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    api::Success,
    auth::AuthService,
    control::key,
    error::RpcResult,
    error::{forbidden, internal, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};
use ts_rs::TS;

const MAX_CHUNKS: usize = 4;
const MAX_CIPHERTEXT_BYTES: usize = 1024 * 1024;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Put {
    domain: String,
    envelope: EncryptedObject,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct PutMany {
    domain: String,
    envelopes: Vec<EncryptedObject>,
}
#[derive(Serialize, TS)]
struct ChunkWriteReceipt {
    #[ts(type = "true")]
    success: bool,
    hashes: Vec<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Get {
    domain: String,
    id: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct GetMany {
    domain: String,
    ids: Vec<String>,
    #[ts(optional)]
    prepared: Option<super::content::PreparedView>,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ChunkRecord {
    domain: String,
    reference: String,
}

fn chunk_prefix(domain: &str, scope: &str) -> RpcResult<String> {
    if scope.starts_with("backup:") {
        super::bootstrap::validate_context(scope)?;
        if domain != format!("{scope}:attachment") {
            return Err(invalid());
        }
        return Ok(format!("file-data:{scope}:"));
    }
    if scope == "organization" && domain == "organization:attachment" {
        return Ok("file-data:organization:".into());
    }
    let project = scope.strip_prefix("project:").ok_or_else(invalid)?;
    identifier(project)?;
    if domain != format!("project:{project}:attachment") {
        return Err(invalid());
    }
    Ok(format!("file-data:{project}:"))
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let put = Arc::clone(&service);
    let put_many = Arc::clone(&service);
    let get = Arc::clone(&service);
    let get_many = Arc::clone(&service);
    builder
        .mutation("zerotrust.fileChunks.put", move |ctx, input: Put| {
            let service = Arc::clone(&put);
            let batch = PutMany {
                domain: input.domain,
                envelopes: vec![input.envelope],
            };
            async move {
                put_chunks(&service, &ctx, batch).await?;
                Ok(Success { success: true })
            }
        })
        .mutation(
            "zerotrust.fileChunks.putMany",
            move |ctx, input: PutMany| {
                let service = Arc::clone(&put_many);
                async move { put_chunks(&service, &ctx, input).await }
            },
        )
        .query("zerotrust.fileChunks.get", move |ctx, input: Get| {
            let service = Arc::clone(&get);
            async move { get_chunk(&service, &ctx, input).await }
        })
        .query(
            "zerotrust.fileChunks.getMany",
            move |ctx, input: GetMany| {
                let service = Arc::clone(&get_many);
                async move { get_chunks(&service, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.fileChunks.findMany",
            move |ctx, input: GetMany| {
                let service = Arc::clone(&service);
                async move { lookup_chunks(&service, &ctx, input, false).await }
            },
        )
}

async fn put_chunks(
    service: &AuthService,
    ctx: &RequestContext,
    input: PutMany,
) -> RpcResult<ChunkWriteReceipt> {
    identifier(&input.domain)?;
    if input.envelopes.is_empty() || input.envelopes.len() > MAX_CHUNKS {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for envelope in &input.envelopes {
        if !seen.insert(&envelope.object) {
            return Err(invalid());
        }
    }
    let mut context =
        metadata_context_for_domains(service, ctx, Some(std::slice::from_ref(&input.domain)))
            .await?;
    let area = registry::domain(&mut context.transaction, &input.domain).await?;
    let prefix = chunk_prefix(&input.domain, &area.scope)?;
    let can_read = context.security.allows(
        &context.security.subject,
        &area.scope,
        Facet::Attachment,
        Action::Read,
    );
    let can_write = [Action::Create, Action::Update].into_iter().any(|action| {
        context.security.allows(
            &context.security.subject,
            &area.scope,
            Facet::Attachment,
            action,
        )
    });
    if area.facet != Facet::Attachment || !can_read || !can_write {
        return Err(forbidden());
    }
    let mut record_keys = Vec::with_capacity(input.envelopes.len());
    let mut hashes = Vec::with_capacity(input.envelopes.len());
    for envelope in &input.envelopes {
        if envelope.facet != Facet::Attachment
            || envelope.scope != area.scope
            || envelope.tenant != context.auth.tenant
            || envelope.author != context.security.subject
            || envelope.revision != "1"
            || !envelope.object.starts_with(&prefix)
            || envelope.ciphertext.len() > MAX_CIPHERTEXT_BYTES
        {
            return Err(forbidden());
        }
        let frame = envelope.frame()?;
        verify(&context.security.signing_key, &envelope.signature, &frame)?;
        hashes.push(packet_hash(frame, &envelope.signature)?);
        record_keys.push(key("file-chunks", &envelope.object));
    }
    let previous = context
        .transaction
        .many::<ChunkRecord>(record_keys.clone())
        .await?;
    let mut new_records = Vec::new();
    let mut ciphertexts = Vec::new();
    for ((envelope, record_key), previous) in input.envelopes.iter().zip(record_keys).zip(previous)
    {
        let encoded = serde_json::to_string(envelope).map_err(internal)?;
        let record = ChunkRecord {
            domain: input.domain.clone(),
            reference: crate::quack_store::content_id(&encoded),
        };
        if let Some(previous) = previous {
            if previous != record {
                return Err(conflict());
            }
            continue;
        }
        if envelope.generation != area.generation
            || envelope.policy_version != context.security.policy.version
        {
            return Err(conflict());
        }
        new_records.push((record_key, record));
        ciphertexts.push(encoded);
    }
    if new_records.is_empty() {
        context.transaction.validate().await?;
    } else {
        super::bootstrap::check_archive_write(&mut context, &area.scope, "1").await?;
        let mut rotation = registry::RotationChecks::new(&context.security);
        if rotation
            .required(&mut context.transaction, &context.security, &area)
            .await?
        {
            return Err(conflict());
        }
        // DuckDB verifies the ciphertext hashes inside its write transaction.
        // Publish the references only after it commits. A rejected CAS leaves
        // the new blocks unreachable.
        context.repository.put_ciphertexts(ciphertexts).await?;
        for (record_key, record) in new_records {
            context.transaction.put(record_key, &record).await?;
        }
        context.transaction.commit().await?;
    }
    Ok(ChunkWriteReceipt {
        success: true,
        hashes,
    })
}

async fn get_chunk(
    service: &AuthService,
    ctx: &RequestContext,
    input: Get,
) -> RpcResult<EncryptedObject> {
    let input = GetMany {
        domain: input.domain,
        ids: vec![input.id],
        prepared: None,
    };
    get_chunks(service, ctx, input)
        .await?
        .pop()
        .ok_or_else(invalid)
}

async fn get_chunks(
    service: &AuthService,
    ctx: &RequestContext,
    input: GetMany,
) -> RpcResult<Vec<EncryptedObject>> {
    lookup_chunks(service, ctx, input, true)
        .await?
        .into_iter()
        .map(|envelope| envelope.ok_or_else(not_found))
        .collect()
}

async fn lookup_chunks(
    service: &AuthService,
    ctx: &RequestContext,
    input: GetMany,
    require_all: bool,
) -> RpcResult<Vec<Option<EncryptedObject>>> {
    identifier(&input.domain)?;
    if input.ids.is_empty() || input.ids.len() > MAX_CHUNKS {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for id in &input.ids {
        identifier(id)?;
        if !seen.insert(id) {
            return Err(invalid());
        }
    }
    let mut context =
        metadata_context_for_domains(service, ctx, Some(std::slice::from_ref(&input.domain)))
            .await?;
    context = super::content::select_read_view(context, input.prepared.as_ref()).await?;
    let area = registry::domain(&mut context.transaction, &input.domain).await?;
    let prefix = chunk_prefix(&input.domain, &area.scope)?;
    if area.facet != Facet::Attachment
        || input.ids.iter().any(|id| !id.starts_with(&prefix))
        || !context.security.allows(
            &context.security.subject,
            &area.scope,
            Facet::Attachment,
            Action::Read,
        )
    {
        return Err(forbidden());
    }
    let records = context
        .transaction
        .many::<ChunkRecord>(input.ids.iter().map(|id| key("file-chunks", id)).collect())
        .await?;
    let mut references = Vec::with_capacity(records.len());
    let mut positions = Vec::with_capacity(records.len());
    for (index, record) in records.into_iter().enumerate() {
        if let Some(record) = record.filter(|record| record.domain == input.domain) {
            references.push(record.reference);
            positions.push(index);
        } else if require_all {
            return Err(not_found());
        }
    }
    // Leave room for the signed envelope around each ciphertext. The store
    // also checks its content hash before returning any bytes.
    let encoded = if references.is_empty() {
        Vec::new()
    } else {
        context
            .repository
            .ciphertext_prefix(references, MAX_CHUNKS * (MAX_CIPHERTEXT_BYTES + 4096))
            .await?
    };
    if encoded.len() != positions.len() {
        return Err(invalid());
    }
    let mut envelopes = vec![None; input.ids.len()];
    for (index, data) in positions.into_iter().zip(encoded) {
        let envelope: EncryptedObject = serde_json::from_str(&data).map_err(|_| invalid())?;
        if envelope.tenant != context.auth.tenant
            || envelope.scope != area.scope
            || envelope.facet != Facet::Attachment
            || envelope.object != input.ids[index]
            || envelope.revision != "1"
            || envelope.ciphertext.len() > MAX_CIPHERTEXT_BYTES
        {
            return Err(invalid());
        }
        envelope.frame()?;
        envelopes[index] = Some(envelope);
    }
    context.transaction.validate().await?;
    Ok(envelopes)
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<Put, Success>("zerotrust.fileChunks.put")
        .mutation_stub::<PutMany, ChunkWriteReceipt>("zerotrust.fileChunks.putMany")
        .query_stub::<Get, EncryptedObject>("zerotrust.fileChunks.get")
        .query_stub::<GetMany, Vec<EncryptedObject>>("zerotrust.fileChunks.getMany")
        .query_stub::<GetMany, Vec<Option<EncryptedObject>>>("zerotrust.fileChunks.findMany")
}

#[cfg(test)]
mod tests {
    use super::chunk_prefix;

    #[test]
    fn organization_assets_have_one_explicit_namespace() {
        assert_eq!(
            chunk_prefix("organization:attachment", "organization").unwrap(),
            "file-data:organization:"
        );
        assert_eq!(
            chunk_prefix("project:123:attachment", "project:123").unwrap(),
            "file-data:123:"
        );
        assert!(chunk_prefix("organization:billing", "organization").is_err());
        assert!(chunk_prefix("arbitrary:attachment", "organization").is_err());
        assert!(chunk_prefix("organization:attachment", "catalog:customers").is_err());
    }
}
