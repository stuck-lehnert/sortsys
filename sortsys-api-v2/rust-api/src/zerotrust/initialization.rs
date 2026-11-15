//! Readiness is published only by the first administrator after client setup.
use super::{
    access::metadata_context,
    crypto::{frame, identifier, invalid, revision, verify},
    objects::{persistence, registry},
    setup::{RootState, root_key},
};
use crate::{
    api::Success,
    auth::AuthService,
    control::{Transaction, key},
    error::RpcResult,
    error::forbidden,
    rpc::ProcedureRegistryBuilder,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Completion {
    pub tenant: String,
    pub generation: String,
    pub subject: String,
    pub policy_version: String,
    pub domains: Vec<String>,
    pub objects: Vec<String>,
    pub signature: String,
}
impl Completion {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.subject)?;
        revision(&self.generation)?;
        revision(&self.policy_version)?;
        for values in [&self.domains, &self.objects] {
            if values.is_empty() || values.len() > 128 {
                return Err(invalid());
            }
            let mut previous: Option<&str> = None;
            for value in values {
                identifier(value)?;
                if previous.is_some_and(|previous| previous >= value.as_str()) {
                    return Err(invalid());
                }
                previous = Some(value);
            }
        }
        let domain_count = self.domains.len().to_string();
        let object_count = self.objects.len().to_string();
        let mut fields = vec![
            self.tenant.as_str(),
            self.generation.as_str(),
            self.subject.as_str(),
            self.policy_version.as_str(),
            &domain_count,
        ];
        fields.extend(self.domains.iter().map(String::as_str));
        fields.push(&object_count);
        fields.extend(self.objects.iter().map(String::as_str));
        Ok(frame("sortsys/tenant-initialized/v1", &fields))
    }
}
fn completion_key(generation: &str) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    revision(generation)?;
    Ok(key(
        "tenant-initialization",
        &format!("generation-{generation}"),
    ))
}
pub(super) async fn completed(
    transaction: &mut Transaction,
    generation: &str,
) -> RpcResult<Option<Completion>> {
    let completion: Option<Completion> = transaction.read(completion_key(generation)?).await?;
    if completion
        .as_ref()
        .is_some_and(|proof| proof.generation != generation)
    {
        return Err(invalid());
    }
    Ok(completion)
}
pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    builder.mutation("zerotrust.setup.complete", move |ctx, input: Completion| {
        let service = Arc::clone(&service);
        async move {
            let mut context = metadata_context(&service, &ctx).await?;
            let root: RootState = context
                .transaction
                .read(root_key())
                .await?
                .ok_or_else(forbidden)?;
            if !context.auth.is_admin()
                || context.security.subject != root.profile.owner.user
                || input.subject != context.security.subject
                || input.tenant != context.auth.tenant
                || input.generation != root.profile.authority.generation
            {
                return Err(forbidden());
            }
            verify(
                &context.security.authority,
                &input.signature,
                &input.frame()?,
            )?;
            if let Some(previous) = completed(&mut context.transaction, &input.generation).await? {
                if previous.signature != input.signature {
                    return Err(forbidden());
                }
                context.transaction.validate().await?;
                return Ok(Success { success: true });
            }
            if input.policy_version != root.policy_version {
                return Err(super::objects::conflict());
            }
            super::bootstrap::require_completed(&mut context).await?;
            for domain in &input.domains {
                registry::domain(&mut context.transaction, domain).await?;
            }
            for object in &input.objects {
                let record = persistence::object(&mut context.transaction, object)
                    .await?
                    .ok_or_else(invalid)?;
                if record.deleted || !input.domains.contains(&record.domain) {
                    return Err(invalid());
                }
            }
            context
                .transaction
                .put(completion_key(&input.generation)?, &input)
                .await?;
            context
                .transaction
                .notify("access", &serde_json::json!({}))?;
            context.transaction.commit().await?;
            Ok(Success { success: true })
        }
    })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<Completion, Success>("zerotrust.setup.complete")
}
