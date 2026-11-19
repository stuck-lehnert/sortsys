//! Accept a physical return without opening or rewriting business ciphertext.
use super::{
    access::{MetadataContext, metadata_context_for_domains},
    creation::{CreationOrigin, TOOL_RETURN_PURPOSE},
    crypto::{invalid, revision},
    objects::{conflict, persistence, registry},
    resource_access::check_command_binding,
    wire::{Action, Facet},
};
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    error::{RpcResult, forbidden},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sortsys_zerotrust::{
    metadata::RecordKey,
    resource_access::{ResourceCommand, ResourceCommandContext, resource_command_binding},
};
use std::{collections::BTreeSet, sync::Arc};
use ts_rs::TS;

pub(super) const RECEIPTS: &str = "tool-return-receipts";
const MAX_SELECTION: usize = 64;
const MAX_COMMAND_AGE_MS: i64 = 300_000;
const MAX_CLOCK_AHEAD_MS: i64 = 60_000;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReturnInput {
    tracking_id: Id,
    command: ResourceCommand,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReturnSelection {
    verification_keys: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReturnReceipt {
    scope: String,
    actor: String,
    command: ResourceCommand,
}

pub(super) fn receipt_key(binding: &str) -> RecordKey {
    key(RECEIPTS, binding)
}

fn verify_command(command: &ResourceCommand, tenant: &str, binding: &str) -> RpcResult<()> {
    command.verify(&ResourceCommandContext {
        tenant,
        purpose: TOOL_RETURN_PURPOSE,
        binding,
    })?;
    Ok(())
}

pub(super) async fn existing_command(
    transaction: &mut Transaction,
    tenant: &str,
    scope: &str,
    binding: &str,
) -> RpcResult<Option<ResourceCommand>> {
    let receipt: Option<ReturnReceipt> = transaction.read(receipt_key(binding)).await?;
    receipt
        .map(|receipt| {
            if receipt.scope != scope {
                return Err(conflict());
            }
            verify_command(&receipt.command, tenant, binding)?;
            Ok(receipt.command)
        })
        .transpose()
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<ReturnInput, ResourceCommand>("zerotrust.toolReturns.publish")
        .query_stub::<ReturnSelection, Vec<Option<ResourceCommand>>>("zerotrust.toolReturns.lookup")
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let reader = Arc::clone(&service);
    builder
        .query(
            "zerotrust.toolReturns.lookup",
            move |ctx, input: ReturnSelection| {
                let service = Arc::clone(&reader);
                async move { lookup(&service, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.toolReturns.publish",
            move |ctx, input: ReturnInput| {
                let service = Arc::clone(&service);
                async move { publish(&service, &ctx, input).await }
            },
        )
}

async fn lookup(
    service: &AuthService,
    request: &RequestContext,
    input: ReturnSelection,
) -> RpcResult<Vec<Option<ResourceCommand>>> {
    if input.verification_keys.is_empty() || input.verification_keys.len() > MAX_SELECTION {
        return Err(invalid());
    }
    let bindings = input
        .verification_keys
        .iter()
        .map(|key| resource_command_binding(key))
        .collect::<sortsys_zerotrust::Result<Vec<_>>>()?;
    if bindings.iter().collect::<BTreeSet<_>>().len() != bindings.len() {
        return Err(invalid());
    }
    let mut context = metadata_context_for_domains(service, request, Some(&[])).await?;
    // Projection readers know the random public key. Requesting a receipt
    // requires that key, rather than a booking ID or its public commitment.
    let records = bindings
        .iter()
        .map(|binding| receipt_key(binding))
        .collect();
    let entries = context.transaction.many::<ReturnReceipt>(records).await?;
    let commands = entries
        .into_iter()
        .zip(bindings)
        .map(|(receipt, binding)| {
            receipt
                .map(|receipt| {
                    verify_command(&receipt.command, &context.auth.tenant, &binding)?;
                    Ok(receipt.command)
                })
                .transpose()
        })
        .collect::<RpcResult<_>>()?;
    context.transaction.validate().await?;
    Ok(commands)
}

async fn publish(
    service: &AuthService,
    request: &RequestContext,
    input: ReturnInput,
) -> RpcResult<ResourceCommand> {
    if input.tracking_id.0 <= 0 {
        return Err(invalid());
    }
    let scope = format!("tool-tracking:{}", input.tracking_id.encode());
    let domains = [format!("{scope}:master-data"), format!("{scope}:scope")];
    let mut context = metadata_context_for_domains(service, request, Some(&domains)).await?;
    let binding = resource_command_binding(&input.command.verification_key)?;
    verify_command(&input.command, &context.auth.tenant, &binding)?;
    let record = receipt_key(&binding);
    if let Some(receipt) = context
        .transaction
        .read::<ReturnReceipt>(record.clone())
        .await?
    {
        if receipt.scope != scope || receipt.actor != context.security.subject {
            return Err(forbidden());
        }
        verify_command(&receipt.command, &context.auth.tenant, &binding)?;
        if receipt.command.signature != input.command.signature {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(receipt.command);
    }

    let now = Utc::now().timestamp_millis();
    let issued = input.command.timestamp_millis()?;
    if issued < now - MAX_COMMAND_AGE_MS || issued > now + MAX_CLOCK_AHEAD_MS {
        return Err(conflict());
    }
    if !context.security.allows(
        &context.security.subject,
        &scope,
        Facet::MasterData,
        Action::Read,
    ) {
        return Err(forbidden());
    }
    let mut origins = return_origins(&mut context, &scope, &domains).await?;
    let master = &origins[0];
    if let Some(assignee) = &master.assignee
        && assignee.user != context.security.subject
    {
        return Err(forbidden());
    }
    let access = master.access.as_ref().ok_or_else(conflict)?;
    if !master.is_active_booking() || access.revision != input.command.revision {
        return Err(conflict());
    }
    if access.command_binding.as_deref() != Some(binding.as_str()) {
        return Err(forbidden());
    }
    check_command_binding(&mut context.transaction, &scope, Some(&binding), false).await?;
    let object = persistence::object(&mut context.transaction, &access.object)
        .await?
        .ok_or_else(conflict)?;
    if object.deleted
        || object.tombstone
        || object.revision != access.revision
        || object.domain != domains[0]
    {
        return Err(conflict());
    }
    let envelope = persistence::read(&context.repository, &object.reference).await?;
    persistence::check_read(
        &envelope,
        &object,
        &context.auth.tenant,
        &scope,
        Facet::MasterData,
    )?;
    if envelope.signature != access.packet_signature {
        return Err(conflict());
    }
    let receipt = ReturnReceipt {
        scope,
        actor: context.security.subject.clone(),
        command: input.command,
    };
    context.transaction.put_protected(record, &receipt).await?;
    let collection = registry::origin_collection(context.security.root.generation);
    let content_number = super::content::content_number(&mut context.transaction).await?;
    // Both heads are used by ordinary returns and transfers. Advancing them
    // rejects a transaction already prepared from the active checkout.
    for origin in &mut origins {
        origin.returned = Some(receipt.command.clone());
        origin.verify(&context.security.authority)?;
        context
            .transaction
            .put_protected(key(&collection, &origin.id), origin)
            .await?;
        let mut domain = registry::domain(&mut context.transaction, &origin.id).await?;
        domain.sequence = revision(&domain.sequence)?
            .checked_add(1)
            .ok_or_else(conflict)?
            .to_string();
        context
            .transaction
            .put(key("domains", &domain.id), &domain)
            .await?;
        context.transaction.notify(
            "object",
            &serde_json::json!({
                "domain": domain.id,
                "sequence": domain.content_sequence(content_number)?,
            }),
        )?;
    }
    super::setup::advance_catalog(&mut context.transaction, &context.auth.tenant).await?;
    context.transaction.notify(
        "access",
        &serde_json::json!({
            "policy": context.security.policy.version,
        }),
    )?;
    context
        .transaction
        .notify("tool-return", &serde_json::json!({}))?;
    context.transaction.commit().await?;
    Ok(receipt.command)
}

async fn return_origins(
    context: &mut MetadataContext,
    scope: &str,
    domains: &[String; 2],
) -> RpcResult<[CreationOrigin; 2]> {
    let collection = registry::origin_collection(context.security.root.generation);
    let keys = domains
        .iter()
        .map(|domain| key(&collection, domain))
        .collect();
    let mut sources = context
        .transaction
        .many::<CreationOrigin>(keys)
        .await?
        .into_iter();
    let master = sources.next().flatten().ok_or_else(conflict)?;
    let transfers = sources.next().flatten().ok_or_else(conflict)?;
    for (origin, (domain, facet)) in [&master, &transfers]
        .into_iter()
        .zip(domains.iter().zip([Facet::MasterData, Facet::Scope]))
    {
        if origin.id != *domain
            || origin.scope != scope
            || origin.facet != facet
            || origin.tenant != context.auth.tenant
            || origin.capability.generation != context.security.root.generation.to_string()
            || origin.capability.namespace != "tool-tracking"
            || origin.capability.signature != master.capability.signature
            || origin.assignee.as_ref().map(|member| &member.signature)
                != master.assignee.as_ref().map(|member| &member.signature)
            || origin.access.as_ref().map(|access| &access.signature)
                != master.access.as_ref().map(|access| &access.signature)
            || origin.returned.is_some()
        {
            return Err(conflict());
        }
        origin.verify(&context.security.authority)?;
    }
    Ok([master, transfers])
}
