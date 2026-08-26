//! JWT authentication, session persistence, and role evaluation.

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::HeaderMap;
use bcrypt::verify;
use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::FromRow;
use ts_rs::TS;

use crate::{
    config::Config,
    database::TenantStore,
    error::{ErrorCode, RpcError, RpcResult},
};

const USER_TOKEN_TTL_SECONDS: usize = 30 * 24 * 60 * 60;
const ADMIN_TOKEN_TTL_SECONDS: usize = 2 * 60 * 60;

#[derive(Clone)]
pub struct AuthService {
    tenants: TenantStore,
    jwt_secret: Arc<[u8]>,
    admin_hash: Arc<str>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub tenant: String,
    pub user: AuthUser,
    pub session: AuthSession,
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub salutation: Option<String>,
    pub first_name: String,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    #[ts(type = "\"internal\" | \"external\" | \"subcontractor\"")]
    pub contract_type: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub id: String,
    pub user_id: String,
    pub inet_addr: Option<String>,
    pub user_agent: Option<String>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub expires_at: DateTime<Utc>,
}

impl AuthResult {
    pub fn is_admin(&self) -> bool {
        self.roles.iter().any(|role| role == ":admin")
    }

    pub fn can_do(&self, role: &str) -> bool {
        self.is_admin()
            || self.roles.iter().any(|candidate| candidate == role)
            || role.strip_prefix("view:").is_some_and(|suffix| {
                self.roles
                    .iter()
                    .any(|candidate| candidate == &format!("manage:{suffix}"))
            })
    }
}

impl AuthService {
    pub fn new(config: &Config, tenants: TenantStore) -> Self {
        Self {
            tenants,
            jwt_secret: Arc::clone(&config.jwt_secret),
            admin_hash: Arc::clone(&config.admin_hash),
        }
    }

    pub async fn login(
        &self,
        tenant: &str,
        username: &str,
        password: &str,
        user_agent: Option<&str>,
        inet_addr: Option<&str>,
    ) -> Option<String> {
        if tenant.is_empty() || username.is_empty() || password.is_empty() {
            return None;
        }
        let tenant = tenant.to_lowercase();
        let username = username.to_lowercase();
        let pool = self.tenants.tenant_pool(&tenant).await.ok()?;
        let user = sqlx::query_as::<_, LoginUser>(
            "SELECT id, password FROM users \
             WHERE username = $1 AND (deactivated_at IS NULL OR deactivated_at > NOW())",
        )
        .bind(username)
        .fetch_optional(&pool)
        .await
        .ok()??;
        let password_hash = user.password?;
        let password = password.to_owned();
        let matches = tokio::task::spawn_blocking(move || verify(password, &password_hash))
            .await
            .ok()?
            .ok()?;
        if !matches {
            return None;
        }

        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO user_sessions (user_id, inet_addr, user_agent) \
             VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(user.id)
        .bind(inet_addr)
        .bind(user_agent)
        .fetch_one(&pool)
        .await
        .ok()?;
        self.issue_user_token(&tenant, &session_id.to_string()).ok()
    }

    pub(crate) fn issue_challenge_token<T: Serialize>(&self, claims: &T) -> RpcResult<String> {
        encode(
            &Header::new(Algorithm::HS512),
            claims,
            &EncodingKey::from_secret(&self.jwt_secret),
        )
        .map_err(|error| RpcError::new(ErrorCode::InternalServerError, error.to_string()))
    }

