//! PostgreSQL-backed queue operations used by the WebSocket job runners.
//!
//! State transitions use guarded UPDATE statements, so acquiring, completing,
//! and extending jobs stays safe when several runners operate concurrently.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, types::Json};

use crate::{
    AppState,
    error::{ErrorCode, RpcError, RpcResult},
};

pub const THUMBNAIL_JOB_TYPE: &str = "project_file_thumbnail_generate";
pub const TENANT_LOGO_JOB_TYPE: &str = "tenant_logo_generate";

const DEFAULT_LEASE_SECONDS: i32 = 90;
const MIN_LEASE_SECONDS: i32 = 5;
const MAX_LEASE_SECONDS: i32 = 15 * 60;

#[derive(Debug, Clone, FromRow)]
pub struct QueueJob {
    pub id: i64,
    pub tenant_name: String,
    pub r#type: String,
    pub payload: Json<Value>,
    pub state: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub available_at: DateTime<Utc>,
    pub acquired_by_runner_id: Option<String>,
    pub acquired_at: Option<DateTime<Utc>>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub result: Option<Json<Value>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenJob {
    pub id: String,
    pub tenant_name: String,
    pub r#type: String,
    pub attempts: i32,
    pub available_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct FailedJob {
    pub should_retry: bool,
    pub job: QueueJob,
}

pub async fn list_open(
    state: &AppState,
    limit: i64,
    job_type: Option<&str>,
) -> RpcResult<Vec<OpenJob>> {
    let rows = sqlx::query_as::<_, OpenJobRow>(
        r#"
        SELECT id, tenant_name, type, attempts, available_at
        FROM __jobs
        WHERE available_at <= NOW()
          AND (
              state = 'pending'
              OR (
                  state = 'processing'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
              )
          )
          AND ($2::TEXT IS NULL OR type = $2)
        ORDER BY available_at ASC, id ASC
        LIMIT $1
        "#,
    )
    .bind(limit.clamp(1, 50))
    .bind(job_type)
    .fetch_all(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(rows
        .into_iter()
        .map(|row| OpenJob {
            id: row.id.to_string(),
            tenant_name: row.tenant_name,
            r#type: row.r#type,
            attempts: row.attempts,
            available_at: row.available_at,
        })
        .collect())
}

pub async fn acquire(
    state: &AppState,
    job_id: i64,
    runner_id: &str,
    lease_seconds: i32,
) -> RpcResult<Option<QueueJob>> {
    sqlx::query_as::<_, QueueJob>(
        r#"
        UPDATE __jobs
        SET
            state = 'processing',
            attempts = attempts + 1,
            acquired_by_runner_id = $2,
            acquired_at = NOW(),
            lease_expires_at = NOW() + MAKE_INTERVAL(secs => $3),
            updated_at = NOW()
        WHERE id = $1
          AND available_at <= NOW()
          AND (
              state = 'pending'
              OR (
                  state = 'processing'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
              )
          )
        RETURNING *
        "#,
    )
    .bind(job_id)
    .bind(runner_id)
    .bind(normalize_lease_seconds(lease_seconds))
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)
}

pub async fn heartbeat(
    state: &AppState,
    runner_id: &str,
    job_id: Option<i64>,
    lease_seconds: i32,
) -> RpcResult<u64> {
    let updated = sqlx::query(
        r#"
        UPDATE __jobs
        SET
            lease_expires_at = NOW() + MAKE_INTERVAL(secs => $3),
            updated_at = NOW()
        WHERE state = 'processing'
          AND acquired_by_runner_id = $1
          AND ($2::BIGINT IS NULL OR id = $2)
        "#,
    )
    .bind(runner_id)
    .bind(job_id)
    .bind(normalize_lease_seconds(lease_seconds))
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(updated.rows_affected())
}

pub async fn complete(
    state: &AppState,
    runner_id: &str,
    job_id: i64,
    result: Value,
) -> RpcResult<Option<QueueJob>> {
    sqlx::query_as::<_, QueueJob>(
        r#"
        UPDATE __jobs
        SET
            state = 'succeeded',
            result = $3,
            finished_at = NOW(),
            acquired_by_runner_id = NULL,
            acquired_at = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND state = 'processing'
          AND acquired_by_runner_id = $2
          AND (lease_expires_at IS NULL OR lease_expires_at > NOW())
        RETURNING *
        "#,
    )
    .bind(job_id)
    .bind(runner_id)
    .bind(Json(result))
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)
}

pub async fn fail(
    state: &AppState,
    runner_id: &str,
    job_id: i64,
    error: &str,
    retry_after_seconds: i32,
) -> RpcResult<Option<FailedJob>> {
    let mut transaction = state.tenants.master().begin().await.map_err(internal)?;

    let current = sqlx::query_as::<_, QueueJob>(
        r#"
        SELECT *
        FROM __jobs
        WHERE id = $1
          AND state = 'processing'
          AND acquired_by_runner_id = $2
          AND (lease_expires_at IS NULL OR lease_expires_at > NOW())
        FOR UPDATE
        "#,
    )
    .bind(job_id)
    .bind(runner_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal)?;

    let Some(current) = current else {
        transaction.commit().await.map_err(internal)?;
        return Ok(None);
    };

    let should_retry = current.attempts < current.max_attempts;
    let retry_after_seconds = retry_after_seconds.clamp(0, 24 * 60 * 60);
    let next_state = if should_retry { "pending" } else { "failed" };

    let updated = sqlx::query_as::<_, QueueJob>(
        r#"
        UPDATE __jobs
        SET
            state = $2,
            available_at = CASE
                WHEN $3 THEN NOW() + MAKE_INTERVAL(secs => $4)
                ELSE NOW()
            END,
            last_error = $5,
            finished_at = CASE WHEN $3 THEN NULL ELSE NOW() END,
            acquired_by_runner_id = NULL,
            acquired_at = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(job_id)
    .bind(next_state)
    .bind(should_retry)
    .bind(retry_after_seconds)
    .bind(error)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(Some(FailedJob {
        should_retry,
        job: updated,
    }))
}

pub async fn release_runner_jobs(state: &AppState, runner_id: &str) -> RpcResult<u64> {
    let updated = sqlx::query(
        r#"
        UPDATE __jobs
        SET
            state = 'pending',
            available_at = NOW(),
            acquired_by_runner_id = NULL,
            acquired_at = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE state = 'processing'
          AND acquired_by_runner_id = $1
        "#,
    )
    .bind(runner_id)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(updated.rows_affected())
}

pub fn normalize_lease_seconds(value: i32) -> i32 {
    if value <= 0 {
        DEFAULT_LEASE_SECONDS
    } else {
        value.clamp(MIN_LEASE_SECONDS, MAX_LEASE_SECONDS)
    }
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

#[derive(Debug, FromRow)]
struct OpenJobRow {
    id: i64,
    tenant_name: String,
    r#type: String,
    attempts: i32,
    available_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::normalize_lease_seconds;

    #[test]
    fn normalizes_runner_leases_to_the_protocol_bounds() {
        assert_eq!(normalize_lease_seconds(0), 90);
        assert_eq!(normalize_lease_seconds(1), 5);
        assert_eq!(normalize_lease_seconds(90), 90);
        assert_eq!(normalize_lease_seconds(1_000), 900);
    }
}
