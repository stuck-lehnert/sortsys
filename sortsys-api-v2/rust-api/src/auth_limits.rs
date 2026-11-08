//! Shared account budgets and bounded, cancellation-safe password work.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::PgPool;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, SemaphorePermit};

use crate::error::{ErrorCode, RpcError, RpcResult};

// These limits cover user, tenant-administrator and global-administrator logins
// together, even if several AuthService instances exist in the same process.
static LOGIN_REQUESTS: Semaphore = Semaphore::const_new(64);
static PASSWORD_CHECKS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));

pub(crate) fn admit_login() -> RpcResult<SemaphorePermit<'static>> {
    LOGIN_REQUESTS.try_acquire().map_err(|_| throttled())
}

fn throttled() -> RpcError {
    RpcError::new(
        ErrorCode::TooManyRequests,
        "Too many login attempts. Try again later.",
    )
    .with_http_code(429)
}

fn unavailable() -> RpcError {
    RpcError::new(
        ErrorCode::InternalServerError,
        "Login temporarily unavailable",
    )
    .with_http_code(503)
}

fn account_key(secret: &[u8], scope: &str, parts: &[&str]) -> Vec<u8> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts arbitrary key lengths");
    mac.update(b"sortsys:login:v1");
    for part in std::iter::once(scope).chain(parts.iter().copied()) {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part.as_bytes());
    }
    mac.finalize().into_bytes().to_vec()
}

pub(crate) struct LoginAttempt {
    key: Vec<u8>,
    expires_at: DateTime<Utc>,
}

pub(crate) async fn reserve(
    pool: &PgPool,
    secret: &[u8],
    scope: &str,
    parts: &[&str],
) -> RpcResult<LoginAttempt> {
    let key = account_key(secret, scope, parts);
    // PostgreSQL serializes competing upserts on this key, including requests
    // received by another replica. Rejected attempts never extend the window.
    let query = sqlx::query_scalar::<_, DateTime<Utc>>(
        "INSERT INTO __login_attempts (account_key, attempts, expires_at) \
         VALUES ($1, 1, statement_timestamp() + INTERVAL '15 minutes') \
         ON CONFLICT (account_key) DO UPDATE SET \
           attempts = CASE WHEN __login_attempts.expires_at <= statement_timestamp() \
             THEN 1 ELSE __login_attempts.attempts + 1 END, \
           expires_at = CASE WHEN __login_attempts.expires_at <= statement_timestamp() \
             THEN statement_timestamp() + INTERVAL '15 minutes' ELSE __login_attempts.expires_at END \
         WHERE __login_attempts.expires_at <= statement_timestamp() OR __login_attempts.attempts < 10 \
         RETURNING expires_at",
    ).bind(&key).fetch_optional(pool);
    let expires_at = tokio::time::timeout(Duration::from_secs(2), query)
        .await
        .map_err(|_| unavailable())?
        .map_err(|error| {
            tracing::warn!(%error, "login admission database unavailable");
            unavailable()
        })?;

    // Separate, short transaction: cleanup cannot deadlock an admission upsert
    // by holding locks on other account keys. SKIP LOCKED also works across replicas.
    let cleanup = sqlx::query(
        "WITH expired AS (SELECT account_key FROM __login_attempts \
           WHERE expires_at <= statement_timestamp() ORDER BY expires_at \
           LIMIT 128 FOR UPDATE SKIP LOCKED) \
         DELETE FROM __login_attempts AS attempt USING expired \
         WHERE attempt.account_key = expired.account_key",
    )
    .execute(pool);
    let _ = tokio::time::timeout(Duration::from_millis(500), cleanup).await;

    Ok(LoginAttempt {
        key,
        expires_at: expires_at.ok_or_else(throttled)?,
    })
}

impl LoginAttempt {
    pub(crate) async fn succeeded(self, pool: &PgPool) {
        // Return only this successful attempt's reservation. Never erase other
        // failures, or refund an old request into a newly started window.
        let refund = sqlx::query(
            "UPDATE __login_attempts SET attempts = GREATEST(0, attempts - 1) \
             WHERE account_key = $1 AND expires_at = $2",
        )
        .bind(self.key)
        .bind(self.expires_at)
        .execute(pool);
        let _ = tokio::time::timeout(Duration::from_secs(1), refund).await;
    }
}

pub(crate) async fn password_slot() -> RpcResult<OwnedSemaphorePermit> {
    acquire_password_slot(Arc::clone(&PASSWORD_CHECKS)).await
}

pub(crate) async fn verify_password(
    password: String,
    hash: String,
    permit: OwnedSemaphorePermit,
) -> RpcResult<bool> {
    password_work(permit, move || {
        bcrypt::verify(password, &hash).unwrap_or(false)
    })
    .await
}

async fn acquire_password_slot(slots: Arc<Semaphore>) -> RpcResult<OwnedSemaphorePermit> {
    tokio::time::timeout(Duration::from_millis(250), slots.acquire_owned())
        .await
        .map_err(|_| throttled())?
        .map_err(|_| unavailable())
}

async fn password_work<T: Send + 'static>(
    permit: OwnedSemaphorePermit,
    work: impl FnOnce() -> T + Send + 'static,
) -> RpcResult<T> {
    tokio::task::spawn_blocking(move || {
        // Aborting the HTTP future cannot stop spawn_blocking. The permit must
        // remain inside that task until its actual CPU work has finished.
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_keys_separate_tenants_admins_and_ambiguous_components() {
        let key = account_key(b"test-secret", "user", &["tenant", "user"]);
        for other in [
            account_key(b"other-secret", "user", &["tenant", "user"]),
            account_key(b"test-secret", "user", &["other", "user"]),
            account_key(b"test-secret", "admin-tenant", &["tenant", "user"]),
            account_key(b"test-secret", "admin-global", &[]),
            account_key(b"test-secret", "user", &["ten", "antuser"]),
        ] {
            assert_ne!(key, other);
        }
        assert_eq!(key.len(), 32);
    }

    #[tokio::test]
    async fn canceled_requests_cannot_release_running_password_work() {
        let slots = Arc::new(Semaphore::new(1));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let permit = acquire_password_slot(Arc::clone(&slots)).await.unwrap();
        let work = tokio::spawn(password_work(permit, move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
        }));
        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();
        work.abort();
        assert!(work.await.unwrap_err().is_cancelled());
        assert_eq!(slots.available_permits(), 0);
        finish_tx.send(()).unwrap();
        let _released = tokio::time::timeout(Duration::from_secs(1), slots.acquire())
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn saturated_password_work_rejects_without_enqueuing_a_blocking_task() {
        let slots = Arc::new(Semaphore::new(1));
        let _occupied = slots.acquire().await.unwrap();
        let error = acquire_password_slot(Arc::clone(&slots)).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::TooManyRequests);
        assert_eq!(error.http_code, Some(429));
    }
}
