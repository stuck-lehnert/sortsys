//! Managed PostgreSQL host and database administration routes.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::types::Json;
use ts_rs::TS;

use super::{
    admin_common::{admin_for, require_global},
    common::{bad_request, conflict, internal, not_found, trim_nullable, trim_required},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    managed_db::{self, HostBackup, HostConnection, ManagedDatabase, ManagedHost, Retention},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let host_list_state = Arc::clone(&state);
    builder = builder.query("admin.databases.hosts.list", move |context, _input: ()| {
        let state = Arc::clone(&host_list_state);

        async move {
            require_global_admin(&state, &context).await?;
            managed_db::list_hosts(&state).await
        }
    });

    let host_create_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.hosts.create",
        move |context, mut input: HostCreateInput| {
            let state = Arc::clone(&host_create_state);

            async move {
                require_global_admin(&state, &context).await?;
                input.normalize()?;
                create_host(&state, input).await
            }
        },
    );

    let host_update_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.hosts.update",
        move |context, mut input: HostUpdateInput| {
            let state = Arc::clone(&host_update_state);

            async move {
                require_global_admin(&state, &context).await?;
                input.normalize()?;
                update_host(&state, input).await
            }
        },
    );

    let host_delete_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.hosts.delete",
        move |context, input: HostKey| {
            let state = Arc::clone(&host_delete_state);

            async move {
                require_global_admin(&state, &context).await?;
                delete_host(&state, input).await
            }
        },
    );

    let database_list_state = Arc::clone(&state);
    builder = builder.query("admin.databases.list", move |context, _input: ()| {
        let state = Arc::clone(&database_list_state);

        async move {
            require_global_admin(&state, &context).await?;
            let databases = managed_db::list_databases(&state).await?;

            Ok(databases
                .into_iter()
                .map(DatabaseSummary::from)
                .collect::<Vec<_>>())
        }
    });

    let database_create_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.create",
        move |context, mut input: DatabaseCreateInput| {
            let state = Arc::clone(&database_create_state);

            async move {
                require_global_admin(&state, &context).await?;
                input.normalize()?;

                managed_db::create_database_on_host(
                    &state,
                    decimal_id(&input.host_id, "hostId")?,
                    &input.name,
                    input.username.as_deref(),
                    input.retention(),
                )
                .await
            }
        },
    );

    let retention_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.updateRetention",
        move |context, input: RetentionUpdateInput| {
            let state = Arc::clone(&retention_state);

            async move {
                require_global_admin(&state, &context).await?;
                update_retention(&state, input).await
            }
        },
    );

    builder.mutation(
        "admin.databases.rotateCredentials",
        move |context, input: DatabaseKey| {
            let state = Arc::clone(&state);

            async move {
                require_global_admin(&state, &context).await?;
                let database_id = decimal_id(&input.database_id, "databaseId")?;

                managed_db::rotate_credentials(&state, database_id).await
            }
        },
    )
}

async fn require_global_admin(state: &AppState, context: &RequestContext) -> RpcResult<()> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)
}

async fn create_host(state: &AppState, input: HostCreateInput) -> RpcResult<ManagedHost> {
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO __postgres_hosts (
            name,
            connection_details,
            backup_details
        )
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(input.name)
    .bind(Json(input.connection_details))
    .bind(Json(input.backup_details))
    .fetch_one(state.tenants.master())
    .await
    .map_err(map_write_error)?;

    managed_db::host(state, id).await
}

