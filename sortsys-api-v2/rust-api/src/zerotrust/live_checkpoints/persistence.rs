//! A live receipt and its native document are published in the same CAS batch.
use super::*;
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    zerotrust::{
        access::MetadataContext, document_messages::persistence as messages,
        objects::persistence as objects,
    },
};

pub(in crate::zerotrust) async fn state(
    transaction: &mut Transaction,
    room: &Room,
) -> RpcResult<LiveState> {
    let channel = messages::channel_state(transaction, room).await?;
    let checkpoint: Option<LiveCheckpoint> = transaction
        .read(key("live-checkpoint-heads", &messages::room_key(room)?))
        .await?;
    if let Some(proof) = &checkpoint {
        proof.frame()?;
        if proof.scope != room.scope
            || proof.document != room.document
            || proof.facet != room.facet
            || position(&proof.sequence)? > position(&channel.current)?
        {
            return Err(invalid());
        }
    }
    Ok(LiveState {
        current: channel.current,
        checkpoint,
        content: super::super::content::fingerprint(transaction).await?,
    })
}

async fn previous_target(
    context: &mut MetadataContext,
    target: &Target,
) -> RpcResult<Option<String>> {
    let room = &target.room;
    if room.scope.starts_with("commercial:") {
        let previous: Option<DocumentHead> = context
            .transaction
            .read(key("documents", &room.document))
            .await?;
        if let Some(head) = previous {
            if head.scope != room.scope || head.id != room.document {
                return Err(forbidden());
            }
            return Ok(Some(head.part_target(&room.facet)?));
        }
        return Ok(None);
    }
    let project = room.scope.strip_prefix("project:").ok_or_else(invalid)?;
    let id = format!("project-files:{project}:file:{}", room.document);
    let previous = objects::object(&mut context.transaction, &id).await?;
    if let Some(file) = previous
        && !file.deleted
        && !file.tombstone
    {
        let envelope = objects::read(&context.repository, &file.reference).await?;
        return Ok(Some(packet_hash(envelope.frame()?, &envelope.signature)?));
    }
    Ok(None)
}

pub(in crate::zerotrust) struct Prepared {
    proofs: Vec<LiveCheckpoint>,
}

pub(in crate::zerotrust) async fn prepare(
    context: &mut MetadataContext,
    documents: &[DocumentHead],
    objects: &[SaveInput],
    proofs: &[LiveCheckpoint],
) -> RpcResult<Prepared> {
    let Targets { targets, selected } = collect_targets(documents, objects, proofs)?;
    let mut accepted = Vec::new();
    for (room_key, target) in targets {
        let previous_hash = previous_target(context, &target).await?;
        let unchanged = previous_hash.as_deref() == Some(target.hash.as_str());
        let proof = selected.get(&room_key).copied();
        if target.current_target {
            messages::authorize(context, &target.room, true).await?;
            if !unchanged {
                return Err(conflict());
            }
        } else if proof.is_none() && (previous_hash.is_none() || unchanged && !target.frozen) {
            // A channel cannot predate the first document. An unchanged part
            // keeps its earlier receipt while newer edits are still pending.
            continue;
        }
        let current = state(&mut context.transaction, &target.room).await?;
        if target.deletion && proof.is_none() {
            continue;
        }
        let Some(proof) = proof else {
            if current.current == "0" && current.checkpoint.is_none() {
                continue;
            }
            let already_covered = current.checkpoint.as_ref().is_some_and(|receipt| {
                receipt.target == target.hash && receipt.covered == current.current
            });
            if target.frozen && unchanged && already_covered {
                continue;
            }
            return Err(conflict());
        };
        if proof.content != current.content {
            return Err(conflict());
        }
        messages::authorize(context, &target.room, false).await?;
        let guard = &context.security;
        if target.room.keys()?.into_iter().any(|facet| {
            !guard.allows(
                &guard.subject,
                &target.room.scope,
                facet,
                super::super::wire::Action::Update,
            )
        }) {
            return Err(forbidden());
        }
        if proof.tenant != context.auth.tenant
            || proof.author != guard.subject
            || proof.target != target.hash
            || revision(&proof.generation)? != guard.root.generation
            || revision(&proof.policy_version)? != guard.root.policy_version
        {
            return Err(forbidden());
        }
        verify(&guard.signing_key, &proof.signature, &proof.frame()?)?;
        let existing: Option<LiveCheckpoint> = context
            .transaction
            .read(key(
                "live-checkpoint-proofs",
                &format!("s_{}", proof.signature),
            ))
            .await?;
        if let Some(existing) = &existing
            && existing.frame()? != proof.frame()?
        {
            return Err(invalid());
        }
        // Reusing a known receipt must never finalize unseen later messages or
        // replace a newer native part with its previous content.
        if existing.is_none() || target.frozen || !unchanged {
            if proof.sequence != current.current
                || target.frozen && proof.covered != current.current
            {
                return Err(conflict());
            }
            if let Some(previous) = &current.checkpoint
                && position(&previous.covered)? > position(&proof.covered)?
            {
                return Err(conflict());
            }
        }
        if let Some(replay) = &proof.replay
            && existing.is_none()
        {
            if target.frozen || target.deletion {
                return Err(conflict());
            }
            for key in &replay.keys {
                let area = super::super::objects::metadata_current_domain(
                    &mut context.transaction,
                    guard,
                    &format!("{}:{}", target.room.scope, key.facet.name()),
                )
                .await?;
                if area.scope != target.room.scope
                    || area.facet != key.facet
                    || area.generation != key.generation
                {
                    return Err(conflict());
                }
            }
            super::super::documents::verify_part_reference(
                &mut context.transaction,
                &context.repository,
                &target.room.scope,
                replay,
            )
            .await?;
        }
        accepted.push(proof.clone());
    }
    Ok(Prepared { proofs: accepted })
}

impl Prepared {
    pub(in crate::zerotrust) async fn commit(
        self,
        transaction: &mut Transaction,
    ) -> RpcResult<bool> {
        let mut changed = false;
        for proof in self.proofs {
            let record = key("live-checkpoint-proofs", &format!("s_{}", proof.signature));
            let existing: Option<LiveCheckpoint> = transaction.read(record.clone()).await?;
            if existing.is_some() {
                continue;
            }
            let room = Room {
                scope: proof.scope.clone(),
                document: proof.document.clone(),
                facet: proof.facet.clone(),
            };
            transaction.put(record, &proof).await?;
            transaction
                .put(
                    key("live-checkpoint-heads", &messages::room_key(&room)?),
                    &proof,
                )
                .await?;
            changed = true;
        }
        Ok(changed)
    }
}

pub(in crate::zerotrust) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    builder.query(
        "zerotrust.documents.messages.state",
        move |ctx, room: Room| {
            let service = Arc::clone(&service);
            async move {
                let mut context = messages::context(&service, &ctx, &room).await?;
                messages::authorize_state(&mut context, &room).await?;
                let result = state(&mut context.transaction, &room).await?;
                context.transaction.validate().await?;
                Ok(result)
            }
        },
    )
}
