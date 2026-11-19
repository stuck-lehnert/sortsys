//! JWT authentication, session persistence, and role evaluation.

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use ts_rs::TS;

use crate::{
    auth_limits,
    control::{Repository, accounts, key},
    error::{ErrorCode, RpcError, RpcResult},
};

const USER_TOKEN_TTL_SECONDS: usize = 30 * 24 * 60 * 60;
const ADMIN_TOKEN_TTL_SECONDS: usize = 2 * 60 * 60;
const MCP_TOKEN_TTL_SECONDS: usize = 10 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum McpScope {
    Chat(i64),
    DocumentImport,
}

impl McpScope {
    fn from_claims(purpose: Option<&str>, chat_id: Option<i64>) -> RpcResult<Self> {
        match (purpose, chat_id) {
            (Some("llm-mcp"), Some(chat_id)) => Ok(Self::Chat(chat_id)),
            (Some("llm-document-import-mcp"), None) => Ok(Self::DocumentImport),
            _ => Err(unauthorized(
                "Provided JWT token is not a valid MCP delegation",
            )),
        }
    }
}

#[derive(Clone)]
pub struct AuthService {
    records: Option<Repository>,
    jwt_secret: Arc<[u8]>,
    admin_hash: Arc<str>,
    pub(crate) passkeys: crate::zerotrust::passkeys::Config,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub tenant: String,
    pub user: AuthUser,
    pub session: AuthSession,
    pub roles: Vec<String>,
}