async fn update_host(state: &AppState, input: HostUpdateInput) -> RpcResult<ManagedHost> {
    let host_id = decimal_id(&input.host_id, "hostId")?;
    let current = managed_db::host(state, host_id).await?;
    let name = input.data.name.unwrap_or(current.name);
    let connection = input
        .data
        .connection_details
        .unwrap_or(current.connection_details);
    let backup = input.data.backup_details.unwrap_or(current.backup_details);

    sqlx::query(
        r#"
        UPDATE __postgres_hosts
        SET
            name = $2,
            connection_details = $3,
            backup_details = $4,
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(host_id)
    .bind(name)
    .bind(Json(connection))
    .bind(Json(backup))
    .execute(state.tenants.master())
    .await
    .map_err(map_write_error)?;

    managed_db::host(state, host_id).await
}

async fn delete_host(state: &AppState, input: HostKey) -> RpcResult<Success> {
    let host_id = decimal_id(&input.host_id, "hostId")?;
    let database_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM __postgres_databases WHERE host_id = $1",
    )
    .bind(host_id)
    .fetch_one(state.tenants.master())
    .await
    .map_err(internal)?;

    if database_count > 0 {
        return Err(conflict());
    }

    let result = sqlx::query("DELETE FROM __postgres_hosts WHERE id = $1")
        .bind(host_id)
        .execute(state.tenants.master())
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn update_retention(
    state: &AppState,
    input: RetentionUpdateInput,
) -> RpcResult<RetentionOutput> {
    input.data.validate()?;
    let database_id = decimal_id(&input.database_id, "databaseId")?;

    let row = sqlx::query_as::<_, RetentionRow>(
        r#"
        UPDATE __postgres_databases
        SET
            retention_daily = $2,
            retention_weekly = $3,
            retention_monthly = $4,
            retention_yearly = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING
            id,
            retention_daily,
            retention_weekly,
            retention_monthly,
            retention_yearly
        "#,
    )
    .bind(database_id)
    .bind(input.data.retention_daily)
    .bind(input.data.retention_weekly)
    .bind(input.data.retention_monthly)
    .bind(input.data.retention_yearly)
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    Ok(RetentionOutput::from(row))
}

fn decimal_id(value: &str, field: &str) -> RpcResult<i64> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| bad_request(format!("invalid {field}")))
}

fn normalize_host_name(value: &mut String) -> RpcResult<()> {
    *value = value.trim().to_lowercase();
    let valid = !value.is_empty()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'_'
                || (index > 0 && matches!(byte, b'-' | b'.'))
        });

    if valid {
        Ok(())
    } else {
        Err(bad_request("invalid host name"))
    }
}

fn normalize_connection(connection: &mut HostConnection) -> RpcResult<()> {
    trim_required(&mut connection.host, "host", 255)?;
    trim_required(&mut connection.admin_database, "adminDatabase", 127)?;
    trim_required(&mut connection.admin_username, "adminUsername", 127)?;
    trim_required(&mut connection.admin_password, "adminPassword", 4_096)?;

    if connection.port == 0 {
        return Err(bad_request("port must be between 1 and 65535"));
    }

    Ok(())
}

fn normalize_backup(backup: &mut HostBackup) -> RpcResult<()> {
    for (value, field, max) in [
        (&mut backup.bucket, "bucket", 255),
        (&mut backup.region, "region", 127),
        (&mut backup.endpoint, "endpoint", 2_048),
        (&mut backup.public_base_url, "publicBaseUrl", 2_048),
        (&mut backup.access_key_id, "accessKeyId", 255),
        (&mut backup.secret_access_key, "secretAccessKey", 1_024),
        (&mut backup.session_token, "sessionToken", 4_096),
        (&mut backup.key_prefix, "keyPrefix", 255),
    ] {
        trim_nullable(value, field, max)?;
    }

    for value in [
        backup.endpoint.as_deref(),
        backup.public_base_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        url::Url::parse(value).map_err(|_| bad_request("invalid backup URL"))?;
    }

    if backup.enabled {
        for (field, value) in [
            ("bucket", backup.bucket.as_deref()),
            ("region", backup.region.as_deref()),
            ("accessKeyId", backup.access_key_id.as_deref()),
            ("secretAccessKey", backup.secret_access_key.as_deref()),
        ] {
            if value.is_none() {
                return Err(bad_request(format!(
                    "{field} is required when backup is enabled"
                )));
            }
        }
    }

    Ok(())
}

