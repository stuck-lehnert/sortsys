//! Shared account budgets and bounded, cancellation-safe password work.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::control::{Repository, key};
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Counter {
    attempts: u32,
    expires_at: DateTime<Utc>,
}

fn encoded_key(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn reserve_shared(repository: &Repository, account: &[u8]) -> RpcResult<DateTime<Utc>> {
    let account = encoded_key(account);
    let record = key("login-attempts", &account);
    for _ in 0..16 {
        let mut transaction = repository.transaction()?;
        let current: Option<Counter> = transaction.read(record.clone()).await?;
        let now = Utc::now();
        let next = match current {
            Some(current) if current.expires_at > now => {
                if current.attempts >= 10 {
                    return Err(throttled());
                }
                Counter {
                    attempts: current.attempts + 1,
                    ..current
                }
            }
            _ => Counter {
                attempts: 1,
                expires_at: now + chrono::Duration::minutes(15),
            },
        };
        let expires_at = next.expires_at;
        transaction
            .put_expiring(record.clone(), &next, expires_at)
            .await?;
        match transaction.commit().await {
            Ok(_) => return Ok(expires_at),
            Err(error) if error.code == ErrorCode::Conflict => continue,
            Err(error) => return Err(error),
        }
    }
    Err(throttled())
}

pub(crate) async fn reserve(
    repository: &Repository,
    secret: &[u8],
    scope: &str,
    parts: &[&str],
) -> RpcResult<LoginAttempt> {
    let key = account_key(secret, scope, parts);
    let expires_at = tokio::time::timeout(Duration::from_secs(2), reserve_shared(repository, &key))
        .await
        .map_err(|_| unavailable())??;
    let _ = tokio::time::timeout(Duration::from_millis(500), repository.cleanup_expired()).await;
    Ok(LoginAttempt { key, expires_at })
}

impl LoginAttempt {
    pub(crate) fn reservation(&self) -> (&[u8], DateTime<Utc>) {
        (&self.key, self.expires_at)
    }

    pub(crate) fn resume(key: Vec<u8>, expires_at: DateTime<Utc>) -> Self {
        Self { key, expires_at }
    }

    async fn refund(self, repository: &Repository) -> RpcResult<()> {
        let record = key("login-attempts", &encoded_key(&self.key));
        for _ in 0..8 {
            let mut transaction = repository.transaction()?;
            let Some(mut counter) = transaction.read::<Counter>(record.clone()).await? else {
                return Ok(());
            };
            if counter.expires_at != self.expires_at || counter.attempts == 0 {
                return Ok(());
            }
            counter.attempts -= 1;
            transaction
                .put_expiring(record.clone(), &counter, counter.expires_at)
                .await?;
            match transaction.commit().await {
                Ok(_) => return Ok(()),
                Err(error) if error.code == ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub(crate) async fn succeeded(self, repository: &Repository) {
        let _ = tokio::time::timeout(Duration::from_secs(1), self.refund(repository)).await;
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
