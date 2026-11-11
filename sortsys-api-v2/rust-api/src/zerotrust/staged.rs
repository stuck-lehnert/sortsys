//! Uploads remain invisible until one ordinary authorization/CAS transaction
//! publishes the complete batch. No business plaintext enters this service.
use super::{
    access::security,
    crypto::{identifier, invalid, revision},
    objects::{BatchInput, BatchResult, DomainHead, SaveInput, commit_batch},
    wire::Action,
};
use crate::{
    AppState,
    error::RpcResult,
    procedures::common::{authenticated_pool, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
struct StageInput {
    objects: Vec<SaveInput>,
}
#[derive(Serialize, TS)]
struct StageResult {
    id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StagedObjects {
    format: String,
    tenant: String,
    subject: String,
    objects: Vec<SaveInput>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CommitInput {
    parts: Vec<String>,
    heads: Vec<DomainHead>,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let upload = Arc::clone(&state);
    builder
        .mutation("zerotrust.objects.stage", move |ctx, input: StageInput| {
            let state = Arc::clone(&upload);
            async move { stage(&state, &ctx, input).await }
        })
        .mutation(
            "zerotrust.objects.commit",
            move |ctx, input: CommitInput| {
                let state = Arc::clone(&state);
                async move { commit(&state, &ctx, input).await }
            },
        )
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<StageInput, StageResult>("zerotrust.objects.stage")
        .mutation_stub::<CommitInput, BatchResult>("zerotrust.objects.commit")
}
fn unavailable() -> crate::error::RpcError {
    crate::error::RpcError::new(
        crate::error::ErrorCode::InternalServerError,
        "Encrypted staging is unavailable",
    )
    .with_http_code(503)
}
async fn stage(
    state: &AppState,
    ctx: &RequestContext,
    input: StageInput,
) -> RpcResult<StageResult> {
    if input.objects.is_empty()
        || input.objects.len() > 64
        || input
            .objects
            .iter()
            .map(|p| p.envelope.ciphertext.len())
            .sum::<usize>()
            > 22 * 1024 * 1024
    {
        return Err(invalid());
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    for packet in &input.objects {
        identifier(&packet.message_id)?;
        identifier(&packet.domain)?;
        let envelope = &packet.envelope;
        envelope.verify(&guard.signing_key)?;
        let area: Option<(String, String, i64, bool)> = sqlx::query_as(
            "SELECT scope,facet,generation,rotation_required FROM __zerotrust_domains WHERE id=$1",
        )
        .bind(&packet.domain)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let (scope, facet, generation, rotating) = area.ok_or_else(invalid)?;
        if envelope.tenant != auth.tenant
            || envelope.author != guard.subject
            || envelope.scope != scope
            || envelope.facet.name() != facet
            || revision(&envelope.generation)? != generation
            || revision(&envelope.policy_version)? != guard.root.policy_version
            || rotating
        {
            return Err(super::objects::conflict());
        }
        if !guard.allows(&guard.subject, &scope, envelope.facet, Action::Read)
            || ![Action::Create, Action::Update]
                .iter()
                .any(|action| guard.allows(&guard.subject, &scope, envelope.facet, *action))
        {
            return Err(forbidden());
        }
        super::stock::verify_references(
            &guard,
            &auth.tenant,
            &packet.domain,
            envelope,
            packet.references.as_ref(),
        )?;
    }
    let data = serde_json::to_string(&StagedObjects {
        format: "sortsys-staged-objects-v1".into(),
        tenant: auth.tenant.clone(),
        subject: guard.subject,
        objects: input.objects.clone(),
    })
    .map_err(internal)?;
    if data.len() > crate::quack_store::MAX_CIPHERTEXT_BYTES {
        return Err(invalid());
    }
    // Every immutable object is durable before the stage receipt is returned.
    // A later commit can publish references without another storage round trip.
    let store = state.ciphertexts.as_ref().ok_or_else(unavailable)?;
    let envelopes = input
        .objects
        .iter()
        .map(|packet| {
            serde_json::to_value(&packet.envelope)
                .map(|value| value.to_string())
                .map_err(internal)
        })
        .collect::<RpcResult<Vec<_>>>()?;
    store
        .put_many(&auth.tenant, envelopes)
        .await
        .map_err(|_| unavailable())?;
    let id = store
        .put(&auth.tenant, data)
        .await
        .map_err(|_| unavailable())?;
    Ok(StageResult { id })
}
async fn commit(
    state: &AppState,
    ctx: &RequestContext,
    input: CommitInput,
) -> RpcResult<BatchResult> {
    if input.parts.is_empty()
        || input.parts.len() > 2501
        || input.parts.iter().any(|part| {
            part.len() != 64
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        || input
            .parts
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != input.parts.len()
    {
        return Err(invalid());
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let subject = {
        let mut tx = pool.begin().await.map_err(internal)?;
        security(&mut tx, state.tenants.master(), &auth, false)
            .await?
            .subject
    };
    let store = state.ciphertexts.as_ref().ok_or_else(unavailable)?;
    let mut objects = Vec::new();
    let mut bytes = 0usize;
    for part in input.parts {
        let data = store
            .get(&auth.tenant, &part)
            .await
            .map_err(|_| unavailable())?;
        bytes += data.len();
        if bytes > 384 * 1024 * 1024 {
            return Err(invalid());
        }
        let staged: StagedObjects = serde_json::from_str(&data).map_err(|_| invalid())?;
        if staged.format != "sortsys-staged-objects-v1"
            || staged.tenant != auth.tenant
            || staged.subject != subject
        {
            return Err(forbidden());
        }
        objects.extend(staged.objects);
        if objects.len() > 40_001 {
            return Err(invalid());
        }
    }
    commit_batch(
        state,
        ctx,
        BatchInput {
            objects,
            heads: Some(input.heads),
            documents: None,
        },
        true,
    )
    .await
}
