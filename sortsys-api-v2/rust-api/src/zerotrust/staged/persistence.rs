//! Native staging stores only immutable ciphertexts. Authorization and every
//! expected version are checked again in the final shared transaction.
use super::*;
use crate::{
    auth::AuthService,
    zerotrust::{access::metadata_context, objects},
};
use std::collections::BTreeMap;

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let upload = Arc::clone(&service);
    builder
        .mutation("zerotrust.objects.stage", move |ctx, input: StageInput| {
            let service = Arc::clone(&upload);
            async move { stage(&service, &ctx, input).await }
        })
        .mutation(
            "zerotrust.objects.commit",
            move |ctx, input: CommitInput| {
                let service = Arc::clone(&service);
                async move { commit(&service, &ctx, input).await }
            },
        )
}

async fn stage(
    service: &AuthService,
    request: &RequestContext,
    input: StageInput,
) -> RpcResult<StageResult> {
    if input.objects.is_empty()
        || input.objects.len() > 64
        || input
            .objects
            .iter()
            .map(|packet| packet.envelope.ciphertext.len())
            .sum::<usize>()
            > 22 * 1024 * 1024
    {
        return Err(invalid());
    }
    let mut context = metadata_context(service, request).await?;
    let mut areas = BTreeMap::new();
    let mut rotation = objects::registry::RotationChecks::new(&context.security);
    for packet in &input.objects {
        identifier(&packet.domain)?;
        identifier(&packet.message_id)?;
        let envelope = &packet.envelope;
        envelope.verify(&context.security.signing_key)?;
        super::super::bootstrap::check_archive_write(
            &mut context,
            &envelope.scope,
            &envelope.revision,
        )
        .await?;
        super::super::immutable::validate_packet(packet)?;
        if let Some(origin) = &packet.migration_origin {
            super::super::bootstrap::require_pending(&mut context).await?;
            origin.verify_authority(envelope, &context.security)?;
        } else if envelope.object.starts_with("legacy-activity:") {
            return Err(invalid());
        }
        if !areas.contains_key(&packet.domain) {
            let area = objects::registry::domain(&mut context.transaction, &packet.domain).await?;
            if rotation
                .required(&mut context.transaction, &context.security, &area)
                .await?
            {
                return Err(objects::conflict());
            }
            areas.insert(packet.domain.clone(), area);
        }
        let area = &areas[&packet.domain];
        if envelope.tenant != context.auth.tenant
            || envelope.author != context.security.subject
            || envelope.scope != area.scope
            || envelope.facet != area.facet
            || envelope.generation != area.generation
            || envelope.policy_version != context.security.policy.version
        {
            return Err(objects::conflict());
        }
        if !context.security.allows(
            &context.security.subject,
            &area.scope,
            area.facet,
            Action::Read,
        ) || ![
            Action::Create,
            Action::Update,
            Action::Delete,
            Action::Approve,
        ]
        .into_iter()
        .any(|action| {
            context
                .security
                .allows(&context.security.subject, &area.scope, area.facet, action)
        }) {
            return Err(forbidden());
        }
        super::super::stock::verify_references(
            &context.security,
            &context.auth.tenant,
            &packet.domain,
            envelope,
            packet.references.as_ref(),
        )?;
    }
    context.transaction.validate().await?;
    let envelopes = input
        .objects
        .iter()
        .map(|packet| {
            serde_json::to_value(&packet.envelope)
                .map(|value| value.to_string())
                .map_err(internal)
        })
        .collect::<RpcResult<Vec<_>>>()?;
    context.repository.put_ciphertexts(envelopes).await?;
    let encoded = serde_json::to_string(&StagedObjects {
        format: "sortsys-staged-objects-v1".into(),
        tenant: context.auth.tenant,
        subject: context.security.subject,
        objects: input.objects,
    })
    .map_err(internal)?;
    if encoded.len() > crate::quack_store::MAX_CIPHERTEXT_BYTES {
        return Err(invalid());
    }
    Ok(StageResult {
        id: context.repository.put_ciphertext(encoded).await?,
    })
}

async fn commit(
    service: &AuthService,
    request: &RequestContext,
    input: CommitInput,
) -> RpcResult<BatchResult> {
    let mut seen = std::collections::HashSet::new();
    if input.parts.is_empty()
        || input.parts.len() > 2501
        || input
            .parts
            .iter()
            .any(|id| !sortsys_store::valid_id(id) || !seen.insert(id))
    {
        return Err(invalid());
    }
    let context = metadata_context(service, request).await?;
    let mut objects = Vec::new();
    let mut size = 0usize;
    for id in input.parts {
        let encoded = context.repository.ciphertext(&id).await?;
        size = size.checked_add(encoded.len()).ok_or_else(invalid)?;
        if size > 384 * 1024 * 1024 {
            return Err(invalid());
        }
        let staged: StagedObjects = serde_json::from_str(&encoded).map_err(|_| invalid())?;
        if staged.format != "sortsys-staged-objects-v1"
            || staged.tenant != context.auth.tenant
            || staged.subject != context.security.subject
        {
            return Err(forbidden());
        }
        objects.extend(staged.objects);
        if objects.len() > 40_001 {
            return Err(invalid());
        }
    }
    objects::persistence::commit_staged_batch(
        service,
        request,
        BatchInput {
            objects,
            heads: Some(input.heads),
            documents: None,
            live_checkpoints: input.live_checkpoints,
            member: input.member,
            policy: input.policy,
        },
    )
    .await
}