fn map_write_error(error: sqlx::Error) -> crate::error::RpcError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        conflict()
    } else {
        internal(error)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostCreateInput {
    name: String,
    connection_details: HostConnection,

    #[serde(default)]
    backup_details: HostBackup,
}

impl HostCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        normalize_host_name(&mut self.name)?;
        normalize_connection(&mut self.connection_details)?;
        normalize_backup(&mut self.backup_details)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostUpdateInput {
    host_id: String,
    data: HostPatch,
}

impl HostUpdateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        decimal_id(&self.host_id, "hostId")?;

        if let Some(name) = &mut self.data.name {
            normalize_host_name(name)?;
        }
        if let Some(connection) = &mut self.data.connection_details {
            normalize_connection(connection)?;
        }
        if let Some(backup) = &mut self.data.backup_details {
            normalize_backup(backup)?;
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostPatch {
    #[serde(default)]
    #[ts(optional = nullable)]
    name: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    connection_details: Option<HostConnection>,

    #[serde(default)]
    #[ts(optional = nullable)]
    backup_details: Option<HostBackup>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostKey {
    host_id: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseCreateInput {
    host_id: String,
    name: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    username: Option<String>,

    #[serde(default = "default_daily")]
    retention_daily: i32,

    #[serde(default = "default_weekly")]
    retention_weekly: i32,

    #[serde(default = "default_monthly")]
    retention_monthly: i32,

    #[serde(default = "default_yearly")]
    retention_yearly: i32,
}

impl DatabaseCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        decimal_id(&self.host_id, "hostId")?;
        self.name = self.name.trim().to_lowercase();
        self.username = self
            .username
            .take()
            .map(|username| username.trim().to_lowercase())
            .filter(|username| !username.is_empty());

        self.retention().validate()
    }

    fn retention(&self) -> Retention {
        Retention {
            daily: self.retention_daily,
            weekly: self.retention_weekly,
            monthly: self.retention_monthly,
            yearly: self.retention_yearly,
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseKey {
    database_id: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetentionUpdateInput {
    database_id: String,
    data: RetentionInput,
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetentionInput {
    retention_daily: i32,
    retention_weekly: i32,
    retention_monthly: i32,
    retention_yearly: i32,
}

impl RetentionInput {
    fn validate(self) -> RpcResult<()> {
        Retention {
            daily: self.retention_daily,
            weekly: self.retention_weekly,
            monthly: self.retention_monthly,
            yearly: self.retention_yearly,
        }
        .validate()
    }
}

trait ValidateRetention {
    fn validate(self) -> RpcResult<()>;
}

impl ValidateRetention for Retention {
    fn validate(self) -> RpcResult<()> {
        if !(0..=3_650).contains(&self.daily)
            || !(0..=520).contains(&self.weekly)
            || !(0..=240).contains(&self.monthly)
            || !(0..=100).contains(&self.yearly)
        {
            Err(bad_request("invalid retention value"))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DatabaseSummary {
    id: String,
    host_id: String,
    host_name: String,
    name: String,
    username: String,
    retention_daily: i32,
    retention_weekly: i32,
    retention_monthly: i32,
    retention_yearly: i32,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    updated_at: DateTime<Utc>,
}

impl From<ManagedDatabase> for DatabaseSummary {
    fn from(database: ManagedDatabase) -> Self {
        Self {
            id: database.id,
            host_id: database.host_id,
            host_name: database.host_name,
            name: database.name,
            username: database.username,
            retention_daily: database.retention_daily,
            retention_weekly: database.retention_weekly,
            retention_monthly: database.retention_monthly,
            retention_yearly: database.retention_yearly,
            created_at: database.created_at,
            updated_at: database.updated_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct RetentionRow {
    id: i64,
    retention_daily: i32,
    retention_weekly: i32,
    retention_monthly: i32,
    retention_yearly: i32,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RetentionOutput {
    id: String,
    retention_daily: i32,
    retention_weekly: i32,
    retention_monthly: i32,
    retention_yearly: i32,
}

impl From<RetentionRow> for RetentionOutput {
    fn from(row: RetentionRow) -> Self {
        Self {
            id: row.id.to_string(),
            retention_daily: row.retention_daily,
            retention_weekly: row.retention_weekly,
            retention_monthly: row.retention_monthly,
            retention_yearly: row.retention_yearly,
        }
    }
}

const fn default_daily() -> i32 {
    7
}

const fn default_weekly() -> i32 {
    4
}

const fn default_monthly() -> i32 {
    12
}

const fn default_yearly() -> i32 {
    5
}

#[cfg(test)]
mod tests {
    use super::{RetentionInput, normalize_host_name};

    #[test]
    fn validates_host_names_and_retention_bounds() {
        let mut name = "  PG-Primary  ".to_owned();
        normalize_host_name(&mut name).expect("valid name");
        assert_eq!(name, "pg-primary");

        let invalid = RetentionInput {
            retention_daily: 3_651,
            retention_weekly: 4,
            retention_monthly: 12,
            retention_yearly: 5,
        };
        assert!(invalid.validate().is_err());
    }
}
