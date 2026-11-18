//! Ordered encrypted channels, with shared CAS guards for document publication.
use super::*;
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    error::ErrorCode,
    zerotrust::{
        access::{MetadataContext, metadata_context_for_domains},
        objects::{persistence, registry},
    },
};
use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};

const MAX_ATTEMPTS: usize = 32;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct ChannelState {
    room: Room,
    pub current: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMessage {
    sequence: String,
    kind: Kind,
    key: String,
    authority_generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    signature: String,
    reference: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presence {
    subject: String,
    session: String,
    expires_at: DateTime<Utc>,
    message: Message,
}

pub(in crate::zerotrust) fn room_key(room: &Room) -> RpcResult<String> {
    room.keys()?;
    let frame = super::super::crypto::frame(
        "sortsys/document-channel/v1",
        &[&room.scope, &room.document, &room.facet],
    );
    Ok(format!(
        "r_{}",
        super::super::crypto::encode(&Sha256::digest(frame))
    ))
}

fn message_collection(room: &Room) -> RpcResult<String> {
    Ok(format!("live-messages-{}", room_key(room)?))
}

fn presence_collection(room: &Room) -> RpcResult<String> {
    Ok(format!("live-presence-{}", room_key(room)?))
}

fn message_key(
    room: &Room,
    kind: Kind,
    key_value: &str,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    message_object(room, kind, key_value, None)?;
    Ok(key(
        "live-message-receipts",
        &format!("{}:{}:{key_value}", room_key(room)?, kind.name()),
    ))
}

pub(in crate::zerotrust) async fn channel_state(
    transaction: &mut Transaction,
    room: &Room,
) -> RpcResult<ChannelState> {
    let saved: Option<ChannelState> = transaction
        .read(key("live-rooms", &room_key(room)?))
        .await?;
    let state = saved.unwrap_or_else(|| ChannelState {
        room: room.clone(),
        current: "0".into(),
    });
    if state.room != *room || super::super::live_checkpoints::position(&state.current)? < 0 {
        return Err(invalid());
    }
    Ok(state)
}

/// Resolve only the grants relevant to this channel, rather than listing every
/// project in the tenant for each keystroke or cursor update.
pub(in crate::zerotrust) async fn context(
    service: &AuthService,
    request: &RequestContext,
    room: &Room,
) -> RpcResult<MetadataContext> {
    let domains = room.access_domains()?;
    metadata_context_for_domains(service, request, Some(&domains)).await
}

pub(in crate::zerotrust) async fn authorize_state(
    context: &mut MetadataContext,
    room: &Room,
) -> RpcResult<()> {
    room.keys()?;
    if !room.scope.starts_with("commercial:") {
        authorize(context, room, false).await?;
        return Ok(());
    }
    let guard = &context.security;
    if !guard.allows(&guard.subject, &room.scope, Facet::MasterData, Action::Read) {
        return Err(forbidden());
    }
    let head: DocumentHead = context
        .transaction
        .read(key("documents", &room.document))
        .await?
        .ok_or_else(forbidden)?;
    if head.scope != room.scope || head.id != room.document {
        return Err(forbidden());
    }
    Ok(())
}

pub(in crate::zerotrust) async fn authorize(
    context: &mut MetadataContext,
    room: &Room,
    writing: bool,
) -> RpcResult<(Facet, String)> {
    let guard = &context.security;
    let facets = room.keys()?;
    if room.scope.starts_with("commercial:") {
        if !guard.allows(&guard.subject, &room.scope, Facet::MasterData, Action::Read) {
            return Err(forbidden());
        }
        let head: DocumentHead = context
            .transaction
            .read(key("documents", &room.document))
            .await?
            .ok_or_else(forbidden)?;
        if head.scope != room.scope
            || head.id != room.document
            || writing && (head.locked || head.read_only)
        {
            return Err(forbidden());
        }
    } else {
        let owner = room.scope.strip_prefix("project:").ok_or_else(invalid)?;
        let id = format!("project-files:{owner}:file:{}", room.document);
        let file = persistence::object(&mut context.transaction, &id)
            .await?
            .ok_or_else(forbidden)?;
        if file.deleted || file.tombstone || file.domain != format!("{}:attachment", room.scope) {
            return Err(forbidden());
        }
    }
    let outer = room.outer()?;
    let mut outer_generation = None;
    let mut rotations = registry::RotationChecks::new(guard);
    for facet in facets {
        if !guard.allows(&guard.subject, &room.scope, facet, Action::Read)
            || writing && !guard.allows(&guard.subject, &room.scope, facet, Action::Update)
        {
            return Err(forbidden());
        }
        let area = registry::domain(
            &mut context.transaction,
            &format!("{}:{}", room.scope, facet.name()),
        )
        .await?;
        if area.scope != room.scope || area.facet != facet {
            return Err(invalid());
        }
        if writing
            && rotations
                .required(&mut context.transaction, guard, &area)
                .await?
        {
            return Err(conflict());
        }
        if facet == outer {
            outer_generation = Some(area.generation);
        }
    }
    Ok((outer, outer_generation.ok_or_else(forbidden)?))
}

fn notify(transaction: &mut Transaction, room: &Room, facet: Facet) -> RpcResult<()> {
    transaction.notify("document-message", &json!({"kind":"document-message", "scope":room.scope, "document":room.document, "facet":facet.name(), "channel":room.facet}))
}

async fn post_attempt(
    service: &AuthService,
    request: &RequestContext,
    input: &Post,
) -> RpcResult<bool> {
    let object = message_object(
        &input.room,
        input.kind,
        &input.key,
        input.content.as_deref(),
    )?;
    if input.envelope.ciphertext.len() > 192 * 1024 {
        return Err(invalid());
    }
    let mut context = context(service, request, &input.room).await?;
    let (facet, generation) =
        authorize(&mut context, &input.room, input.kind != Kind::Presence).await?;
    super::super::content::require_current(&mut context.transaction, input.content.as_deref())
        .await?;
    let envelope = &input.envelope;
    let guard = &context.security;
    envelope.verify(&guard.signing_key)?;
    if envelope.tenant != context.auth.tenant
        || envelope.scope != input.room.scope
        || envelope.facet != facet
        || envelope.object != object
        || envelope.author != guard.subject
        || envelope.is_tombstone()
        || envelope.generation != generation
        || revision(&envelope.policy_version)? != guard.root.policy_version
        || revision(&input.authority_generation)? != guard.root.generation
        || input.kind != Kind::Presence && envelope.revision != "1"
    {
        return Err(conflict());
    }
    if input.kind == Kind::Presence {
        let record = key(
            &presence_collection(&input.room)?,
            &format!("p_{}", input.key),
        );
        let previous: Option<Presence> = context.transaction.read(record.clone()).await?;
        if let Some(previous) = previous
            && previous.message.content == input.content
        {
            if previous.subject != guard.subject || previous.session != context.auth.session.id {
                return Err(conflict());
            }
            let old_revision = revision(&previous.message.envelope.revision)?;
            let new_revision = revision(&envelope.revision)?;
            if old_revision >= new_revision {
                if old_revision != new_revision
                    || previous.message.envelope.signature != envelope.signature
                {
                    return Err(conflict());
                }
                // A retransmission never extends the original presence TTL.
                return match context.transaction.validate().await {
                    Ok(()) => Ok(true),
                    Err(error) if error.code == ErrorCode::Conflict => Ok(false),
                    Err(error) => Err(error),
                };
            }
        }
        let expires_at = Utc::now() + Duration::seconds(45);
        let presence = Presence {
            subject: guard.subject.clone(),
            session: context.auth.session.id.clone(),
            expires_at,
            message: Message {
                sequence: "0".into(),
                kind: Kind::Presence,
                key: input.key.clone(),
                authority_generation: input.authority_generation.clone(),
                content: input.content.clone(),
                envelope: envelope.clone(),
            },
        };
        context
            .transaction
            .put_expiring(record, &presence, expires_at)
            .await?;
    } else {
        let receipt_key = message_key(&input.room, input.kind, &input.key)?;
        let previous: Option<StoredMessage> = context.transaction.read(receipt_key.clone()).await?;
        if let Some(previous) = previous {
            if input.kind == Kind::Update && previous.signature != envelope.signature {
                return Err(conflict());
            }
            return match context.transaction.validate().await {
                Ok(()) => Ok(true),
                Err(error) if error.code == ErrorCode::Conflict => Ok(false),
                Err(error) => Err(error),
            };
        }
        let mut channel = channel_state(&mut context.transaction, &input.room).await?;
        let next = super::super::live_checkpoints::position(&channel.current)?
            .checked_add(1)
            .ok_or_else(conflict)?;
        let reference = context
            .repository
            .put_ciphertext(serde_json::to_string(envelope).map_err(internal)?)
            .await?;
        let message = StoredMessage {
            sequence: next.to_string(),
            kind: input.kind,
            key: input.key.clone(),
            authority_generation: input.authority_generation.clone(),
            content: input.content.clone(),
            signature: envelope.signature.clone(),
            reference,
        };
        context
            .transaction
            .put(
                key(&message_collection(&input.room)?, &format!("{next:020}")),
                &message,
            )
            .await?;
        context.transaction.put(receipt_key, &message).await?;
        channel.current = next.to_string();
        context
            .transaction
            .put(key("live-rooms", &room_key(&input.room)?), &channel)
            .await?;
    }
    notify(&mut context.transaction, &input.room, facet)?;
    match context.transaction.commit().await {
        Ok(_) => Ok(true),
        Err(error) if error.code == ErrorCode::Conflict => Ok(false),
        Err(error) => Err(error),
    }
}

async fn post(service: &AuthService, request: &RequestContext, input: Post) -> RpcResult<Success> {
    for attempt in 0..MAX_ATTEMPTS {
        if post_attempt(service, request, &input).await? {
            if input.kind == Kind::Presence && revision(&input.envelope.revision)? % 32 == 1 {
                // Cleanup is best effort; read-time TTL checks remain binding.
                // A room opening and occasional heartbeats retire old entries
                // without adding a cleanup transaction to every cursor move.
                let auth = service.authenticate(&request.headers).await?;
                let repository = service.records()?.tenant(&auth.tenant)?;
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(1),
                        repository.cleanup_expired(),
                    )
                    .await;
                });
            }
            return Ok(Success { success: true });
        }
        tokio::time::sleep(std::time::Duration::from_millis(1 + (attempt % 5) as u64)).await;
    }
    Err(conflict())
}

