//! Optional, signed source adoption during initial tenant setup. Only encrypted
//! manifests and public proofs cross this boundary; no backup SQL is accepted.
use super::{
    access::{MetadataContext, metadata_context},
    crypto::{invalid, revision, sized},
    objects, setup,
};
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    error::RpcResult,
    error::forbidden,
    rpc::ProcedureRegistryBuilder,
};
use serde::Serialize;
use sortsys_zerotrust::initialization::InitializationSourceProof;
use std::sync::Arc;
use ts_rs::TS;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SourceStatus {
    context: Option<String>,
    source: Option<InitializationSourceProof>,
    completion: Option<InitializationSourceProof>,
}

pub(super) fn validate_context(context: &str) -> RpcResult<()> {
    let id = context.strip_prefix("backup:").ok_or_else(invalid)?;
    sized::<32>(id)?;
    Ok(())
}

async fn root_context(transaction: &mut Transaction) -> RpcResult<Option<String>> {
    let root: setup::RootState = transaction
        .read(setup::root_key())
        .await?
        .ok_or_else(forbidden)?;
    if let Some(context) = &root.profile.authority.context {
        validate_context(context)?;
    }
    Ok(root.profile.authority.context)
}

async fn verify_stored(
    context: &mut MetadataContext,
    proof: &InitializationSourceProof,
    expected: &str,
) -> RpcResult<()> {
    let generation = revision(&proof.generation)?;
    let authority: objects::AuthorityHistory = context
        .transaction
        .read(key("authority-history", &format!("{generation:020}")))
        .await?
        .ok_or_else(invalid)?;
    authority.certificate.verify()?;
    if proof.tenant != context.auth.tenant
        || proof.context != expected
        || authority.certificate.tenant != proof.tenant
        || authority.certificate.generation != proof.generation
        || authority.certificate.context.as_deref() != Some(expected)
    {
        return Err(invalid());
    }
    proof.verify(&sized::<32>(&authority.certificate.authority_signing_key)?)?;
    Ok(())
}

async fn status(context: &mut MetadataContext) -> RpcResult<SourceStatus> {
    let selected = root_context(&mut context.transaction).await?;
    let source: Option<InitializationSourceProof> = context
        .transaction
        .read(key("tenant-bootstrap", "source"))
        .await?;
    let completion: Option<InitializationSourceProof> = context
        .transaction
        .read(key("tenant-bootstrap", "complete"))
        .await?;
    if let Some(expected) = &selected {
        if let Some(source) = &source {
            verify_stored(context, source, expected).await?;
            if source.source_signature.is_some() {
                return Err(invalid());
            }
        }
        if let Some(completion) = &completion {
            verify_stored(context, completion, expected).await?;
            if source.as_ref().map(|source| &source.signature)
                != completion.source_signature.as_ref()
            {
                return Err(invalid());
            }
        }
    } else if source.is_some() || completion.is_some() {
        return Err(invalid());
    }
    Ok(SourceStatus {
        context: selected,
        source,
        completion,
    })
}

pub(super) async fn require_completed(context: &mut MetadataContext) -> RpcResult<()> {
    let state = status(context).await?;
    if state.context.is_some() && state.completion.is_none() {
        return Err(forbidden());
    }
    Ok(())
}

pub(super) async fn require_pending(context: &mut MetadataContext) -> RpcResult<()> {
    let state = status(context).await?;
    if state.context.is_none() || state.source.is_none() || state.completion.is_some() {
        return Err(forbidden());
    }
    let root: setup::RootState = context
        .transaction
        .read(setup::root_key())
        .await?
        .ok_or_else(forbidden)?;
    if !context.auth.is_admin()
        || root.profile.owner.user != context.security.subject
        || super::initialization::completed(
            &mut context.transaction,
            &root.profile.authority.generation,
        )
        .await?
        .is_some()
    {
        return Err(forbidden());
    }
    Ok(())
}

pub(super) async fn require_pending_context(
    context: &mut MetadataContext,
    expected: &str,
) -> RpcResult<()> {
    require_pending(context).await?;
    if root_context(&mut context.transaction).await?.as_deref() != Some(expected) {
        return Err(forbidden());
    }
    Ok(())
}

