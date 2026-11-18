//! A replacement tenant authority can reattest an existing booking. This does
//! not recreate data, accept old certificates or grant a responsible reader.
use super::{conflict, persistence, registry};
use crate::{
    api::Success,
    auth::AuthService,
    control::key,
    error::{RpcResult, forbidden},
    rpc::RequestContext,
    zerotrust::{
        access::metadata_context_for_domains,
        creation::CreationRenewalInput,
        crypto::{invalid, verify},
    },
};

pub(super) async fn renew(
    service: &AuthService,
    request: &RequestContext,
    input: CreationRenewalInput,
) -> RpcResult<Success> {
    let frame = input.frame()?;
    let domains: Vec<_> = input
        .origins
        .iter()
        .map(|origin| origin.id.clone())
        .collect();
    let mut context = metadata_context_for_domains(service, request, Some(&domains)).await?;
    if !context.auth.is_admin() {
        return Err(forbidden());
    }
    verify(&context.security.authority, &input.proof, &frame)?;
    let collection = registry::origin_collection(context.security.root.generation);
    let mut existing = 0;
    for origin in &input.origins {
        origin.verify(&context.security.authority)?;
        if origin.tenant != context.auth.tenant
            || origin.capability.generation != context.security.root.generation.to_string()
            || origin.capability.creator.user != context.security.subject
        {
            return Err(forbidden());
        }
        for member in origin.recipients() {
            registry::check_member(&mut context.transaction, &context.security, member).await?;
        }
        let area = registry::domain(&mut context.transaction, &origin.id).await?;
        if area.scope != origin.scope || area.facet != origin.facet {
            return Err(invalid());
        }
        if let Some(current) = context
            .transaction
            .read::<crate::zerotrust::creation::CreationOrigin>(key(&collection, &origin.id))
            .await?
        {
            if current.signature != origin.signature || current.frame()? != origin.frame()? {
                return Err(conflict());
            }
            existing += 1;
        }
    }
    if existing == input.origins.len() {
        context.transaction.validate().await?;
        return Ok(Success { success: true });
    }
    if existing != 0 {
        return Err(conflict());
    }
    let source = persistence::object(&mut context.transaction, &input.object)
        .await?
        .ok_or_else(conflict)?;
    if source.deleted
        || source.tombstone
        || source.revision != input.revision
        || source.domain != input.origins[0].id
    {
        return Err(conflict());
    }
    let envelope = persistence::read(&context.repository, &source.reference).await?;
    if envelope.signature != input.packet_signature {
        return Err(conflict());
    }
    for origin in &input.origins {
        context
            .transaction
            .put(key(&collection, &origin.id), origin)
            .await?;
    }
    crate::zerotrust::setup::advance_catalog(&mut context.transaction, &context.auth.tenant)
        .await?;
    context.transaction.notify(
        "access",
        &serde_json::json!({
            "policy": context.security.policy.version,
        }),
    )?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
