//! Managed PostgreSQL backup, restore, upload, download, and fork routes.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;
use ts_rs::TS;

use super::{
    admin_common::{admin_for, require_global},
    common::{bad_request, trim_required},
};
use crate::{
    AppState,
    error::RpcResult,
    managed_db::{self, ForkInput},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query(
        "admin.databases.backups.list",
        move |context, input: BackupListInput| {
            let state = Arc::clone(&list_state);

            async move {
                require_global_admin(&state, &context).await?;
                let database_id = decimal_id(&input.database_id, "databaseId")?;

                managed_db::list_backups(&state, database_id, input.include_failed).await
            }
        },
    );

    let create_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.backups.createNow",
        move |context, input: BackupCreateInput| {
            let state = Arc::clone(&create_state);

            async move {
                require_global_admin(&state, &context).await?;
                let database_id = decimal_id(&input.database_id, "databaseId")?;

                managed_db::create_backup(&state, database_id, &input.kind).await
            }
        },
    );

    let upload_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.backups.upload",
        move |context, mut input: BackupUploadInput| {
            let state = Arc::clone(&upload_state);

            async move {
                require_global_admin(&state, &context).await?;
                input.normalize()?;
                let database_id = decimal_id(&input.database_id, "databaseId")?;

                managed_db::upload_backup(&state, database_id, &input.file_name, &input.file_base64)
                    .await
            }
        },
    );

    let download_state = Arc::clone(&state);
    builder = builder.query_json(
        "admin.databases.backups.downloadUrl",
        move |context, input| {
            let state = Arc::clone(&download_state);

            async move {
                require_global_admin(&state, &context).await?;
                let input: BackupDownloadInput =
                    serde_json::from_value(input).map_err(|error| {
                        bad_request(format!("invalid backup download input: {error}"))
                    })?;
                input.validate()?;
                let backup_id = decimal_id(&input.backup_id, "backupId")?;
                let (backup, download_url) =
                    managed_db::download_url(&state, backup_id, input.expires_in_sec).await?;

                Ok(json!({
                    "backup": backup,
                    "downloadUrl": download_url,
                }))
            }
        },
    );

    let restore_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.databases.backups.restore",
        move |context, input: BackupRestoreInput| {
            let state = Arc::clone(&restore_state);

            async move {
                require_global_admin(&state, &context).await?;
                let backup_id = decimal_id(&input.backup_id, "backupId")?;
                let target_id = input
                    .target_database_id
                    .as_deref()
                    .map(|id| decimal_id(id, "targetDatabaseId"))
                    .transpose()?;

                managed_db::restore_backup(&state, backup_id, target_id).await
            }
        },
    );

    builder.mutation(
        "admin.databases.forkFromBackup",
        move |context, mut input: ForkRouteInput| {
            let state = Arc::clone(&state);

            async move {
                require_global_admin(&state, &context).await?;
                input.normalize()?;

                managed_db::fork_from_backup(
                    &state,
                    ForkInput {
                        backup_id: decimal_id(&input.backup_id, "backupId")?,
                        host_id: input
                            .host_id
                            .as_deref()
                            .map(|id| decimal_id(id, "hostId"))
                            .transpose()?,
                        name: input.name,
                        username: input.username,
                        retention_daily: input.retention_daily,
                        retention_weekly: input.retention_weekly,
                        retention_monthly: input.retention_monthly,
                        retention_yearly: input.retention_yearly,
                    },
                )
                .await
            }
        },
    )
}

async fn require_global_admin(state: &AppState, context: &RequestContext) -> RpcResult<()> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)
}

fn decimal_id(value: &str, field: &str) -> RpcResult<i64> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| bad_request(format!("invalid {field}")))
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupListInput {
    database_id: String,

    #[serde(default = "default_true")]
    include_failed: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupCreateInput {
    database_id: String,

    #[serde(default = "default_kind")]
    kind: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupUploadInput {
    database_id: String,
    file_name: String,
    file_base64: String,
}

impl BackupUploadInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.file_name, "fileName", 255)?;
        trim_required(&mut self.file_base64, "fileBase64", usize::MAX)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupDownloadInput {
    backup_id: String,

    #[serde(default = "default_expiry")]
    expires_in_sec: u64,
}

impl BackupDownloadInput {
    fn validate(&self) -> RpcResult<()> {
        if (60..=24 * 60 * 60).contains(&self.expires_in_sec) {
            Ok(())
        } else {
            Err(bad_request("expiresInSec must be between 60 and 86400"))
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupRestoreInput {
    backup_id: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    target_database_id: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkRouteInput {
    backup_id: String,
    name: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    host_id: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    username: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    retention_daily: Option<i32>,

    #[serde(default)]
    #[ts(optional = nullable)]
    retention_weekly: Option<i32>,

    #[serde(default)]
    #[ts(optional = nullable)]
    retention_monthly: Option<i32>,

    #[serde(default)]
    #[ts(optional = nullable)]
    retention_yearly: Option<i32>,
}

impl ForkRouteInput {
    fn normalize(&mut self) -> RpcResult<()> {
        self.name = self.name.trim().to_lowercase();
        self.username = self
            .username
            .take()
            .map(|username| username.trim().to_lowercase())
            .filter(|username| !username.is_empty());

        for (value, max, field) in [
            (self.retention_daily, 3_650, "retentionDaily"),
            (self.retention_weekly, 520, "retentionWeekly"),
            (self.retention_monthly, 240, "retentionMonthly"),
            (self.retention_yearly, 100, "retentionYearly"),
        ] {
            if value.is_some_and(|value| !(0..=max).contains(&value)) {
                return Err(bad_request(format!("invalid {field}")));
            }
        }

        Ok(())
    }
}

const fn default_true() -> bool {
    true
}

fn default_kind() -> String {
    "manual".to_owned()
}

const fn default_expiry() -> u64 {
    15 * 60
}

#[cfg(test)]
mod tests {
    use super::{BackupDownloadInput, ForkRouteInput};

    #[test]
    fn validates_backup_expiry_and_fork_retention() {
        assert!(
            BackupDownloadInput {
                backup_id: "1".to_owned(),
                expires_in_sec: 59,
            }
            .validate()
            .is_err()
        );

        let mut fork = ForkRouteInput {
            backup_id: "1".to_owned(),
            name: "copy".to_owned(),
            host_id: None,
            username: None,
            retention_daily: Some(3_651),
            retention_weekly: None,
            retention_monthly: None,
            retention_yearly: None,
        };
        assert!(fork.normalize().is_err());
    }
}
