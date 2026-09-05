//! Master-database access and lazily cached tenant connection pools.

use std::{collections::HashMap, str::FromStr, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use sqlx::{
    ConnectOptions, PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use tokio::sync::Mutex;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Tenant {
    pub name: String,
    pub admin_hash: String,
    pub disabled: bool,
    pub contact_details: Value,
    pub connection_details: Value,
    pub options: Value,
    pub locked_at: Option<DateTime<Utc>>,
    pub deactivated_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AccessOptions {
    pub ignore_lock_and_deactivation: bool,
}

#[derive(Clone)]
pub struct TenantStore {
    master: PgPool,
    pools: Arc<Mutex<HashMap<String, PgPool>>>,
}

impl TenantStore {
    pub async fn connect(master_dsn: &str) -> Result<Self, DatabaseError> {
        let master = PgPoolOptions::new()
            .min_connections(0)
            .max_connections(1)
            .idle_timeout(Duration::from_secs(3 * 60))
            .connect(master_dsn)
            .await?;
        ensure_master_schema(&master).await?;
        Ok(Self {
            master,
            pools: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn master(&self) -> &PgPool {
        &self.master
    }

    pub async fn tenant(&self, name: &str) -> Result<Option<Tenant>, DatabaseError> {
        let name = name.to_lowercase();
        Ok(
            sqlx::query_as::<_, Tenant>("SELECT * FROM __tenants WHERE name = $1")
                .bind(name)
                .fetch_optional(&self.master)
                .await?,
        )
    }

    pub async fn tenant_pool(&self, name: &str) -> Result<PgPool, DatabaseError> {
        self.tenant_pool_with(name, AccessOptions::default()).await
    }

    pub async fn tenant_pool_with(
        &self,
        name: &str,
        options: AccessOptions,
    ) -> Result<PgPool, DatabaseError> {
        let name = name.to_lowercase();
        let tenant = self
            .tenant(&name)
            .await?
            .ok_or_else(|| DatabaseError::TenantNotFound(name.clone()))?;
        let now = Utc::now();
        if tenant.deleted_at.is_some_and(|at| at < now) {
            return Err(DatabaseError::TenantDeleted(name));
        }
        if !options.ignore_lock_and_deactivation {
            if tenant.deactivated_at.is_some_and(|at| at < now) {
                return Err(DatabaseError::TenantDeactivated(name));
            }
            if tenant.locked_at.is_some_and(|at| at < now) {
                return Err(DatabaseError::TenantLocked(name));
            }
        }

        let details: TenantConnectionDetails = serde_json::from_value(tenant.connection_details)?;
        let dsn = match (details.postgres_database_id, details.postgres_dsn) {
            (Some(database_id), _) => self.managed_database_dsn(&database_id).await?,
            (None, Some(dsn)) if !dsn.trim().is_empty() => dsn,
            _ => return Err(DatabaseError::TenantHasNoDatabase(name)),
        };

        {
            let pools = self.pools.lock().await;
            if let Some(pool) = pools.get(&dsn) {
                return Ok(pool.clone());
            }
        }
        let pool = PgPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .idle_timeout(Duration::from_secs(60))
            .connect(&dsn)
            .await?;
        crate::migrations::apply(pool.clone()).await?;

        let mut pools = self.pools.lock().await;
        Ok(pools.entry(dsn).or_insert_with(|| pool.clone()).clone())
    }

    pub async fn live_tenant_names(&self) -> Result<Vec<String>, DatabaseError> {
        Ok(sqlx::query_scalar(
            "SELECT name FROM __tenants WHERE NOT disabled AND locked_at IS NULL AND deactivated_at IS NULL AND deleted_at IS NULL ORDER BY name",
        )
        .fetch_all(&self.master)
        .await?)
    }

    pub async fn close(&self) {
        let pools = self.pools.lock().await;
        for pool in pools.values() {
            pool.close().await;
        }
        self.master.close().await;
    }

    async fn managed_database_dsn(&self, id: &str) -> Result<String, DatabaseError> {
        let id =
            i64::from_str(id).map_err(|_| DatabaseError::InvalidManagedDatabaseId(id.into()))?;
        let row = sqlx::query(
            "SELECT d.name, d.username, d.password, h.connection_details \
             FROM __postgres_databases d \
             JOIN __postgres_hosts h ON h.id = d.host_id \
             WHERE d.id = $1",
        )
        .bind(id)
        .fetch_optional(&self.master)
        .await?
        .ok_or(DatabaseError::ManagedDatabaseNotFound(id))?;
        let database: String = row.try_get("name")?;
        let username: String = row.try_get("username")?;
        let password: String = row.try_get("password")?;
        let details: Value = row.try_get("connection_details")?;
        let host: HostConnectionDetails = serde_json::from_value(details)?;

        let mut options = PgConnectOptions::new()
            .host(&host.host)
            .port(host.port)
            .database(&database)
            .username(&username)
            .password(&password);
        options = options.application_name("sortsys-api");
        Ok(options.to_url_lossy().to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TenantConnectionDetails {
    #[serde(rename = "postgresDSN", alias = "postgresDsn")]
    postgres_dsn: Option<String>,
    postgres_database_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostConnectionDetails {
    host: String,
    #[serde(default = "default_pg_port")]
    port: u16,
}

const fn default_pg_port() -> u16 {
    5432
}

async fn ensure_master_schema(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(
        r#"
        CREATE TABLE IF NOT EXISTS __tenants (
          name VARCHAR(127) PRIMARY KEY CHECK (LOWER(name) = name AND name != '+all'),
          admin_hash TEXT NOT NULL,
          disabled BOOLEAN NOT NULL DEFAULT FALSE,
          contact_details JSONB NOT NULL,
          connection_details JSONB NOT NULL,
          locked_at TIMESTAMPTZ,
          deactivated_at TIMESTAMPTZ,
          deleted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          options JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS __jobs (
          id BIGSERIAL PRIMARY KEY,
          tenant_name VARCHAR(127) NOT NULL REFERENCES __tenants(name) ON DELETE CASCADE,
          type VARCHAR(127) NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::JSONB,
          state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'succeeded', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 20 CHECK (max_attempts > 0),
          available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          acquired_by_runner_id VARCHAR(255), acquired_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
          last_error TEXT, result JSONB, finished_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx___jobs_open ON __jobs (state, available_at, lease_expires_at, id);
        CREATE INDEX IF NOT EXISTS idx___jobs_runner ON __jobs (acquired_by_runner_id, state);
        CREATE INDEX IF NOT EXISTS idx___jobs_tenant ON __jobs (tenant_name, type, state);
        CREATE TABLE IF NOT EXISTS __delivery_note_scans (
          id BIGSERIAL PRIMARY KEY,
          tenant_name VARCHAR(127) NOT NULL REFERENCES __tenants(name) ON DELETE CASCADE,
          user_id BIGINT NOT NULL,
          job_id BIGINT UNIQUE REFERENCES __jobs(id) ON DELETE SET NULL,
          source_object_key TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          source_documents JSONB,
          state VARCHAR(20) NOT NULL DEFAULT 'queued'
            CHECK (state IN ('queued', 'ocr', 'matching', 'completed', 'failed')),
          result JSONB,
          error TEXT,
          processor_lease_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        );
        ALTER TABLE __delivery_note_scans
          ADD COLUMN IF NOT EXISTS source_documents JSONB;
        CREATE INDEX IF NOT EXISTS idx___delivery_note_scans_user_created
          ON __delivery_note_scans (tenant_name, user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS __postgres_hosts (
          id BIGSERIAL PRIMARY KEY, name VARCHAR(127) NOT NULL UNIQUE,
          connection_details JSONB NOT NULL, backup_details JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS __postgres_databases (
          id BIGSERIAL PRIMARY KEY, host_id BIGINT NOT NULL REFERENCES __postgres_hosts(id) ON DELETE RESTRICT,
          name VARCHAR(127) NOT NULL, username VARCHAR(127) NOT NULL, password TEXT NOT NULL,
          retention_daily INTEGER NOT NULL DEFAULT 7 CHECK (retention_daily >= 0),
          retention_weekly INTEGER NOT NULL DEFAULT 4 CHECK (retention_weekly >= 0),
          retention_monthly INTEGER NOT NULL DEFAULT 12 CHECK (retention_monthly >= 0),
          retention_yearly INTEGER NOT NULL DEFAULT 5 CHECK (retention_yearly >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (host_id, name), UNIQUE (host_id, username)
        );
        CREATE TABLE IF NOT EXISTS __postgres_database_backups (
          id BIGSERIAL PRIMARY KEY, database_id BIGINT NOT NULL REFERENCES __postgres_databases(id) ON DELETE CASCADE,
          kind VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'auto')),
          state VARCHAR(20) NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'uploaded', 'failed')),
          object_key TEXT, size_bytes BIGINT, error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx___postgres_databases_host ON __postgres_databases (host_id, name);
        CREATE INDEX IF NOT EXISTS idx___postgres_database_backups_db_created ON __postgres_database_backups (database_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS __llm_settings (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          provider VARCHAR(32) NOT NULL,
          model VARCHAR(255) NOT NULL,
          base_url TEXT,
          api_key_ciphertext TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS __llm_scan_settings (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          provider VARCHAR(32) NOT NULL,
          model VARCHAR(255) NOT NULL,
          base_url TEXT,
          api_key_ciphertext TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS __llm_usage (
          id BIGSERIAL PRIMARY KEY,
          tenant_name VARCHAR(127) NOT NULL REFERENCES __tenants(name) ON DELETE CASCADE,
          user_id BIGINT NOT NULL,
          chat_id BIGINT,
          provider VARCHAR(32) NOT NULL,
          model VARCHAR(255) NOT NULL,
          input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
          output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
          total_tokens BIGINT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
          status VARCHAR(16) NOT NULL CHECK (status IN ('succeeded', 'failed')),
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE __llm_usage
          ADD COLUMN IF NOT EXISTS purpose VARCHAR(32) NOT NULL DEFAULT 'chat';
        CREATE INDEX IF NOT EXISTS idx___llm_usage_tenant_created
          ON __llm_usage (tenant_name, created_at DESC);
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum DatabaseError {
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    InvalidTenantConfiguration(#[from] serde_json::Error),
    #[error("tenant {0} is not defined")]
    TenantNotFound(String),
    #[error("tenant {0} has been deactivated")]
    TenantDeactivated(String),
    #[error("tenant {0} has been locked")]
    TenantLocked(String),
    #[error("tenant {0} has been deleted")]
    TenantDeleted(String),
    #[error("tenant {0} has no PostgreSQL database configured")]
    TenantHasNoDatabase(String),
    #[error("invalid managed PostgreSQL database id {0}")]
    InvalidManagedDatabaseId(String),
    #[error("managed PostgreSQL database {0} does not exist")]
    ManagedDatabaseNotFound(i64),
}
