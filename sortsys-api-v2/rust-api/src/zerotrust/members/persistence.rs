//! Technical member identities share one record with their optional credential.
use super::super::access::{MetadataContext, metadata_context};
use super::*;
use crate::{
    auth::AuthService,
    control::{accounts, key},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reservation {
    creation: MemberCreation,
    created_at: DateTime<Utc>,
}
fn admin(context: &MetadataContext) -> RpcResult<()> {
    if !context.auth.is_admin() {
        return Err(forbidden());
    }
    Ok(())
}
fn status_row(account: &accounts::Account) -> StatusRow {
    StatusRow {
        username: account.username.clone(),
        modified_at: account.modified_at,
        deactivated_at: account.deactivated_at,
        archived_at: account.archived_at,
        deleted_at: account.deleted_at,
        stamp: Utc::now(),
    }
}
async fn create(
    service: &AuthService,
    request: &RequestContext,
    input: MemberCreation,
) -> RpcResult<Success> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    if input.tenant != context.auth.tenant
        || input.author != context.security.subject
        || revision(&input.generation)? != context.security.root.generation
    {
        return Err(forbidden());
    }
    verify(&context.security.authority, &input.proof, &input.frame()?)?;
    let user = input.user_id()?;
    let proof_key = key("member-creations", &input.id);
    if let Some(previous) = context
        .transaction
        .read::<Reservation>(proof_key.clone())
        .await?
    {
        if previous.creation != input {
            return Err(conflict());
        }
        let account: accounts::Account = context
            .transaction
            .read(accounts::account_key(user.0))
            .await?
            .ok_or_else(conflict)?;
        if account.username != input.username || account.deleted_at.is_some() {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(Success { success: true });
    }
    if context
        .transaction
        .read::<accounts::Account>(accounts::account_key(user.0))
        .await?
        .is_some()
        || context
            .transaction
            .read::<accounts::Username>(key("usernames", &input.username))
            .await?
            .is_some()
    {
        return Err(conflict());
    }
    let now = Utc::now();
    if let Some(source) = &input.source {
        super::super::bootstrap::require_pending_context(&mut context, &source.context).await?;
    }
    let source = input.source.as_ref();
    let account = accounts::Account {
        id: user.0,
        username: input.username.clone(),
        locale: source
            .map(|source| source.locale.clone())
            .unwrap_or_else(|| "de".into()),
        epoch: 1,
        roles: vec![],
        created_at: source
            .map(|source| micros(&source.created_micros))
            .transpose()?
            .unwrap_or(now),
        modified_at: source
            .map(|source| micros(&source.modified_micros))
            .transpose()?
            .unwrap_or(now),
        deactivated_at: source
            .and_then(|source| source.deactivated_micros.as_deref())
            .map(micros)
            .transpose()?,
        archived_at: source
            .and_then(|source| source.archived_micros.as_deref())
            .map(micros)
            .transpose()?,
        deleted_at: None,
        credential: None,
    };
    context
        .transaction
        .put_protected(accounts::account_key(user.0), &account)
        .await?;
    context
        .transaction
        .put(
            key("usernames", &input.username),
            &accounts::Username { user_id: user.0 },
        )
        .await?;
    context
        .transaction
        .put(
            proof_key,
            &Reservation {
                creation: input,
                created_at: now,
            },
        )
        .await?;
    context
        .transaction
        .put(key("member-directory", &format!("{:020}", user.0)), &user.0)
        .await?;
    context.transaction.notify(
        "account",
        &serde_json::json!({"subject": format!("user:{}", user.encode())}),
    )?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
async fn creation(
    service: &AuthService,
    request: &RequestContext,
    input: CreationId,
) -> RpcResult<CreatedMember> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let row: Reservation = context
        .transaction
        .read(key("member-creations", &input.id.encode()))
        .await?
        .ok_or_else(not_found)?;
    context.transaction.validate().await?;
    Ok(CreatedMember {
        creation: row.creation,
        created_at: row.created_at,
    })
}
async fn status(
    service: &AuthService,
    request: &RequestContext,
    input: CreationId,
) -> RpcResult<MemberStatus> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let account: accounts::Account = context
        .transaction
        .read(accounts::account_key(input.id.0))
        .await?
        .ok_or_else(not_found)?;
    let row = status_row(&account);
    let result = MemberStatus {
        username: account.username.clone(),
        id: input.id,
        version: row.version(input.id),
        at_micros: row.stamp.timestamp_micros().to_string(),
        deactivated_micros: row
            .deactivated_at
            .map(|at| at.timestamp_micros().to_string()),
        archived_micros: row.archived_at.map(|at| at.timestamp_micros().to_string()),
        deleted_micros: row.deleted_at.map(|at| at.timestamp_micros().to_string()),
    };
    context.transaction.validate().await?;
    Ok(result)
}
async fn receipt(
    service: &AuthService,
    request: &RequestContext,
    input: ChangeReceiptId,
) -> RpcResult<MemberChange> {
    identifier(&input.request_id)?;
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let change = context
        .transaction
        .read(key("member-changes", &input.request_id))
        .await?
        .ok_or_else(not_found)?;
    context.transaction.validate().await?;
    Ok(change)
}
pub(in crate::zerotrust) async fn apply_change(
    context: &mut MetadataContext,
    input: &MemberChange,
    objects: &[SaveInput],
) -> RpcResult<()> {
    admin(context)?;
    let guard = &context.security;
    if input.tenant != guard.policy.tenant
        || input.generation != guard.root.generation.to_string()
        || input.author != guard.subject
        || (format!("user:{}", input.id) == guard.subject && input.action != MemberAction::Rename)
        || (objects.len() != 1
            && !matches!(input.action, MemberAction::Rename | MemberAction::Delete))
    {
        return Err(forbidden());
    }
    verify(&guard.authority, &input.proof, &input.frame()?)?;
    if input.action == MemberAction::Delete {
        super::super::objects::metadata_check_inventory_snapshot(
            context,
            input.inventory_snapshot.as_deref().ok_or_else(invalid)?,
        )
        .await?;
    }
    let guard = &context.security;
    let scope = format!("personnel:{}", input.id);
    let domain = format!("{scope}:master-data");
    let mut matching = objects.iter().filter(|packet| packet.domain == domain);
    let packet = matching.next().ok_or_else(invalid)?;
    if matching.next().is_some() {
        return Err(invalid());
    }
    if packet.envelope.object != format!("{domain}:record")
        || packet.envelope.scope != scope
        || packet.envelope.facet != Facet::MasterData
        || packet.envelope.signature != input.packet_signature
    {
        return Err(invalid());
    }
    if input.action == MemberAction::Delete {
        // All private profile facets disappear together. Other records or live
        // contents may not be smuggled into this terminal account operation.
        let expected = [Facet::MasterData, Facet::Scope, Facet::Calculation];
        if objects.len() != expected.len() {
            return Err(invalid());
        }
        for facet in expected {
            let domain = format!("{scope}:{}", facet.name());
            let matches: Vec<_> = objects
                .iter()
                .filter(|value| value.domain == domain)
                .collect();
            if matches.len() != 1 {
                return Err(invalid());
            }
            let envelope = &matches[0].envelope;
            if envelope.object != format!("{domain}:record")
                || envelope.scope != scope
                || envelope.facet != facet
                || !envelope.is_tombstone()
            {
                return Err(invalid());
            }
        }
    } else if objects.iter().any(|value| value.envelope.is_tombstone()) {
        return Err(invalid());
    }
    let receipt = key("member-changes", &input.request_id);
    if let Some(saved) = context
        .transaction
        .read::<serde_json::Value>(receipt.clone())
        .await?
    {
        if saved != serde_json::to_value(input).map_err(internal)? {
            return Err(conflict());
        }
        return Ok(());
    }
    let id = Id::decode(&input.id).map_err(|_| invalid())?;
    let mut account: accounts::Account = context
        .transaction
        .read(accounts::account_key(id.0))
        .await?
        .ok_or_else(not_found)?;
    if account.deleted_at.is_some() {
        return Err(forbidden());
    }
    let row = status_row(&account);
    if row.version(id) != input.expected {
        return Err(conflict());
    }
    let at = micros(&input.at_micros)?;
    if at > row.stamp || at < row.stamp - chrono::Duration::days(1) {
        return Err(invalid());
    }
    let subject = format!("user:{}", input.id);
    if matches!(
        input.action,
        MemberAction::Activate | MemberAction::Deactivate | MemberAction::Delete
    ) {
        let permissions = input.permissions.as_ref().ok_or_else(invalid)?;
        if permissions.transaction.is_some() {
            return Err(invalid());
        }
        let mut suspended = guard.policy.suspended.clone().unwrap_or_default();
        suspended.retain(|member| member != &subject);
        if matches!(
            input.action,
            MemberAction::Deactivate | MemberAction::Delete
        ) {
            suspended.push(subject.clone());
            suspended.sort();
        }
        if permissions.suspended.as_deref() != Some(suspended.as_slice())
            || serde_json::to_value(&permissions.rules).map_err(internal)?
                != serde_json::to_value(&guard.policy.rules).map_err(internal)?
        {
            return Err(invalid());
        }
        super::super::objects::metadata_replace_policy(
            &mut context.transaction,
            guard,
            permissions,
            true,
        )
        .await?;
    } else if input.permissions.is_some() {
        return Err(invalid());
    }
    match input.action {
        MemberAction::Activate => {
            account.deactivated_at = None;
            account.archived_at = None;
        }
        MemberAction::Deactivate => {
            if !account
                .deactivated_at
                .is_some_and(|previous| previous <= row.stamp)
            {
                account.deactivated_at = Some(at);
            }
        }
        MemberAction::Archive => {
            if !account
                .deactivated_at
                .is_some_and(|previous| previous <= row.stamp)
                || account.archived_at.is_some()
            {
                return Err(conflict());
            }
            account.archived_at = Some(at);
        }
        MemberAction::Unarchive => {
            if account.archived_at.is_none() {
                return Err(conflict());
            }
            account.archived_at = None;
        }
        MemberAction::Delete => {
            account.deleted_at = Some(at);
            account.deactivated_at = account.deactivated_at.or(Some(at));
            account.archived_at = account.archived_at.or(Some(at));
            context
                .transaction
                .delete(key("member-directory", &format!("{:020}", account.id)))
                .await?;
        }
        MemberAction::Rename => {
            let username = input.username.as_deref().ok_or_else(invalid)?;
            let previous_key = key("usernames", &account.username);
            let next_key = key("usernames", username);
            context
                .transaction
                .prefetch(vec![previous_key.clone(), next_key.clone()])
                .await?;
            // Both index entries and the protected account are CAS-guarded in
            // this same transaction as the encrypted personnel changes.
            let previous: accounts::Username = context
                .transaction
                .read(previous_key.clone())
                .await?
                .ok_or_else(conflict)?;
            if previous.user_id != id.0 {
                return Err(conflict());
            }
            if username != account.username {
                if context
                    .transaction
                    .read::<accounts::Username>(next_key.clone())
                    .await?
                    .is_some()
                {
                    return Err(conflict());
                }
                context.transaction.delete(previous_key).await?;
                context.transaction.put(next_key, &previous).await?;
                account.username = username.into();
            }
        }
    }
    if matches!(
        input.action,
        MemberAction::Deactivate | MemberAction::Archive | MemberAction::Delete
    ) {
        account.epoch = account.epoch.checked_add(1).ok_or_else(conflict)?;
    }
    account.modified_at = row.stamp;
    context
        .transaction
        .put_protected(accounts::account_key(id.0), &account)
        .await?;
    context.transaction.put(receipt, input).await?;
    context
        .transaction
        .notify("account", &serde_json::json!({"subject": subject}))?;
    Ok(())
}

