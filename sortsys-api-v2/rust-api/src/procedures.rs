//! Registration root for the complete native RPC procedure surface.

mod admin_backups;
mod admin_common;
mod admin_databases;
mod admin_errors;
mod admin_tenants;
mod admin_users;
mod auth_password;
mod client_scripts;
mod common;
mod contacts;
mod customers;
mod delivery_notes;
mod passkeys;
mod personalization;
mod products;
mod project_contacts;
mod project_costs;
mod project_daily_reports;
mod project_files;
mod project_schedule;
mod projects;
mod regie_reports;
mod remarks;
mod settings;
mod settings_logo;
mod tools;
mod users;
mod vacations;

use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::types::Json;
use ts_rs::TS;

use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let builder = admin_databases::register(builder, Arc::clone(&state));
    let builder = admin_backups::register(builder, Arc::clone(&state));
    let builder = admin_tenants::register(builder, Arc::clone(&state));
    let builder = admin_users::register(builder, Arc::clone(&state));
    let builder = admin_errors::register(builder, Arc::clone(&state));
    let report_state = Arc::clone(&state);
    let builder = builder.mutation(
        "errorReports.report",
        move |ctx: RequestContext, mut input: ErrorReportInput| {
            let state = Arc::clone(&report_state);
            async move {
                input.source = input.source.trim().to_owned();
                input.message = input.message.trim().to_owned();
                input.path = input.path.map(|value| value.trim().to_owned());
                validate_report(&input)?;
                let auth = state.auth.authenticate(&ctx.headers).await?;
                let pool = state
                    .tenants
                    .tenant_pool(&auth.tenant)
                    .await
                    .map_err(internal)?;
                let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
                let user_agent = ctx
                    .headers
                    .get("user-agent")
                    .and_then(|value| value.to_str().ok());
                sqlx::query(
                    "INSERT INTO client_error_reports \
                     (level, source, message, stack, path, component_stack, metadata, user_agent, created_by_user_id) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                )
                .bind(input.level.unwrap_or_default().as_str())
                .bind(input.source)
                .bind(input.message)
                .bind(nonempty(input.stack))
                .bind(nonempty(input.path))
                .bind(nonempty(input.component_stack))
                .bind(input.metadata.map(Json))
                .bind(user_agent)
                .bind(user_id)
                .execute(&pool)
                .await
                .map_err(internal)?;
                Ok(Success { success: true })
            }
        },
    );
    let builder = auth_password::register(builder, Arc::clone(&state));
    let builder = passkeys::register(builder, Arc::clone(&state));
    let builder = client_scripts::register(builder, Arc::clone(&state));
    let builder = contacts::register(builder, Arc::clone(&state));
    let builder = customers::register(builder, Arc::clone(&state));
    let builder = delivery_notes::register(builder, Arc::clone(&state));
    let builder = personalization::register(builder, Arc::clone(&state));
    let builder = products::register(builder, Arc::clone(&state));
    let builder = projects::register(builder, Arc::clone(&state));
    let builder = project_costs::register(builder, Arc::clone(&state));
    let builder = project_schedule::register(builder, Arc::clone(&state));
    let builder = project_files::register(builder, Arc::clone(&state));
    let builder = project_daily_reports::register(builder, Arc::clone(&state));
    let builder = project_contacts::register(builder, Arc::clone(&state));
    let builder = regie_reports::register(builder, Arc::clone(&state));
    let builder = settings::register(builder, Arc::clone(&state));
    let builder = settings_logo::register(builder, Arc::clone(&state));
    let builder = tools::register(builder, Arc::clone(&state));
    let builder = users::register(builder, Arc::clone(&state));
    let builder = vacations::register(builder, Arc::clone(&state));
    remarks::register(builder, state)
}

fn validate_report(input: &ErrorReportInput) -> Result<(), RpcError> {
    if input.source.is_empty() || input.source.len() > 128 {
        return Err(bad_input(
            "source must contain between 1 and 128 characters",
        ));
    }
    if input.message.is_empty() || input.message.len() > 4_000 {
        return Err(bad_input(
            "message must contain between 1 and 4000 characters",
        ));
    }
    if input
        .stack
        .as_deref()
        .is_some_and(|value| value.len() > 20_000)
        || input
            .component_stack
            .as_deref()
            .is_some_and(|value| value.len() > 20_000)
        || input
            .path
            .as_deref()
            .is_some_and(|value| value.len() > 1_024)
    {
        return Err(bad_input("error report field exceeds its maximum length"));
    }
    Ok(())
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn bad_input(message: &str) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ErrorReportInput {
    #[serde(default)]
    #[ts(optional)]
    level: Option<ErrorReportLevel>,
    source: String,
    message: String,
    #[ts(optional = nullable)]
    stack: Option<String>,
    #[ts(optional = nullable)]
    path: Option<String>,
    #[ts(optional = nullable)]
    component_stack: Option<String>,
    #[ts(optional = nullable)]
    metadata: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
enum ErrorReportLevel {
    #[default]
    Error,
    Warning,
}

impl ErrorReportLevel {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}