/// Authentication carries technical account identity only. Personnel fields
/// belong to the browser's encrypted profile, including in audit labels.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    #[ts(type = "\"de\" | \"en\"")]
    pub locale: String,
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
    pub(crate) fn from_credentials(
        jwt_secret: Arc<[u8]>,
        admin_hash: Arc<str>,
        records: Option<Repository>,
    ) -> Self {
        Self {
            records,
            jwt_secret,
            admin_hash,
            passkeys: crate::zerotrust::passkeys::Config::default(),
        }
    }

    pub(crate) fn with_passkeys(mut self, config: crate::zerotrust::passkeys::Config) -> Self {
        self.passkeys = config;
        self
    }

    pub(crate) fn records(&self) -> RpcResult<&Repository> {
        self.records
            .as_ref()
            .ok_or_else(crate::control::unavailable)
    }

    /// Unknown accounts receive an equally stable, opaque-looking identity.
    /// This avoids making login-start an account-existence oracle.
    pub(crate) fn dummy_credential_subject(&self, tenant: &str, username: &str) -> String {
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.jwt_secret)
            .expect("HMAC accepts arbitrary key lengths");
        mac.update(&sortsys_zerotrust::crypto::frame(
            "sortsys/unknown-credential/v1",
            &[tenant, username],
        ));
        let digest = mac.finalize().into_bytes();
        let mut bytes = [0; 8];
        bytes.copy_from_slice(&digest[..8]);
        let user = ((u64::from_be_bytes(bytes) & i64::MAX as u64) as i64).max(1);
        accounts::subject(user)
    }

    pub(crate) async fn reserve_login(
        &self,
        scope: &str,
        parts: &[&str],
    ) -> RpcResult<auth_limits::LoginAttempt> {
        auth_limits::reserve(self.records()?, &self.jwt_secret, scope, parts).await
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

    pub async fn login_admin(
        &self,
        password: &str,
        tenant: Option<&str>,
    ) -> RpcResult<Option<String>> {
        let tenant = tenant.map(|name| name.trim().to_lowercase());
        if password.is_empty()
            || password.len() > 2_000
            || tenant
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.chars().count() > 127)
        {
            return Ok(None);
        }
        let _admission = auth_limits::admit_login()?;
        let (scope, parts) = match tenant.as_deref() {
            Some(name) => ("admin-tenant", vec![name]),
            None => ("admin-global", vec![]),
        };
        let attempt =
            auth_limits::reserve(self.records()?, &self.jwt_secret, scope, &parts).await?;
        let token = self
            .login_administrator(password, tenant.as_deref())
            .await?;
        if token.is_some() {
            attempt.succeeded(self.records()?).await;
        }
        Ok(token)
    }

    async fn login_administrator(
        &self,
        password: &str,
        tenant: Option<&str>,
    ) -> RpcResult<Option<String>> {
        if let Some(name) = tenant {
            let present = self
                .records()?
                .read::<serde_json::Value>(key("tenants", name))
                .await?
                .value;
            if present.is_none() {
                return Ok(None);
            }
        }
        let permit = auth_limits::password_slot().await?;
        let password_hash = self.admin_hash.to_string();
        let matches =
            auth_limits::verify_password(password.to_owned(), password_hash, permit).await?;
        if !matches {
            return Ok(None);
        }
        Ok(self.issue_admin_token(tenant.unwrap_or("+all")).ok())
    }

    pub async fn authenticate(&self, headers: &HeaderMap) -> RpcResult<AuthResult> {
        let token = bearer(headers)?;
        let claims = self.decode(token)?;
        if claims.purpose.is_some() {
            return Err(unauthorized(
                "Provided JWT token cannot be used for this request",
            ));
        }
        self.authenticate_claims(claims).await
    }

    pub(crate) async fn authenticate_mcp(
        &self,
        headers: &HeaderMap,
        run: &str,
    ) -> RpcResult<(AuthResult, McpScope)> {
        let token = bearer(headers)?;
        let claims = self.decode(token)?;
        let scope = claims.mcp_scope(run)?;
        let auth = self.authenticate_claims(claims).await?;

        Ok((auth, scope))
    }

    async fn authenticate_claims(&self, claims: Claims) -> RpcResult<AuthResult> {
        let tenant = claims
            .tenant
            .ok_or_else(|| unauthorized("Provided JWT token does not seem to be valid"))?;
        let session_id = claims
            .session_id
            .ok_or_else(|| unauthorized("Provided JWT token does not seem to be valid"))?;
        let session_id: i64 = session_id
            .parse()
            .map_err(|_| unauthorized("Provided JWT token does not seem to be valid"))?;
        let identity = accounts::session_identity(self.records()?, &tenant, session_id).await?;
        Ok(identity)
    }

    pub async fn authenticate_admin(&self, headers: &HeaderMap) -> RpcResult<String> {
        let token = bearer(headers)?;
        let admin_for = self
            .decode(token)?
            .admin_for
            .ok_or_else(|| unauthorized("Provided JWT token does not seem to be valid"))?;
        if admin_for != "+all" {
            let repository = self.records()?.tenant(&admin_for)?;
            let status = repository
                .read::<accounts::TenantStatus>(accounts::tenant_key())
                .await?
                .value
                .ok_or_else(|| unauthorized("Tenant no longer exists"))?;
            if status.deleted_at.is_some_and(|at| at <= Utc::now()) {
                return Err(unauthorized("Tenant got deleted"));
            }
        }
        Ok(admin_for)
    }

    /// Infrastructure-wide controls must not accept a tenant-scoped operator
    /// or an ordinary tenant administrator merely because both are called admin.
    pub(crate) async fn require_global_operator(&self, headers: &HeaderMap) -> RpcResult<()> {
        if self.authenticate_admin(headers).await? != "+all" {
            return Err(
                RpcError::new(ErrorCode::Forbidden, "Global operator access required")
                    .with_http_code(403),
            );
        }
        Ok(())
    }

    pub async fn logout(&self, auth: &AuthResult) -> RpcResult<()> {
        let repository = self.records()?.tenant(&auth.tenant)?;
        let id: i64 = auth
            .session
            .id
            .parse()
            .map_err(|_| unauthorized("Invalid session"))?;
        for _ in 0..8 {
            let mut transaction = repository.transaction()?;
            let Some(mut session) = transaction
                .read::<accounts::Session>(accounts::session_key(id))
                .await?
            else {
                return Ok(());
            };
            if session.user_id.to_string() != auth.user.id {
                return Err(unauthorized("Invalid session"));
            }
            session.expires_at = Utc::now();
            transaction
                .put_expiring(accounts::session_key(id), &session, session.expires_at)
                .await?;
            match transaction.commit().await {
                Ok(_) => return Ok(()),
                Err(error) if error.code == ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            }
        }
        Err(crate::control::conflict())
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
                purpose: None,
                chat_id: None,
                mcp_run: None,
                iat: now,
                exp: now + USER_TOKEN_TTL_SECONDS,
            },
            &EncodingKey::from_secret(&self.jwt_secret),
        )
    }

    pub(crate) fn issue_live_mcp_token(
        &self,
        auth: &AuthResult,
        scope: McpScope,
        run: &str,
    ) -> jsonwebtoken::errors::Result<String> {
        let now = unix_time();
        let (purpose, chat_id) = match scope {
            McpScope::Chat(chat_id) => ("llm-mcp", Some(chat_id)),
            McpScope::DocumentImport => ("llm-document-import-mcp", None),
        };

        encode(
            &Header::new(Algorithm::HS512),
            &Claims {
                tenant: Some(auth.tenant.clone()),
                session_id: Some(auth.session.id.clone()),
                admin_for: None,
                purpose: Some(purpose.to_owned()),
                chat_id,
                mcp_run: Some(run.to_owned()),
                iat: now,
                exp: now + MCP_TOKEN_TTL_SECONDS,
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
                purpose: None,
                chat_id: None,
                mcp_run: None,
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
    purpose: Option<String>,
    #[serde(rename = "chatId")]
    chat_id: Option<i64>,
    #[serde(rename = "mcpRun", skip_serializing_if = "Option::is_none")]
    mcp_run: Option<String>,
    iat: usize,
    exp: usize,
}

impl Claims {
    fn mcp_scope(&self, run: &str) -> RpcResult<McpScope> {
        if run.is_empty() || self.mcp_run.as_deref() != Some(run) {
            return Err(unauthorized(
                "This MCP delegation belongs to another request",
            ));
        }
        McpScope::from_claims(self.purpose.as_deref(), self.chat_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthService, AuthUser, Claims, McpScope, accounts};
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
    use std::sync::Arc;

    #[test]
    fn unknown_credential_subjects_are_stable_across_replicas_and_partitioned() {
        let secret: Arc<[u8]> = Arc::from(b"synthetic-shared-authentication-secret".as_slice());
        let first = AuthService::from_credentials(Arc::clone(&secret), "unused".into(), None);
        let second = AuthService::from_credentials(secret, "unused".into(), None);
        let subject = first.dummy_credential_subject("tenant", "absent");
        assert_eq!(subject, second.dummy_credential_subject("tenant", "absent"));
        assert_ne!(subject, first.dummy_credential_subject("other", "absent"));
        assert_ne!(subject, first.dummy_credential_subject("tenant", "someone"));
        let user = crate::ids::Id::decode(subject.strip_prefix("user:").unwrap()).unwrap();
        assert!(user.0 > 0);
        assert_eq!(subject, accounts::subject(user.0));
    }

    #[test]
    fn authentication_identity_serializes_no_personnel_fields() {
        let user = AuthUser {
            id: "4".to_owned(),
            username: "anna.muster".to_owned(),
            locale: "de".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(user).unwrap(),
            serde_json::json!({"id":"4","username":"anna.muster","locale":"de"})
        );
    }
    use serde::{Deserialize, Serialize};

    #[test]
    fn jwt_backend_preserves_hmac_tokens_and_rejects_wrong_secrets_or_algorithms() {
        #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
        struct FixtureClaims {
            sub: String,
            exp: u64,
        }
        let claims = FixtureClaims {
            sub: "compatibility-fixture".into(),
            exp: 4_102_444_800,
        };
        let secret = b"fixed-test-key-for-jwt-compatibility";
        // Fixed vectors independently generated with Python's hmac/hashlib.
        for (algorithm, expected) in [
            (
                Algorithm::HS256,
                "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb21wYXRpYmlsaXR5LWZpeHR1cmUiLCJleHAiOjQxMDI0NDQ4MDB9.1raetudmk3pmvbPYLWHDZoAciyHKmY3-JGU05kxOPN8",
            ),
            (
                Algorithm::HS512,
                "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJjb21wYXRpYmlsaXR5LWZpeHR1cmUiLCJleHAiOjQxMDI0NDQ4MDB9.a528zzvpgLXABhEbUgJ5_V3z0Fz2RwUP1ArqCa8cxOXbF2N05rmLhE522Mf8qBENLqoguCDLxtjW88jKYvd8YQ",
            ),
        ] {
            assert_eq!(
                encode(
                    &Header::new(algorithm),
                    &claims,
                    &EncodingKey::from_secret(secret)
                )
                .unwrap(),
                expected
            );
            assert_eq!(
                decode::<FixtureClaims>(
                    expected,
                    &DecodingKey::from_secret(secret),
                    &Validation::new(algorithm)
                )
                .unwrap()
                .claims,
                claims
            );
            assert!(
                decode::<FixtureClaims>(
                    expected,
                    &DecodingKey::from_secret(b"incorrect-test-key"),
                    &Validation::new(algorithm)
                )
                .is_err()
            );
            let other = if algorithm == Algorithm::HS256 {
                Algorithm::HS512
            } else {
                Algorithm::HS256
            };
            assert!(
                decode::<FixtureClaims>(
                    expected,
                    &DecodingKey::from_secret(secret),
                    &Validation::new(other)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn mcp_delegations_are_purpose_and_context_bound() {
        assert_eq!(
            McpScope::from_claims(Some("llm-mcp"), Some(42)).unwrap(),
            McpScope::Chat(42)
        );
        assert_eq!(
            McpScope::from_claims(Some("llm-document-import-mcp"), None).unwrap(),
            McpScope::DocumentImport,
        );

        for (purpose, chat_id) in [
            (None, None),
            (None, Some(42)),
            (Some("llm-mcp"), None),
            (Some("llm-document-import-mcp"), Some(42)),
            (Some("other-purpose"), Some(42)),
        ] {
            assert!(McpScope::from_claims(purpose, chat_id).is_err());
        }
    }

    #[test]
    fn live_mcp_claims_require_the_matching_request() {
        let mut claims: Claims = serde_json::from_value(serde_json::json!({
            "purpose": "llm-document-import-mcp",
            "tenant": "fixture",
            "sessionId": "1",
            "iat": 1,
            "exp": 2,
        }))
        .unwrap();
        assert!(claims.mcp_scope("request-a").is_err());
        claims.mcp_run = Some("request-a".into());
        assert_eq!(
            claims.mcp_scope("request-a").unwrap(),
            McpScope::DocumentImport
        );
        assert!(claims.mcp_scope("request-b").is_err());
    }
}
