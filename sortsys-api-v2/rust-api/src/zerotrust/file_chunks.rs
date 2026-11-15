//! Immutable ciphertext blocks. File names, contents and manifests stay private.
use super::{
    access::metadata_context,
    crypto::{identifier, invalid},
    objects::{conflict, persistence, registry},
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
use std::sync::Arc;
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Put {
    domain: String,
    envelope: EncryptedObject,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Get {
    domain: String,
    id: String,
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
    builder
        .mutation("zerotrust.fileChunks.put", move |ctx, input: Put| {
            let service = Arc::clone(&put);
            async move { put_chunk(&service, &ctx, input).await }
        })
        .query("zerotrust.fileChunks.get", move |ctx, input: Get| {
            let service = Arc::clone(&service);
            async move { get_chunk(&service, &ctx, input).await }
        })
}

async fn put_chunk(service: &AuthService, ctx: &RequestContext, input: Put) -> RpcResult<Success> {
    let mut context = metadata_context(service, ctx).await?;
    let area = registry::domain(&mut context.transaction, &input.domain).await?;
    let envelope = &input.envelope;
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
    if area.facet != Facet::Attachment
        || envelope.facet != Facet::Attachment
        || envelope.scope != area.scope
        || envelope.tenant != context.auth.tenant
        || envelope.author != context.security.subject
        || envelope.revision != "1"
        || !envelope.object.starts_with(&prefix)
        || envelope.ciphertext.len() > 1024 * 1024
        || !can_read
        || !can_write
    {
        return Err(forbidden());
    }
    envelope.verify(&context.security.signing_key)?;
    let encoded = serde_json::to_string(envelope).map_err(internal)?;
    let record = ChunkRecord {
        domain: input.domain,
        reference: crate::quack_store::content_id(&encoded),
    };
    let record_key = key("file-chunks", &envelope.object);
    if let Some(previous) = context
        .transaction
        .read::<ChunkRecord>(record_key.clone())
        .await?
    {
        if previous != record {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(Success { success: true });
    }
    super::bootstrap::check_archive_write(&mut context, &area.scope, &envelope.revision).await?;
    let mut rotation = registry::RotationChecks::new(&context.security);
    if envelope.generation != area.generation
        || envelope.policy_version != context.security.policy.version
        || rotation
            .required(&mut context.transaction, &context.security, &area)
            .await?
    {
        return Err(conflict());
    }
    // The content write is immutable. Publication and all permission reads are
    // guarded together; a rejected CAS can leave only an unreachable block.
    context.repository.put_ciphertext(encoded).await?;
    context.transaction.put(record_key, &record).await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}

async fn get_chunk(
    service: &AuthService,
    ctx: &RequestContext,
    input: Get,
) -> RpcResult<EncryptedObject> {
    identifier(&input.id)?;
    let mut context = metadata_context(service, ctx).await?;
    let area = registry::domain(&mut context.transaction, &input.domain).await?;
    let prefix = chunk_prefix(&input.domain, &area.scope)?;
    if area.facet != Facet::Attachment
        || !input.id.starts_with(&prefix)
        || !context.security.allows(
            &context.security.subject,
            &area.scope,
            Facet::Attachment,
            Action::Read,
        )
    {
        return Err(forbidden());
    }
    let record: ChunkRecord = context
        .transaction
        .read(key("file-chunks", &input.id))
        .await?
        .ok_or_else(not_found)?;
    if record.domain != input.domain {
        return Err(not_found());
    }
    let envelope = persistence::read(&context.repository, &record.reference).await?;
    if envelope.tenant != context.auth.tenant
        || envelope.scope != area.scope
        || envelope.facet != Facet::Attachment
        || envelope.object != input.id
        || envelope.revision != "1"
    {
        return Err(invalid());
    }
    context.transaction.validate().await?;
    Ok(envelope)
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<Put, Success>("zerotrust.fileChunks.put")
        .query_stub::<Get, EncryptedObject>("zerotrust.fileChunks.get")
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