pub(in crate::zerotrust) async fn check_profile_writes(
    context: &mut MetadataContext,
    member: Option<&MemberChange>,
    objects: &[SaveInput],
) -> RpcResult<()> {
    let mut profiles = std::collections::BTreeMap::new();
    for packet in objects {
        let envelope = &packet.envelope;
        let profile_facet = matches!(
            envelope.facet,
            Facet::MasterData | Facet::Scope | Facet::Calculation
        );
        let profile_object = format!("{}:{}:record", envelope.scope, envelope.facet.name());
        if !profile_facet || envelope.object != profile_object {
            continue;
        }
        let Some(id) = packet.envelope.scope.strip_prefix("personnel:") else {
            continue;
        };
        let id = Id::decode(id).map_err(|_| invalid())?;
        if id.0 <= 0 || packet.envelope.scope != format!("personnel:{}", id.encode()) {
            return Err(invalid());
        }
        profiles.entry(id.0).or_insert_with(Vec::new).push(packet);
    }
    let accounts = context
        .transaction
        .many::<accounts::Account>(
            profiles
                .keys()
                .map(|id| accounts::account_key(*id))
                .collect(),
        )
        .await?;
    for ((id, packets), account) in profiles.into_iter().zip(accounts) {
        let account = account.ok_or_else(not_found)?;
        if account.id != id {
            return Err(invalid());
        }
        let deletion_authorized = member.is_some_and(|change| {
            change.action == MemberAction::Delete && change.id == Id(id).encode()
        });
        for packet in packets {
            let envelope = &packet.envelope;
            if account.deleted_at.is_some() && !envelope.is_tombstone() {
                return Err(forbidden());
            }
            if envelope.is_tombstone() && !deletion_authorized {
                return Err(forbidden());
            }
        }
    }
    Ok(())
}
pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let make = Arc::clone(&service);
    let get = Arc::clone(&service);
    let inspect = Arc::clone(&service);
    builder
        .mutation(
            "zerotrust.members.create",
            move |ctx, input: MemberCreation| {
                let service = Arc::clone(&make);
                async move { create(&service, &ctx, input).await }
            },
        )
        .query(
            "zerotrust.members.creation",
            move |ctx, input: CreationId| {
                let service = Arc::clone(&get);
                async move { creation(&service, &ctx, input).await }
            },
        )
        .query("zerotrust.members.status", move |ctx, input: CreationId| {
            let service = Arc::clone(&inspect);
            async move { status(&service, &ctx, input).await }
        })
        .query(
            "zerotrust.members.changeReceipt",
            move |ctx, input: ChangeReceiptId| {
                let service = Arc::clone(&service);
                async move { receipt(&service, &ctx, input).await }
            },
        )
}
