//! Cross-tenant client error-report inspection.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, types::Json};

use super::{
    admin_common::{admin_for, ensure_tenant_access, tenant, tenant_pool_for_admin},
    common::{bad_request, internal},
};
use crate::{
    AppState,
    database::Tenant,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.query_json("admin.errors.list", move |context, input| {
        let state = Arc::clone(&state);

        async move {
            let input = ErrorListInput::parse(input)?;
            let reports = list(&state, &context, input).await?;

            serde_json::to_value(reports).map_err(internal)
        }
    })
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    input: ErrorListInput,
) -> RpcResult<Vec<AdminErrorReport>> {
    let admin_for = admin_for(state, context).await?;

    let tenants = if let Some(target) = &input.tenant {
        ensure_tenant_access(&admin_for, target)?;
        vec![tenant(state, target).await?]
    } else if admin_for == "+all" {
        sqlx::query_as::<_, Tenant>("SELECT * FROM __tenants ORDER BY name")
            .fetch_all(state.tenants.master())
            .await
            .map_err(internal)?
    } else {
        vec![tenant(state, &admin_for).await?]
    };

    let mut reports = Vec::new();

    for tenant in tenants
        .into_iter()
        .filter(|tenant| tenant.deleted_at.is_none())
    {
        // A broken tenant database must not prevent a global administrator
        // from inspecting healthy tenants.
        let Ok(pool) = tenant_pool_for_admin(state, &tenant.name, &admin_for).await else {
            continue;
        };
        let Ok(rows) = sqlx::query_as::<_, ErrorReportRow>(
            r#"
            SELECT
                report.id,
                report.level,
                report.source,
                report.message,
                report.stack,
                report.path,
                report.component_stack,
                report.metadata,
                report.user_agent,
                report.created_by_user_id,
                user_account.username,
                report.created_at
            FROM client_error_reports AS report
            LEFT JOIN users AS user_account
                ON user_account.id = report.created_by_user_id
            ORDER BY report.created_at DESC
            LIMIT $1
            "#,
        )
        .bind(input.limit)
        .fetch_all(&pool)
        .await
        else {
            continue;
        };

        reports.extend(rows.into_iter().map(|row| AdminErrorReport {
            tenant: tenant.name.clone(),
            id: Id(row.id),
            level: row.level,
            source: row.source,
            message: row.message,
            stack: row.stack,
            path: row.path,
            component_stack: row.component_stack,
            metadata: row.metadata.map(|metadata| metadata.0),
            user_agent: row.user_agent,
            created_by_user_id: row.created_by_user_id.map(Id),
            username: row.username,
            created_at: row.created_at,
        }));
    }

    reports.sort_by_key(|report| std::cmp::Reverse(report.created_at));
    reports.truncate(input.limit as usize);

    Ok(reports)
}

struct ErrorListInput {
    tenant: Option<String>,
    limit: i64,
}

impl ErrorListInput {
    fn parse(value: Value) -> RpcResult<Self> {
        if value.is_null() {
            return Ok(Self {
                tenant: None,
                limit: 100,
            });
        }

        let input = value
            .as_object()
            .ok_or_else(|| bad_request("object input required"))?;
        let tenant = input
            .get("tenant")
            .and_then(Value::as_str)
            .map(|tenant| tenant.trim().to_lowercase())
            .filter(|tenant| !tenant.is_empty());
        let limit = input.get("limit").and_then(Value::as_i64).unwrap_or(100);

        if !(1..=500).contains(&limit) {
            return Err(bad_request("limit must be between 1 and 500"));
        }

        Ok(Self { tenant, limit })
    }
}

#[derive(FromRow)]
struct ErrorReportRow {
    id: i64,
    level: String,
    source: String,
    message: String,
    stack: Option<String>,
    path: Option<String>,
    component_stack: Option<String>,
    metadata: Option<Json<Value>>,
    user_agent: Option<String>,
    created_by_user_id: Option<i64>,
    username: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminErrorReport {
    tenant: String,
    id: Id,
    level: String,
    source: String,
    message: String,
    stack: Option<String>,
    path: Option<String>,
    component_stack: Option<String>,
    metadata: Option<Value>,
    user_agent: Option<String>,
    created_by_user_id: Option<Id>,
    username: Option<String>,
    created_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::ErrorListInput;

    #[test]
    fn defaults_and_bounds_error_report_limits() {
        let defaults = ErrorListInput::parse(serde_json::Value::Null).expect("default input");
        assert_eq!(defaults.limit, 100);

        assert!(ErrorListInput::parse(serde_json::json!({ "limit": 501 })).is_err());
    }
}