async fn read(service: &AuthService, request: &RequestContext, input: Read) -> RpcResult<Page> {
    let mut context = context(service, request, &input.room).await?;
    let page = read_page(&mut context, input).await?;
    context.transaction.validate().await?;
    Ok(page)
}

async fn read_pages(
    service: &AuthService,
    request: &RequestContext,
    input: ReadBatch,
) -> RpcResult<Vec<Page>> {
    let domains = input.domains()?;
    let mut context = metadata_context_for_domains(service, request, Some(&domains)).await?;
    let mut pages = Vec::with_capacity(input.selections.len());
    let mut bytes = 0usize;
    for selection in input.selections {
        let page = read_page(&mut context, selection).await?;
        bytes += serde_json::to_vec(&page).map_err(internal)?.len();
        if bytes > 8 * 1024 * 1024 {
            return Err(crate::error::RpcError::new(
                ErrorCode::BadRequest,
                "Encrypted channel batch exceeds the response limit",
            )
            .with_http_code(413));
        }
        pages.push(page);
    }
    // All channel reads share authorization and snapshot guards. A conflict or
    // denied channel discards the entire batch before any page is returned.
    context.transaction.validate().await?;
    Ok(pages)
}

async fn read_page(context: &mut MetadataContext, input: Read) -> RpcResult<Page> {
    let after = super::super::live_checkpoints::position(&input.after)?;
    authorize(context, &input.room, false).await?;
    super::super::content::require_current(&mut context.transaction, input.content.as_deref())
        .await?;
    let page = context
        .transaction
        .scan_with_limit::<StoredMessage>(
            &message_collection(&input.room)?,
            Some(format!("{after:020}")),
            33,
        )
        .await?;
    let more = page.records.len() > 32;
    let mut messages = Vec::new();
    let mut after = input.after;
    for record in page.records.into_iter().take(32) {
        let stored = record.value.ok_or_else(invalid)?;
        if record.record.key != format!("{:020}", revision(&stored.sequence)?)
            || stored.kind == Kind::Presence
        {
            return Err(invalid());
        }
        let envelope = persistence::read(&context.repository, &stored.reference).await?;
        let object = message_object(
            &input.room,
            stored.kind,
            &stored.key,
            stored.content.as_deref(),
        )?;
        if envelope.object != object || envelope.signature != stored.signature {
            return Err(invalid());
        }
        after = stored.sequence.clone();
        messages.push(Message {
            sequence: stored.sequence,
            kind: stored.kind,
            key: stored.key,
            authority_generation: stored.authority_generation,
            content: stored.content,
            envelope,
        });
    }
    let now = Utc::now();
    let mut presence = Vec::new();
    let mut presence_after = None;
    loop {
        let page = context
            .transaction
            .scan_with_limit::<Presence>(&presence_collection(&input.room)?, presence_after, 32)
            .await?;
        for row in page.records {
            let stored = row.value.ok_or_else(invalid)?;
            if stored.expires_at > now && stored.message.content == input.content {
                presence.push(stored.message);
                if presence.len() == 32 {
                    break;
                }
            }
        }
        if presence.len() == 32 || page.after.is_none() {
            break;
        }
        presence_after = page.after;
    }
    Ok(Page {
        messages,
        presence,
        after,
        more,
    })
}

pub(in crate::zerotrust) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let writer = Arc::clone(&service);
    let reader = Arc::clone(&service);
    builder
        .mutation("zerotrust.documents.messages.post", move |ctx, input| {
            let service = Arc::clone(&writer);
            async move { post(&service, &ctx, input).await }
        })
        .query("zerotrust.documents.messages.read", move |ctx, input| {
            let service = Arc::clone(&reader);
            async move { read(&service, &ctx, input).await }
        })
        .query("zerotrust.documents.messages.pages", move |ctx, input| {
            let service = Arc::clone(&service);
            async move { read_pages(&service, &ctx, input).await }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_hashes_are_valid_metadata_keys_for_every_base64url_prefix() {
        for number in 1..256 {
            let room = Room {
                scope: "commercial:1".into(),
                document: Id(number).encode(),
                facet: "scope".into(),
            };
            key("live-rooms", &room_key(&room).unwrap())
                .validate()
                .unwrap();
            message_key(&room, Kind::Update, &format!("_{}", "a".repeat(42)))
                .unwrap()
                .validate()
                .unwrap();
        }
    }
}