pub(super) async fn check_archive_write(
    context: &mut MetadataContext,
    scope: &str,
    revision: &str,
) -> RpcResult<()> {
    if !scope.starts_with("backup:") {
        return Ok(());
    }
    let selected = root_context(&mut context.transaction).await?;
    let complete: Option<InitializationSourceProof> = context
        .transaction
        .read(key("tenant-bootstrap", "complete"))
        .await?;
    let root: setup::RootState = context
        .transaction
        .read(setup::root_key())
        .await?
        .ok_or_else(forbidden)?;
    let initialized = super::initialization::completed(
        &mut context.transaction,
        &root.profile.authority.generation,
    )
    .await?
    .is_some();
    if selected.as_deref() != Some(scope) || complete.is_some() || initialized || revision != "1" {
        return Err(forbidden());
    }
    Ok(())
}

async fn publish(
    service: &AuthService,
    request: &crate::rpc::RequestContext,
    input: InitializationSourceProof,
    completing: bool,
) -> RpcResult<crate::api::Success> {
    let mut context = metadata_context(service, request).await?;
    let state = status(&mut context).await?;
    let root: setup::RootState = context
        .transaction
        .read(setup::root_key())
        .await?
        .ok_or_else(forbidden)?;
    if !context.auth.is_admin()
        || root.profile.owner.user != context.security.subject
        || input.author != context.security.subject
        || input.tenant != context.auth.tenant
        || state.context.as_deref() != Some(input.context.as_str())
        || input.generation != root.profile.authority.generation
        || completing != input.source_signature.is_some()
    {
        return Err(forbidden());
    }
    input.verify(&context.security.authority)?;
    let target = if completing { "complete" } else { "source" };
    let previous = if completing {
        &state.completion
    } else {
        &state.source
    };
    if let Some(previous) = previous {
        if previous != &input {
            return Err(objects::conflict());
        }
        context.transaction.validate().await?;
        return Ok(crate::api::Success { success: true });
    }
    if super::initialization::completed(&mut context.transaction, &input.generation)
        .await?
        .is_some()
        || !completing && state.completion.is_some()
    {
        return Err(forbidden());
    }
    if completing
        && state.source.as_ref().map(|source| &source.signature) != input.source_signature.as_ref()
    {
        return Err(invalid());
    }
    let suffix = if completing { ":receipt" } else { ":manifest" };
    if input.manifest != format!("{}{suffix}", input.context) {
        return Err(invalid());
    }
    let stored = objects::metadata_object(&mut context.transaction, &input.manifest)
        .await?
        .ok_or_else(invalid)?;
    if stored.deleted
        || stored.tombstone
        || stored.domain != format!("{}:master-data", input.context)
        || stored.revision != "1"
    {
        return Err(invalid());
    }
    let envelope = objects::metadata_read(&context.repository, &stored.reference).await?;
    // The first publication already verified this immutable packet. A recovery
    // can replace its author; the new authority must still bind the exact saved
    // signature, and clients verify the original author through trust history.
    if envelope.signature != input.object_signature
        || envelope.tenant != input.tenant
        || envelope.object != input.manifest
        || envelope.scope != input.context
    {
        return Err(invalid());
    }
    context
        .transaction
        .put(key("tenant-bootstrap", target), &input)
        .await?;
    context
        .transaction
        .notify("access", &serde_json::json!({"context": input.context}))?;
    context.transaction.commit().await?;
    Ok(crate::api::Success { success: true })
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let read = Arc::clone(&service);
    let begin = Arc::clone(&service);
    builder
        .query("zerotrust.setup.backup.status", move |request, _: ()| {
            let service = Arc::clone(&read);
            async move {
                let mut context = metadata_context(&service, &request).await?;
                let result = status(&mut context).await?;
                context.transaction.validate().await?;
                Ok(result)
            }
        })
        .mutation(
            "zerotrust.setup.backup.begin",
            move |request, input: InitializationSourceProof| {
                let service = Arc::clone(&begin);
                async move { publish(&service, &request, input, false).await }
            },
        )
        .mutation(
            "zerotrust.setup.backup.complete",
            move |request, input: InitializationSourceProof| {
                let service = Arc::clone(&service);
                async move { publish(&service, &request, input, true).await }
            },
        )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), SourceStatus>("zerotrust.setup.backup.status")
        .mutation_stub::<InitializationSourceProof, crate::api::Success>(
            "zerotrust.setup.backup.begin",
        )
        .mutation_stub::<InitializationSourceProof, crate::api::Success>(
            "zerotrust.setup.backup.complete",
        )
}
