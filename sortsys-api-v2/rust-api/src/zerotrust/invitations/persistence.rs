//! Public invitation proofs; only the inviting browser verifies the secret MAC.
use super::super::{
    access::{MetadataContext, metadata_context},
    setup::{RootState, metadata_history, metadata_root},
};
use super::*;
use crate::{
    auth::AuthService,
    control::{Repository, Transaction, accounts, key},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::zerotrust) struct StoredInvitation {
    pub invitation: Invitation,
    pub claim: Option<Claim>,
    pub created_at: chrono::DateTime<Utc>,
    pub accepted_at: Option<chrono::DateTime<Utc>>,
    pub completed_at: Option<chrono::DateTime<Utc>>,
    pub revoked_at: Option<chrono::DateTime<Utc>>,
}
impl StoredInvitation {
    fn live(&self, generation: &str) -> RpcResult<()> {
        if self.invitation.generation != generation
            || self.revoked_at.is_some()
            || revision(&self.invitation.valid_until)? <= Utc::now().timestamp()
        {
            return Err(forbidden());
        }
        Ok(())
    }
    fn entry(self) -> Entry {
        Entry {
            invitation: self.invitation,
            claim: self.claim,
            accepted: self.accepted_at.is_some(),
            completed: self.completed_at.is_some(),
            revoked: self.revoked_at.is_some(),
        }
    }
}
fn record_key(id: &str) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    identifier(id)?;
    Ok(key("invitations", id))
}
fn index_key(
    invitation: &Invitation,
    pending: bool,
) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    let kind = if pending { "pending" } else { "calendar" };
    Ok(key(
        &format!("invitation-{kind}-{}", invitation.generation),
        &format!(
            "{:020}:{}",
            revision(&invitation.valid_until)?,
            invitation.id
        ),
    ))
}
async fn stored(transaction: &mut Transaction, id: &str) -> RpcResult<StoredInvitation> {
    let row: StoredInvitation = transaction
        .read(record_key(id)?)
        .await?
        .ok_or_else(not_found)?;
    if row.invitation.id != id {
        return Err(invalid());
    }
    Ok(row)
}
fn admin(context: &MetadataContext) -> RpcResult<()> {
    if !context.auth.is_admin() {
        return Err(forbidden());
    }
    Ok(())
}
pub(in crate::zerotrust) async fn repository(
    service: &AuthService,
    tenant: &str,
) -> RpcResult<Repository> {
    crate::control::tenants::published_repository(service.records()?, tenant).await
}
pub(in crate::zerotrust) async fn registration_target(
    transaction: &mut Transaction,
    tenant: &str,
    id: &str,
) -> RpcResult<(StoredInvitation, accounts::Account, RootState)> {
    let now = Utc::now();
    let status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(forbidden)?;
    if !status.available(now) {
        return Err(forbidden());
    }
    let root = metadata_root(transaction, tenant).await?;
    let row = stored(transaction, id).await?;
    row.live(&root.profile.authority.generation)?;
    verify(
        &sized::<32>(&root.profile.authority.authority_signing_key)?,
        &row.invitation.signature,
        &row.invitation.frame()?,
    )?;
    let id = subject(&row.invitation.user)?;
    let account: accounts::Account = transaction
        .read(accounts::account_key(id.0))
        .await?
        .ok_or_else(forbidden)?;
    if row.invitation.tenant != tenant
        || !account.available(now)
        || account.id != id.0
        || account.username != row.invitation.username
    {
        return Err(forbidden());
    }
    Ok((row, account, root))
}
pub(in crate::zerotrust) async fn store_claim(
    transaction: &mut Transaction,
    mut row: StoredInvitation,
    claim: Claim,
) -> RpcResult<()> {
    if row.accepted_at.is_some() {
        return Err(conflict());
    }
    row.claim = Some(claim);
    transaction.put(record_key(&row.invitation.id)?, &row).await
}
async fn future_ids(
    transaction: &mut Transaction,
    generation: &str,
    pending: bool,
) -> RpcResult<Vec<String>> {
    let kind = if pending { "pending" } else { "calendar" };
    let collection = format!("invitation-{kind}-{generation}");
    let mut after = Some(format!("{:020}", Utc::now().timestamp() + 1));
    let mut result = Vec::new();
    loop {
        let page = transaction.scan::<String>(&collection, after).await?;
        for row in page.records {
            result.push(row.value.ok_or_else(invalid)?);
            if result.len() > 1000 {
                return Err(conflict());
            }
        }
        after = page.after;
        if after.is_none() {
            return Ok(result);
        }
    }
}
async fn list_members(
    service: &AuthService,
    request: &RequestContext,
    input: MemberPage,
) -> RpcResult<Members> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    // Numeric account keys are padded in a separate ordering index. Account
    // reads and this index share the same transaction and snapshot check.
    let mut after = input.after.map(|id| format!("{:020}", id.0));
    let mut rows = Vec::new();
    loop {
        let page = context
            .transaction
            .scan::<i64>("member-directory", after)
            .await?;
        let ids = page
            .records
            .into_iter()
            .map(|row| row.value.ok_or_else(invalid))
            .collect::<RpcResult<Vec<_>>>()?;
        let accounts = context
            .transaction
            .many::<accounts::Account>(ids.iter().map(|id| accounts::account_key(*id)).collect())
            .await?;
        for (id, account) in ids.into_iter().zip(accounts) {
            let account = account.ok_or_else(invalid)?;
            if account.id != id {
                return Err(invalid());
            }
            if account.available(Utc::now()) {
                rows.push(Member {
                    id: Id(id),
                    username: account.username,
                    enrolled: account.credential.is_some(),
                    roles: account.roles,
                });
            }
        }
        if rows.len() > 100 || page.after.is_none() {
            break;
        }
        after = page.after;
    }
    let after = if rows.len() > 100 {
        rows.truncate(100);
        rows.last().map(|row| row.id)
    } else {
        None
    };
    context.transaction.validate().await?;
    Ok(Members { rows, after })
}
async fn create(
    service: &AuthService,
    request: &RequestContext,
    input: Invitation,
) -> RpcResult<Success> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    verify(
        &context.security.authority,
        &input.signature,
        &input.frame()?,
    )?;
    let expiry = revision(&input.valid_until)?;
    let now = Utc::now().timestamp();
    if input.tenant != context.auth.tenant
        || input.generation != context.security.root.generation.to_string()
        || expiry <= now
        || expiry > now + 7 * 86400
    {
        return Err(invalid());
    }
    let user = subject(&input.user)?;
    let account: accounts::Account = context
        .transaction
        .read(accounts::account_key(user.0))
        .await?
        .ok_or_else(forbidden)?;
    if !account.available(Utc::now()) || account.username != input.username {
        return Err(forbidden());
    }
    let record = record_key(&input.id)?;
    if let Some(previous) = context
        .transaction
        .read::<StoredInvitation>(record.clone())
        .await?
    {
        if serde_json::to_value(&previous.invitation).map_err(internal)?
            != serde_json::to_value(&input).map_err(internal)?
        {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(Success { success: true });
    }
    if future_ids(&mut context.transaction, &input.generation, true)
        .await?
        .len()
        >= 1000
    {
        return Err(conflict());
    }
    let expires = chrono::DateTime::from_timestamp(expiry, 0).ok_or_else(invalid)?;
    context
        .transaction
        .put_expiring(index_key(&input, false)?, &input.id, expires)
        .await?;
    context
        .transaction
        .put_expiring(index_key(&input, true)?, &input.id, expires)
        .await?;
    context
        .transaction
        .put(
            record,
            &StoredInvitation {
                invitation: input,
                claim: None,
                created_at: Utc::now(),
                accepted_at: None,
                completed_at: None,
                revoked_at: None,
            },
        )
        .await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
async fn list(service: &AuthService, request: &RequestContext) -> RpcResult<Vec<Entry>> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let ids = future_ids(
        &mut context.transaction,
        &context.security.root.generation.to_string(),
        false,
    )
    .await?;
    let rows = context
        .transaction
        .many::<StoredInvitation>(
            ids.iter()
                .map(|id| record_key(id))
                .collect::<RpcResult<Vec<_>>>()?,
        )
        .await?;
    let mut entries = Vec::new();
    for (id, row) in ids.into_iter().zip(rows) {
        let row = row.ok_or_else(invalid)?;
        if row.invitation.id != id
            || row.invitation.tenant != context.auth.tenant
            || row.invitation.generation != context.security.root.generation.to_string()
        {
            return Err(invalid());
        }
        entries.push(row);
    }
    entries.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.invitation.id.cmp(&right.invitation.id))
    });
    context.transaction.validate().await?;
    Ok(entries.into_iter().map(StoredInvitation::entry).collect())
}
async fn lookup(service: &AuthService, input: PublicInvitationId) -> RpcResult<PublicInvitation> {
    let _admission = crate::auth_limits::admit_login()?;
    let repository = repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let (row, account, _) = registration_target(&mut transaction, &input.tenant, &input.id).await?;
    let history = metadata_history(&mut transaction).await?;
    transaction.validate().await?;
    Ok(PublicInvitation {
        invitation: row.invitation,
        history,
        enrolled: account.credential.is_some(),
    })
}
async fn open(
    service: &AuthService,
    request: &RequestContext,
    input: InvitationId,
) -> RpcResult<Opened> {
    let auth = service.authenticate(&request.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (current, _) = accounts::checked_session(&mut transaction, &auth).await?;
    let (row, target, _) = registration_target(&mut transaction, &auth.tenant, &input.id).await?;
    if target.id != current.id {
        return Err(forbidden());
    }
    let history = metadata_history(&mut transaction).await?;
    transaction.validate().await?;
    Ok(Opened {
        entry: row.entry(),
        history,
    })
}
async fn join(service: &AuthService, request: &RequestContext, input: Claim) -> RpcResult<Success> {
    let auth = service.authenticate(&request.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (current, _) = accounts::checked_session(&mut transaction, &auth).await?;
    let (row, target, _) =
        registration_target(&mut transaction, &auth.tenant, &input.invitation).await?;
    if target.id != current.id {
        return Err(forbidden());
    }
    verify(
        &sized::<32>(&input.signing_key)?,
        &input.proof,
        &input.frame(&row.invitation)?,
    )?;
    let credential = current.credential()?;
    if input.revision != credential.revision.to_string()
        || input.encryption_key != credential.vault.encryption_key
        || input.signing_key != credential.vault.signing_key
    {
        return Err(conflict());
    }
    if row.accepted_at.is_some() {
        if row
            .claim
            .as_ref()
            .map(|claim| claim.hash(&row.invitation))
            .transpose()?
            != Some(input.hash(&row.invitation)?)
        {
            return Err(conflict());
        }
        transaction.validate().await?;
        return Ok(Success { success: true });
    }
    store_claim(&mut transaction, row, input).await?;
    transaction.commit().await?;
    Ok(Success { success: true })
}
async fn approve(
    service: &AuthService,
    request: &RequestContext,
    input: Approval,
) -> RpcResult<Success> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let row = stored(&mut context.transaction, &input.id).await?;
    if row.invitation.tenant != context.auth.tenant {
        return Err(forbidden());
    }
    row.live(&context.security.root.generation.to_string())?;
    verify(
        &context.security.authority,
        &row.invitation.signature,
        &row.invitation.frame()?,
    )?;
    let claim = row.claim.as_ref().ok_or_else(conflict)?;
    if claim.hash(&row.invitation)? != input.claim_hash {
        return Err(conflict());
    }
    verify(
        &context.security.authority,
        &input.proof,
        &frame(
            "sortsys/invitation-approval/v1",
            &[
                &context.auth.tenant,
                &input.id,
                &context.security.root.generation.to_string(),
                &row.invitation.user,
                &input.claim_hash,
            ],
        ),
    )?;
    input.certificate.verify(&context.security.authority)?;
    if input.certificate.tenant != context.auth.tenant
        || input.certificate.generation != row.invitation.generation
        || input.certificate.user != row.invitation.user
        || input.certificate.encryption_key != claim.encryption_key
        || input.certificate.signing_key != claim.signing_key
    {
        return Err(invalid());
    }
    let user = subject(&row.invitation.user)?;
    let account: accounts::Account = context
        .transaction
        .read(accounts::account_key(user.0))
        .await?
        .ok_or_else(conflict)?;
    let credential = account.credential()?;
    if !account.active(Utc::now())
        || account.username != row.invitation.username
        || credential.vault.encryption_key != claim.encryption_key
        || credential.vault.signing_key != claim.signing_key
    {
        return Err(conflict());
    }
    if row.accepted_at.is_some() {
        if credential.certificate != serde_json::to_value(&input.certificate).map_err(internal)? {
            return Err(conflict());
        }
        context.transaction.validate().await?;
        return Ok(Success { success: true });
    }
    if credential.revision.to_string() != claim.revision {
        return Err(conflict());
    }
    super::super::objects::metadata_install_identity(
        &mut context.transaction,
        &context.security,
        &input.certificate,
    )
    .await?;
    let mut row = row;
    row.accepted_at = Some(Utc::now());
    context
        .transaction
        .delete(index_key(&row.invitation, true)?)
        .await?;
    context
        .transaction
        .put(record_key(&row.invitation.id)?, &row)
        .await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
async fn revoke(
    service: &AuthService,
    request: &RequestContext,
    input: Revoke,
) -> RpcResult<Success> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let mut row = stored(&mut context.transaction, &input.id).await?;
    verify(
        &context.security.authority,
        &input.proof,
        &frame(
            "sortsys/invitation-revoke/v1",
            &[
                &context.auth.tenant,
                &input.id,
                &context.security.root.generation.to_string(),
            ],
        ),
    )?;
    if row.invitation.tenant != context.auth.tenant
        || row.invitation.generation != context.security.root.generation.to_string()
        || row.accepted_at.is_some()
    {
        return Err(conflict());
    }
    row.revoked_at.get_or_insert_with(Utc::now);
    context
        .transaction
        .delete(index_key(&row.invitation, true)?)
        .await?;
    context
        .transaction
        .put(record_key(&input.id)?, &row)
        .await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
async fn complete(
    service: &AuthService,
    request: &RequestContext,
    input: Completion,
) -> RpcResult<Success> {
    let mut context = metadata_context(service, request).await?;
    admin(&context)?;
    let mut row = stored(&mut context.transaction, &input.id).await?;
    if row.invitation.tenant != context.auth.tenant {
        return Err(forbidden());
    }
    row.live(&context.security.root.generation.to_string())?;
    if row.accepted_at.is_none()
        || row
            .claim
            .as_ref()
            .ok_or_else(conflict)?
            .hash(&row.invitation)?
            != input.claim_hash
    {
        return Err(conflict());
    }
    verify(
        &context.security.authority,
        &input.proof,
        &frame(
            "sortsys/invitation-complete/v1",
            &[
                &context.auth.tenant,
                &input.id,
                &context.security.root.generation.to_string(),
                &input.claim_hash,
            ],
        ),
    )?;
    row.completed_at.get_or_insert_with(Utc::now);
    context
        .transaction
        .put(record_key(&input.id)?, &row)
        .await?;
    context.transaction.commit().await?;
    Ok(Success { success: true })
}
pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let public = Arc::clone(&service);
    let members = Arc::clone(&service);
    let make = Arc::clone(&service);
    let list_service = Arc::clone(&service);
    let inspect = Arc::clone(&service);
    let claim = Arc::clone(&service);
    let approval = Arc::clone(&service);
    let completion = Arc::clone(&service);
    builder
        .query(
            "auth.opaque.invitation",
            move |_, input: PublicInvitationId| {
                let service = Arc::clone(&public);
                async move { lookup(&service, input).await }
            },
        )
        .query("zerotrust.members.list", move |ctx, input: MemberPage| {
            let service = Arc::clone(&members);
            async move { list_members(&service, &ctx, input).await }
        })
        .mutation(
            "zerotrust.invitations.create",
            move |ctx, input: Invitation| {
                let service = Arc::clone(&make);
                async move { create(&service, &ctx, input).await }
            },
        )
        .query("zerotrust.invitations.list", move |ctx, _: ()| {
            let service = Arc::clone(&list_service);
            async move { list(&service, &ctx).await }
        })
        .query(
            "zerotrust.invitations.get",
            move |ctx, input: InvitationId| {
                let service = Arc::clone(&inspect);
                async move { open(&service, &ctx, input).await }
            },
        )
        .mutation("zerotrust.invitations.join", move |ctx, input: Claim| {
            let service = Arc::clone(&claim);
            async move { join(&service, &ctx, input).await }
        })
        .mutation(
            "zerotrust.invitations.approve",
            move |ctx, input: Approval| {
                let service = Arc::clone(&approval);
                async move { approve(&service, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.invitations.complete",
            move |ctx, input: Completion| {
                let service = Arc::clone(&completion);
                async move { complete(&service, &ctx, input).await }
            },
        )
        .mutation("zerotrust.invitations.revoke", move |ctx, input: Revoke| {
            let service = Arc::clone(&service);
            async move { revoke(&service, &ctx, input).await }
        })
}
