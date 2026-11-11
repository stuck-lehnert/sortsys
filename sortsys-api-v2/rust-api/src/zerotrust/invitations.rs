//! Invitation confirmation secrets are verified by the inviting browser only.
//! This service stores public proofs and arbitrates one-time approval.
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use ts_rs::TS;

use super::{
    access::{current_root, security, tenant_root},
    crypto::{encode, frame, identifier, invalid, revision, sized, verify},
    objects::{TrustHistory, load_history},
    wire::IdentityCertificate,
};
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Invitation {
    pub(super) tenant: String,
    pub(super) id: String,
    pub(super) generation: String,
    pub(super) user: String,
    pub(super) username: String,
    pub(super) valid_until: String,
    pub(super) verifier: String,
    pub(super) signature: String,
}
impl Invitation {
    pub(super) fn frame(&self) -> RpcResult<Vec<u8>> {
        for value in [&self.tenant, &self.id, &self.user, &self.username] {
            identifier(value)?;
        }
        subject(&self.user)?;
        revision(&self.generation)?;
        revision(&self.valid_until)?;
        sized::<32>(&self.verifier)?;
        Ok(frame(
            "sortsys/invitation/v1",
            &[
                &self.tenant,
                &self.id,
                &self.generation,
                &self.user,
                &self.username,
                &self.valid_until,
                &self.verifier,
            ],
        ))
    }
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Claim {
    pub(super) invitation: String,
    pub(super) generation: String,
    pub(super) user: String,
    pub(super) revision: String,
    pub(super) encryption_key: String,
    pub(super) signing_key: String,
    pub(super) proof: String,
    pub(super) confirmation: String,
}
impl Claim {
    pub(super) fn frame(&self, invitation: &Invitation) -> RpcResult<Vec<u8>> {
        if self.invitation != invitation.id
            || self.generation != invitation.generation
            || self.user != invitation.user
        {
            return Err(invalid());
        }
        revision(&self.revision)?;
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        sized::<32>(&self.confirmation)?;
        Ok(frame(
            "sortsys/invitation-claim/v1",
            &[
                &invitation.tenant,
                &invitation.id,
                &invitation.generation,
                &invitation.user,
                &invitation.signature,
                &self.revision,
                &self.encryption_key,
                &self.signing_key,
            ],
        ))
    }
    pub(super) fn hash(&self, invitation: &Invitation) -> RpcResult<String> {
        sized::<64>(&self.proof)?;
        Ok(encode(&Sha256::digest(frame(
            "sortsys/invitation-claim-hash/v1",
            &[
                &encode(&self.frame(invitation)?),
                &self.proof,
                &self.confirmation,
            ],
        ))))
    }
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct InvitationId {
    id: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval {
    id: String,
    claim_hash: String,
    certificate: IdentityCertificate,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Revoke {
    id: String,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    id: String,
    claim_hash: String,
    proof: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Entry {
    invitation: Invitation,
    claim: Option<Claim>,
    accepted: bool,
    completed: bool,
    revoked: bool,
}
#[derive(Serialize, TS)]
struct Opened {
    entry: Entry,
    history: TrustHistory,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct Member {
    id: Id,
    username: String,
    enrolled: bool,
    roles: Vec<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct MemberPage {
    after: Option<Id>,
}
#[derive(Serialize, TS)]
struct Members {
    rows: Vec<Member>,
    after: Option<Id>,
}

#[derive(FromRow)]
struct Stored {
    user_id: i64,
    generation: i64,
    invitation: Value,
    claim: Option<Value>,
    accepted: bool,
    completed: bool,
    revoked: bool,
    expired: bool,
}
impl Stored {
    fn entry(self) -> RpcResult<Entry> {
        Ok(Entry {
            invitation: serde_json::from_value(self.invitation).map_err(invalid_value)?,
            claim: self
                .claim
                .map(serde_json::from_value)
                .transpose()
                .map_err(invalid_value)?,
            accepted: self.accepted,
            completed: self.completed,
            revoked: self.revoked,
        })
    }
    fn live(&self, generation: i64) -> RpcResult<()> {
        if self.generation != generation || self.expired || self.revoked {
            return Err(forbidden());
        }
        Ok(())
    }
}
fn invalid_value(_: serde_json::Error) -> RpcError {
    invalid()
}
fn subject(value: &str) -> RpcResult<Id> {
    Id::decode(value.strip_prefix("user:").ok_or_else(invalid)?).map_err(|_| invalid())
}
fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Invitation changed").with_http_code(409)
}
async fn stored(tx: &mut PgConnection, id: &str) -> RpcResult<Stored> {
    identifier(id)?;
    sqlx::query_as("SELECT user_id,generation,invitation,claim,accepted_at IS NOT NULL AS accepted,completed_at IS NOT NULL AS completed,revoked_at IS NOT NULL AS revoked,expires_at<=statement_timestamp() AS expired FROM __zerotrust_invitations WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(tx).await.map_err(internal)?.ok_or_else(not_found)
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let lookup = Arc::clone(&state);
    let members = Arc::clone(&state);
    let create = Arc::clone(&state);
    let list = Arc::clone(&state);
    let get = Arc::clone(&state);
    let join = Arc::clone(&state);
    let approve = Arc::clone(&state);
    let complete = Arc::clone(&state);
    builder
        .query(
            "auth.opaque.invitation",
            move |_, input: PublicInvitationId| {
                let state = Arc::clone(&lookup);
                async move { lookup_invitation(&state, input).await }
            },
        )
        .query("zerotrust.members.list", move |ctx, input: MemberPage| {
            let state = Arc::clone(&members);
            async move { list_members(&state, &ctx, input).await }
        })
        .mutation(
            "zerotrust.invitations.create",
            move |ctx, input: Invitation| {
                let state = Arc::clone(&create);
                async move { create_invitation(&state, &ctx, input).await }
            },
        )
        .query("zerotrust.invitations.list", move |ctx, _: ()| {
            let state = Arc::clone(&list);
            async move { list_invitations(&state, &ctx).await }
        })
        .query(
            "zerotrust.invitations.get",
            move |ctx, input: InvitationId| {
                let state = Arc::clone(&get);
                async move { open_invitation(&state, &ctx, input).await }
            },
        )
        .mutation("zerotrust.invitations.join", move |ctx, input: Claim| {
            let state = Arc::clone(&join);
            async move { join_invitation(&state, &ctx, input).await }
        })
        .mutation(
            "zerotrust.invitations.approve",
            move |ctx, input: Approval| {
                let state = Arc::clone(&approve);
                async move { approve_invitation(&state, &ctx, input).await }
            },
        )
        .mutation(
            "zerotrust.invitations.complete",
            move |ctx, input: Completion| {
                let state = Arc::clone(&complete);
                async move { complete_invitation(&state, &ctx, input).await }
            },
        )
        .mutation("zerotrust.invitations.revoke", move |ctx, input: Revoke| {
            let state = Arc::clone(&state);
            async move { revoke_invitation(&state, &ctx, input).await }
        })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<PublicInvitationId, PublicInvitation>("auth.opaque.invitation")
        .query_stub::<MemberPage, Members>("zerotrust.members.list")
        .mutation_stub::<Invitation, Success>("zerotrust.invitations.create")
        .query_stub::<(), Vec<Entry>>("zerotrust.invitations.list")
        .query_stub::<InvitationId, Opened>("zerotrust.invitations.get")
        .mutation_stub::<Claim, Success>("zerotrust.invitations.join")
        .mutation_stub::<Approval, Success>("zerotrust.invitations.approve")
        .mutation_stub::<Completion, Success>("zerotrust.invitations.complete")
        .mutation_stub::<Revoke, Success>("zerotrust.invitations.revoke")
}
async fn list_members(
    state: &AppState,
    ctx: &RequestContext,
    input: MemberPage,
) -> RpcResult<Members> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    security(&mut tx, state.tenants.master(), &auth, false).await?;
    let mut rows:Vec<Member> = sqlx::query_as("SELECT u.id,u.username,a.user_id IS NOT NULL AS enrolled,ARRAY(SELECT role_name FROM user_role_assignments WHERE user_id=u.id ORDER BY role_name) AS roles FROM users u LEFT JOIN __zerotrust_accounts a ON a.user_id=u.id WHERE u.deactivated_at IS NULL AND ($1::bigint IS NULL OR u.id>$1) ORDER BY u.id LIMIT 101")
        .bind(input.after.map(|id|id.0)).fetch_all(&mut *tx).await.map_err(internal)?;
    let after = if rows.len() > 100 {
        rows.truncate(100);
        rows.last().map(|row| row.id)
    } else {
        None
    };
    Ok(Members { rows, after })
}
async fn create_invitation(
    state: &AppState,
    ctx: &RequestContext,
    input: Invitation,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    verify(&guard.authority, &input.signature, &input.frame()?)?;
    let expiry = revision(&input.valid_until)?;
    let now = Utc::now().timestamp();
    if input.tenant != auth.tenant
        || input.generation != guard.root.generation.to_string()
        || expiry <= now
        || expiry > now + 7 * 86400
    {
        return Err(invalid());
    }
    let user = subject(&input.user)?;
    let username: Option<String> =
        sqlx::query_scalar("SELECT username FROM users WHERE id=$1 AND deactivated_at IS NULL")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if username.as_deref() != Some(&input.username) {
        return Err(forbidden());
    }
    let value = serde_json::to_value(&input).map_err(internal)?;
    let old: Option<Value> =
        sqlx::query_scalar("SELECT invitation FROM __zerotrust_invitations WHERE id=$1")
            .bind(&input.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if let Some(old) = old {
        return if old == value {
            Ok(Success { success: true })
        } else {
            Err(conflict())
        };
    }
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM __zerotrust_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()").fetch_one(&mut *tx).await.map_err(internal)?;
    if count >= 1000 {
        return Err(conflict());
    }
    sqlx::query("INSERT INTO __zerotrust_invitations(id,user_id,generation,invitation,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5::double precision))")
        .bind(&input.id).bind(user).bind(guard.root.generation).bind(value).bind(expiry as f64).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn list_invitations(state: &AppState, ctx: &RequestContext) -> RpcResult<Vec<Entry>> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let rows:Vec<Stored>=sqlx::query_as("SELECT user_id,generation,invitation,claim,accepted_at IS NOT NULL AS accepted,completed_at IS NOT NULL AS completed,revoked_at IS NOT NULL AS revoked,expires_at<=statement_timestamp() AS expired FROM __zerotrust_invitations WHERE generation=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1001")
        .bind(guard.root.generation).fetch_all(&mut *tx).await.map_err(internal)?;
    if rows.len() > 1000 {
        return Err(conflict());
    }
    rows.into_iter().map(Stored::entry).collect()
}
async fn open_invitation(
    state: &AppState,
    ctx: &RequestContext,
    input: InvitationId,
) -> RpcResult<Opened> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (root, key) = tenant_root(&mut tx, state.tenants.master(), &auth, false).await?;
    let row = stored(&mut tx, &input.id).await?;
    row.live(root.generation)?;
    if row.user_id != auth.user.id.parse::<i64>().map_err(internal)? {
        return Err(forbidden());
    }
    let entry = row.entry()?;
    verify(
        &key,
        &entry.invitation.signature,
        &entry.invitation.frame()?,
    )?;
    let history = load_history(&mut tx, false).await?;
    Ok(Opened { entry, history })
}
async fn join_invitation(
    state: &AppState,
    ctx: &RequestContext,
    input: Claim,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (root, key) = tenant_root(&mut tx, state.tenants.master(), &auth, false).await?;
    let row = stored(&mut tx, &input.invitation).await?;
    row.live(root.generation)?;
    if row.user_id != auth.user.id.parse::<i64>().map_err(internal)? {
        return Err(forbidden());
    }
    let accepted = row.accepted;
    let user = row.user_id;
    let entry = row.entry()?;
    verify(
        &key,
        &entry.invitation.signature,
        &entry.invitation.frame()?,
    )?;
    verify(
        &sized::<32>(&input.signing_key)?,
        &input.proof,
        &input.frame(&entry.invitation)?,
    )?;
    let current:Option<(i64,Vec<u8>,Vec<u8>)>=sqlx::query_as("SELECT revision,encryption_key,signing_key FROM __zerotrust_accounts WHERE user_id=$1 FOR SHARE").bind(user).fetch_optional(&mut *tx).await.map_err(internal)?;
    if current
        != Some((
            revision(&input.revision)?,
            sized::<32>(&input.encryption_key)?.to_vec(),
            sized::<32>(&input.signing_key)?.to_vec(),
        ))
    {
        return Err(conflict());
    }
    if accepted {
        return if entry
            .claim
            .as_ref()
            .map(|claim| claim.hash(&entry.invitation))
            .transpose()?
            == Some(input.hash(&entry.invitation)?)
        {
            Ok(Success { success: true })
        } else {
            Err(conflict())
        };
    }
    sqlx::query("UPDATE __zerotrust_invitations SET claim=$2 WHERE id=$1")
        .bind(&input.invitation)
        .bind(serde_json::to_value(&input).map_err(internal)?)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn approve_invitation(
    state: &AppState,
    ctx: &RequestContext,
    input: Approval,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    let row = stored(&mut tx, &input.id).await?;
    row.live(guard.root.generation)?;
    let user = row.user_id;
    let accepted = row.accepted;
    let entry = row.entry()?;
    verify(
        &guard.authority,
        &entry.invitation.signature,
        &entry.invitation.frame()?,
    )?;
    let claim = entry.claim.ok_or_else(conflict)?;
    if claim.hash(&entry.invitation)? != input.claim_hash {
        return Err(conflict());
    }
    verify(
        &guard.authority,
        &input.proof,
        &frame(
            "sortsys/invitation-approval/v1",
            &[
                &auth.tenant,
                &input.id,
                &guard.root.generation.to_string(),
                &entry.invitation.user,
                &input.claim_hash,
            ],
        ),
    )?;
    input.certificate.verify(&guard.authority)?;
    if input.certificate.tenant != auth.tenant
        || input.certificate.generation != guard.root.generation.to_string()
        || input.certificate.user != entry.invitation.user
        || input.certificate.encryption_key != claim.encryption_key
        || input.certificate.signing_key != claim.signing_key
    {
        return Err(invalid());
    }
    if accepted {
        return Ok(Success { success: true });
    }
    let current:Option<(i64,Vec<u8>,Vec<u8>)>=sqlx::query_as("SELECT revision,encryption_key,signing_key FROM __zerotrust_accounts WHERE user_id=$1 FOR UPDATE").bind(user).fetch_optional(&mut *tx).await.map_err(internal)?;
    if current
        != Some((
            revision(&claim.revision)?,
            sized::<32>(&claim.encryption_key)?.to_vec(),
            sized::<32>(&claim.signing_key)?.to_vec(),
        ))
    {
        return Err(conflict());
    }
    let certificate = serde_json::to_value(input.certificate).map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_accounts SET identity_certificate=$2 WHERE user_id=$1")
        .bind(user)
        .bind(&certificate)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_identity_history(subject,generation,signing_key,certificate) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(&entry.invitation.user).bind(guard.root.generation).bind(sized::<32>(&claim.signing_key)?.to_vec()).bind(certificate).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_invitations SET accepted_at=now() WHERE id=$1")
        .bind(&input.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    super::events::notify_account(&mut tx, &entry.invitation.user).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn revoke_invitation(
    state: &AppState,
    ctx: &RequestContext,
    input: Revoke,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    let row = stored(&mut tx, &input.id).await?;
    verify(
        &guard.authority,
        &input.proof,
        &frame(
            "sortsys/invitation-revoke/v1",
            &[&auth.tenant, &input.id, &guard.root.generation.to_string()],
        ),
    )?;
    if row.generation != guard.root.generation || row.accepted {
        return Err(conflict());
    }
    sqlx::query(
        "UPDATE __zerotrust_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",
    )
    .bind(&input.id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

async fn complete_invitation(
    state: &AppState,
    ctx: &RequestContext,
    input: Completion,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    let row = stored(&mut tx, &input.id).await?;
    row.live(guard.root.generation)?;
    if !row.accepted {
        return Err(conflict());
    }
    let entry = row.entry()?;
    let claim = entry.claim.ok_or_else(conflict)?;
    if claim.hash(&entry.invitation)? != input.claim_hash {
        return Err(conflict());
    }
    verify(
        &guard.authority,
        &input.proof,
        &frame(
            "sortsys/invitation-complete/v1",
            &[
                &auth.tenant,
                &input.id,
                &guard.root.generation.to_string(),
                &input.claim_hash,
            ],
        ),
    )?;
    sqlx::query(
        "UPDATE __zerotrust_invitations SET completed_at=COALESCE(completed_at,now()) WHERE id=$1",
    )
    .bind(&input.id)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    super::events::notify_account(&mut tx, &entry.invitation.user).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct PublicInvitationId {
    tenant: String,
    id: String,
}
#[derive(Serialize, TS)]
struct PublicInvitation {
    invitation: Invitation,
    history: TrustHistory,
    enrolled: bool,
}

/// The random public invitation ID exposes only its signed identity metadata.
/// Neither a successful lookup nor an account registration certifies the member.
async fn lookup_invitation(
    state: &AppState,
    input: PublicInvitationId,
) -> RpcResult<PublicInvitation> {
    let _admission = crate::auth_limits::admit_login()?;
    identifier(&input.tenant)?;
    let pool = state
        .tenants
        .tenant_pool(&input.tenant)
        .await
        .map_err(|_| forbidden())?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (invitation, user) =
        registration_invitation(&mut tx, state.tenants.master(), &input.tenant, &input.id).await?;
    let enrolled =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_accounts WHERE user_id=$1)")
            .bind(user)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    let history = load_history(&mut tx, false).await?;
    Ok(PublicInvitation {
        invitation,
        history,
        enrolled,
    })
}
pub(super) async fn registration_invitation(
    tx: &mut PgConnection,
    master: &sqlx::PgPool,
    tenant: &str,
    id: &str,
) -> RpcResult<(Invitation, i64)> {
    let (root, key) = current_root(tx, master, tenant, false).await?;
    let row = stored(tx, id).await?;
    row.live(root.generation)?;
    let user = row.user_id;
    let entry = row.entry()?;
    let signed = entry.invitation;
    verify(&key, &signed.signature, &signed.frame()?)?;
    let username: Option<String> =
        sqlx::query_scalar("SELECT username FROM users WHERE id=$1 AND deactivated_at IS NULL")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if signed.tenant != tenant
        || revision(&signed.valid_until)? <= Utc::now().timestamp()
        || signed.generation != root.generation.to_string()
        || subject(&signed.user)?.0 != user
        || username.as_deref() != Some(&signed.username)
    {
        return Err(forbidden());
    }
    Ok((signed, user))
}
