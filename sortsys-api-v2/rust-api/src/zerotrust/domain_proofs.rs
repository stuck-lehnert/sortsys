//! Verify public writer evidence without returning user key packages.
use super::{
    access::metadata_context_for_domains,
    creation::CreationOrigin,
    crypto::{identifier, revision},
    objects::{DomainDefinition, KeyAuthority, packet_hash, registry},
    wire::{Action, Facet, SealedBox},
};
use crate::{
    auth::AuthService,
    error::RpcResult,
    error::forbidden,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ProofInput {
    domain: String,
    generation: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct DomainProof {
    format: String,
    tenant: String,
    id: String,
    scope: String,
    facet: Facet,
    generation: String,
    policy_version: String,
    envelope_hashes: Vec<String>,
    recovery_envelope: SealedBox,
    proof: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    creation: Option<CreationOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    key_authority: Option<KeyAuthority>,
}

async fn get(
    service: &AuthService,
    ctx: &RequestContext,
    input: ProofInput,
) -> RpcResult<DomainProof> {
    identifier(&input.domain)?;
    revision(&input.generation)?;
    let mut domains = vec![input.domain.clone()];
    if let Some((scope, _)) = input.domain.rsplit_once(':')
        && scope.starts_with("commercial:")
    {
        let master = format!("{scope}:master-data");
        if master != input.domain {
            domains.push(master);
        }
    }
    let mut context = metadata_context_for_domains(service, ctx, Some(&domains)).await?;
    let guard = &context.security;
    let area = registry::domain(&mut context.transaction, &input.domain).await?;
    let definition =
        registry::definition_at(&mut context.transaction, guard, &area, &input.generation).await?;
    let reads_area = guard.allows(
        &guard.subject,
        &definition.scope,
        definition.facet,
        Action::Read,
    );
    let reads_commercial_head = definition.scope.starts_with("commercial:")
        && guard.allows(
            &guard.subject,
            &definition.scope,
            Facet::MasterData,
            Action::Read,
        );
    if !reads_area && !reads_commercial_head {
        return Err(forbidden());
    }
    let proof = public_proof(definition)?;
    context.transaction.validate().await?;
    Ok(proof)
}

/// The same authenticated writer evidence is used for area readers and for
/// recipients of a single record. Recipient key envelopes are never included.
pub(super) fn public_proof(definition: DomainDefinition) -> RpcResult<DomainProof> {
    definition.frame()?;
    let envelope_hashes = definition
        .envelopes
        .iter()
        .map(|envelope| packet_hash(envelope.frame()?, &envelope.signature))
        .collect::<RpcResult<Vec<_>>>()?;
    let proof = DomainProof {
        format: "sortsys-domain-proof-v1".to_owned(),
        tenant: definition.tenant,
        id: definition.id,
        scope: definition.scope,
        facet: definition.facet,
        generation: definition.generation,
        policy_version: definition.policy_version,
        envelope_hashes,
        recovery_envelope: definition.recovery_envelope,
        proof: definition.proof,
        creation: definition.creation,
        key_authority: definition.key_authority,
    };
    Ok(proof)
}

pub(super) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    builder.query("zerotrust.domains.proof", move |ctx, input: ProofInput| {
        let service = Arc::clone(&service);
        async move { get(&service, &ctx, input).await }
    })
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<ProofInput, DomainProof>("zerotrust.domains.proof")
}