    pub(crate) fn verify_challenge_token<T>(&self, token: &str) -> RpcResult<T>
    where
        T: DeserializeOwned + Clone,
    {
        decode::<T>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &Validation::new(Algorithm::HS512),
        )
        .map(|data| data.claims)
        .map_err(|_| unauthorized("Invalid or expired passkey challenge"))
    }

    pub async fn login_admin(&self, password: &str, tenant: Option<&str>) -> Option<String> {
        let password_hash = match tenant {
            Some(name) => self.tenants.tenant(name).await.ok()??.admin_hash,
            None => self.admin_hash.to_string(),
        };
        let password = password.to_owned();
        let matches = tokio::task::spawn_blocking(move || verify(password, &password_hash))
            .await
            .ok()?
            .ok()?;
        if !matches {
            return None;
        }
        self.issue_admin_token(tenant.unwrap_or("+all")).ok()
    }

    pub async fn authenticate(&self, headers: &HeaderMap) -> RpcResult<AuthResult> {
        let token = bearer(headers)?;
        let claims = self.decode(token)?;
        let tenant = claims
            .tenant
            .ok_or_else(|| unauthorized("Provided JWT token does not seem to be valid"))?;
        let session_id = claims
            .session_id
            .ok_or_else(|| unauthorized("Provided JWT token does not seem to be valid"))?;
        let session_id: i64 = session_id
            .parse()
            .map_err(|_| unauthorized("Provided JWT token does not seem to be valid"))?;
        let pool =
            self.tenants.tenant_pool(&tenant).await.map_err(|error| {
                RpcError::new(ErrorCode::InternalServerError, error.to_string())
            })?;
        let row = sqlx::query_as::<_, AuthRow>(
            "SELECT u.id AS user_id, u.username, u.salutation, u.first_name, u.last_name, \
                    u.phone, u.email, u.contract_type, session.id AS session_id, \
                    session.inet_addr, session.user_agent, session.created_at, session.expires_at, \
                    ARRAY_REMOVE(ARRAY_AGG(ura.role_name), NULL) AS roles \
             FROM user_sessions session \
             JOIN users u ON u.id = session.user_id \
             LEFT JOIN user_role_assignments ura ON ura.user_id = session.user_id \
             WHERE session.id = $1 AND u.deactivated_at IS NULL \
               AND session.created_at < NOW() AND session.expires_at > NOW() \
             GROUP BY session.id, u.id",
        )
        .bind(session_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalServerError, error.to_string()))?
        .ok_or_else(|| unauthorized("Session closed, deleted, expired or user deactivated"))?;

        Ok(AuthResult {
            tenant,
            user: AuthUser {
                id: row.user_id.to_string(),
                username: row.username,
                salutation: row.salutation,
                first_name: row.first_name,
                last_name: row.last_name,
                phone: row.phone,
                email: row.email,
                contract_type: row.contract_type,
            },
            session: AuthSession {
                id: row.session_id.to_string(),
                user_id: row.user_id.to_string(),
                inet_addr: row.inet_addr,
                user_agent: row.user_agent,
                created_at: row.created_at,
                expires_at: row.expires_at,
            },
            roles: row.roles,
        })
    }

    pub async fn authenticate_admin(&self, headers: &HeaderMap) -> RpcResult<String> {
        let token = bearer(headers)?;
        let admin_for = self
            .decode(token)?
            .admin_for
            .ok_or_else(|| unauthorized("Provided JWT token does not seem to be valid"))?;
        if admin_for != "+all" {
            let tenant = self
                .tenants
                .tenant(&admin_for)
                .await
                .map_err(|error| RpcError::new(ErrorCode::InternalServerError, error.to_string()))?
                .ok_or_else(|| unauthorized("Tenant does no longer exist"))?;
            if tenant.deleted_at.is_some_and(|at| at < Utc::now()) {
                return Err(unauthorized("Tenant got deleted"));
            }
        }
        Ok(admin_for)
    }

    pub async fn logout(&self, auth: &AuthResult) -> RpcResult<()> {
        let pool = self
            .tenants
            .tenant_pool(&auth.tenant)
            .await
            .map_err(|error| RpcError::new(ErrorCode::InternalServerError, error.to_string()))?;
        let id: i64 = auth
            .session
            .id
            .parse()
            .map_err(|error: std::num::ParseIntError| {
                RpcError::new(ErrorCode::InternalServerError, error.to_string())
            })?;
        sqlx::query("UPDATE user_sessions SET expires_at = NOW() WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|error| RpcError::new(ErrorCode::InternalServerError, error.to_string()))?;
        Ok(())
    }

    pub(crate) fn issue_user_token(
        &self,
        tenant: &str,
        session_id: &str,
    ) -> jsonwebtoken::errors::Result<String> {
        let now = unix_time();
        encode(
            &Header::new(Algorithm::HS512),
            &Claims {
                tenant: Some(tenant.to_owned()),
                session_id: Some(session_id.to_owned()),
                admin_for: None,
                iat: now,
                exp: now + USER_TOKEN_TTL_SECONDS,
            },
            &EncodingKey::from_secret(&self.jwt_secret),
        )
    }

    fn issue_admin_token(&self, admin_for: &str) -> jsonwebtoken::errors::Result<String> {
        let now = unix_time();
        encode(
            &Header::new(Algorithm::HS512),
            &Claims {
                tenant: None,
                session_id: None,
                admin_for: Some(admin_for.to_owned()),
                iat: now,
                exp: now + ADMIN_TOKEN_TTL_SECONDS,
            },
            &EncodingKey::from_secret(&self.jwt_secret),
        )
    }

    fn decode(&self, token: &str) -> RpcResult<Claims> {
        decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &Validation::new(Algorithm::HS512),
        )
        .map(|data| data.claims)
        .map_err(|_| unauthorized("Provided JWT token does not seem to be valid"))
    }
}

fn bearer(headers: &HeaderMap) -> RpcResult<&str> {
    let value = headers
        .get("authorization")
        .ok_or_else(|| unauthorized("Missing 'Authorization' header"))?
        .to_str()
        .map_err(|_| unauthorized("'Authorization' header is invalid"))?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or_else(|| unauthorized("'Authorization' header should start with 'Bearer '"))?
        .trim();
    if token.is_empty() {
        return Err(unauthorized(
            "'Authorization' header is prefixed with 'Bearer ' but no JWT is provided",
        ));
    }
    Ok(token)
}

fn unauthorized(message: &str) -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, message).with_http_code(401)
}

fn unix_time() -> usize {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as usize
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    tenant: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "adminFor")]
    admin_for: Option<String>,
    iat: usize,
    exp: usize,
}

#[derive(FromRow)]
struct LoginUser {
    id: i64,
    password: Option<String>,
}

#[derive(FromRow)]
struct AuthRow {
    user_id: i64,
    username: String,
    salutation: Option<String>,
    first_name: String,
    last_name: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    contract_type: String,
    session_id: i64,
    inet_addr: Option<String>,
    user_agent: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    roles: Vec<String>,
}
