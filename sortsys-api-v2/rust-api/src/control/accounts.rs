//! Technical account identity only: personnel and organization details remain
//! encrypted business records. No provider-owned password can create this vault.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sortsys_zerotrust::{credentials::CredentialPrincipal, crypto::AccountVault};

use super::{Repository, Transaction, key, unavailable};
use crate::{
    auth::{AuthResult, AuthSession, AuthUser},
    error::{ErrorCode, RpcError, RpcResult},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TenantStatus {
    pub epoch: u64,
    pub locked_at: Option<DateTime<Utc>>,
    pub deactivated_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
}

impl TenantStatus {
    pub fn available(&self, now: DateTime<Utc>) -> bool {
        self.epoch > 0
            && !self.locked_at.is_some_and(|at| at <= now)
            && !self.deactivated_at.is_some_and(|at| at <= now)
            && !self.deleted_at.is_some_and(|at| at <= now)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    pub revision: u64,
    pub record: String,
    pub vault: AccountVault,
    pub certificate: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: i64,
    pub username: String,
    pub locale: String,
    pub epoch: u64,
    pub roles: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub deactivated_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
    pub credential: Option<Credential>,
}

impl Account {
    /// Reserved accounts can receive an invitation but cannot authenticate yet.
    pub fn available(&self, now: DateTime<Utc>) -> bool {
        self.id > 0
            && self.epoch > 0
            && !self.deactivated_at.is_some_and(|at| at <= now)
            && self.archived_at.is_none()
    }
    pub fn active(&self, now: DateTime<Utc>) -> bool {
        self.available(now)
            && self
                .credential
                .as_ref()
                .is_some_and(|credential| credential.revision > 0)
    }
    pub fn credential(&self) -> RpcResult<&Credential> {
        self.credential.as_ref().ok_or_else(denied)
    }
    pub fn credential_mut(&mut self) -> RpcResult<&mut Credential> {
        self.credential.as_mut().ok_or_else(denied)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub id: i64,
    pub user_id: i64,
    pub account_epoch: u64,
    pub tenant_epoch: u64,
    pub inet_addr: Option<String>,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Username {
    pub user_id: i64,
}

pub fn denied() -> RpcError {
    RpcError::new(
        ErrorCode::Unauthorized,
        "Session closed, expired or account unavailable",
    )
    .with_http_code(401)
}

/// Public immutable identity shared by password, passkey and vault encryption.
pub fn subject(user: i64) -> String {
    format!("user:{}", crate::ids::Id(user).encode())
}

pub fn principal(tenant: &str, user: i64) -> CredentialPrincipal {
    CredentialPrincipal {
        tenant: tenant.into(),
        subject: subject(user),
    }
}

pub fn account_key(user: i64) -> sortsys_zerotrust::metadata::RecordKey {
    key("accounts", &user.to_string())
}
pub fn session_key(session: i64) -> sortsys_zerotrust::metadata::RecordKey {
    key("sessions", &session.to_string())
}
pub fn tenant_key() -> sortsys_zerotrust::metadata::RecordKey {
    key("tenant-status", "current")
}

pub fn random_id() -> RpcResult<i64> {
    let mut bytes = [0; 8];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    // Positive 63-bit IDs preserve the existing public base-32 representation.
    let id = (u64::from_be_bytes(bytes) & i64::MAX as u64) as i64;
    Ok(id.max(1))
}

pub async fn session_identity(
    repository: &Repository,
    tenant: &str,
    session_id: i64,
) -> RpcResult<AuthResult> {
    let repository = repository.tenant(tenant)?;
    let session: Session = repository
        .read(session_key(session_id))
        .await?
        .value
        .ok_or_else(denied)?;
    // One service read observes all three records together. Downstream writes
    // still need checked_session in their own CAS transaction.
    let snapshot = repository
        .read_records(vec![
            session_key(session_id),
            account_key(session.user_id),
            tenant_key(),
        ])
        .await?;
    fn required<T: serde::de::DeserializeOwned>(
        row: &sortsys_zerotrust::metadata::MetadataRecord,
    ) -> RpcResult<T> {
        super::decode(row.value.as_deref().ok_or_else(denied)?)
    }
    let current: Session = required(&snapshot[0])?;
    if current.id != session_id || current.user_id != session.user_id {
        return Err(denied());
    }
    let account: Account = required(&snapshot[1])?;
    let status: TenantStatus = required(&snapshot[2])?;
    let now = Utc::now();
    if !status.available(now)
        || !account.active(now)
        || account.id != current.user_id
        || current.account_epoch != account.epoch
        || current.tenant_epoch != status.epoch
        || current.created_at > now
        || current.expires_at <= now
    {
        return Err(denied());
    }
    if account.credential()?.vault.tenant != tenant
        || account.credential()?.vault.subject != subject(account.id)
        || !["de", "en"].contains(&account.locale.as_str())
    {
        return Err(unavailable());
    }
    Ok(AuthResult {
        tenant: tenant.into(),
        user: AuthUser {
            id: account.id.to_string(),
            username: account.username,
            locale: account.locale,
        },
        session: AuthSession {
            id: current.id.to_string(),
            user_id: account.id.to_string(),
            inet_addr: current.inet_addr,
            user_agent: current.user_agent,
            created_at: current.created_at,
            expires_at: current.expires_at,
        },
        roles: account.roles,
    })
}

pub async fn checked_session(
    transaction: &mut Transaction,
    auth: &AuthResult,
) -> RpcResult<(Account, TenantStatus)> {
    let user = auth.user.id.parse::<i64>().map_err(|_| denied())?;
    let session_id = auth.session.id.parse::<i64>().map_err(|_| denied())?;
    transaction
        .prefetch(vec![
            session_key(session_id),
            account_key(user),
            tenant_key(),
        ])
        .await?;
    let session: Session = transaction
        .read(session_key(session_id))
        .await?
        .ok_or_else(denied)?;
    let account: Account = transaction
        .read(account_key(user))
        .await?
        .ok_or_else(denied)?;
    let tenant: TenantStatus = transaction.read(tenant_key()).await?.ok_or_else(denied)?;
    let now = Utc::now();
    if !tenant.available(now)
        || !account.active(now)
        || account.id != user
        || account.username != auth.user.username
        || account.roles != auth.roles
        || account.credential()?.vault.tenant != auth.tenant
        || account.credential()?.vault.subject != subject(account.id)
        || session.id != session_id
        || session.user_id != user
        || session.account_epoch != account.epoch
        || session.tenant_epoch != tenant.epoch
        || session.created_at > now
        || session.expires_at <= now
    {
        return Err(denied());
    }
    Ok((account, tenant))
}

pub async fn new_session(
    transaction: &mut Transaction,
    account: &Account,
    tenant: &TenantStatus,
    inet_addr: Option<&str>,
    user_agent: Option<&str>,
) -> RpcResult<Session> {
    let now = Utc::now();
    if !account.active(now) || !tenant.available(now) {
        return Err(denied());
    }
    let id = random_id()?;
    if transaction
        .read::<Session>(session_key(id))
        .await?
        .is_some()
    {
        return Err(super::conflict());
    }
    let session = Session {
        id,
        user_id: account.id,
        account_epoch: account.epoch,
        tenant_epoch: tenant.epoch,
        inet_addr: inet_addr.map(|value| value.chars().take(128).collect()),
        user_agent: user_agent.map(|value| value.chars().take(1024).collect()),
        created_at: now,
        expires_at: now + chrono::Duration::days(30),
    };
    transaction
        .put_expiring(session_key(id), &session, session.expires_at)
        .await?;
    Ok(session)
}
