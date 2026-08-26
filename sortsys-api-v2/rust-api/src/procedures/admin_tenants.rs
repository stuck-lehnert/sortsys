//! Global and tenant-scoped administrator login and tenant lifecycle.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use email_address::EmailAddress;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::Json;
use tokio::time::sleep;
use ts_rs::TS;

use super::{
    admin_common::{
        admin_for, ensure_not_locked, ensure_tenant_access, generated_password, password_hash,
        require_global, tenant,
    },
    common::{bad_request, forbidden, internal},
};
use crate::{
    AppState,
    api::Success,
    database::Tenant,
    error::{ErrorCode, RpcError, RpcResult},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const MIN_LOGIN_TIME: Duration = Duration::from_secs(3);

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let login_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.login",
        move |_context, mut input: AdminLoginInput| {
            let state = Arc::clone(&login_state);

            async move {
                input.password = input.password.trim().to_owned();
                input.tenant = input.tenant.map(|tenant| tenant.trim().to_lowercase());

                login(&state, input).await
            }
        },
    );

    let list_state = Arc::clone(&state);
    builder = builder.query("admin.tenants.list", move |context, _input: ()| {
        let state = Arc::clone(&list_state);

        async move { list(&state, &context).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("admin.tenants.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create(&state, &context, input).await }
    });

    let get_state = Arc::clone(&state);
    builder = builder.query(
        "admin.tenants.get",
        move |context, input: TenantNameInput| {
            let state = Arc::clone(&get_state);

            async move { get(&state, &context, input).await }
        },
    );

    let update_state = Arc::clone(&state);
    builder = builder.mutation_json("admin.tenants.update", move |context, input| {
        let state = Arc::clone(&update_state);

        async move { update(&state, &context, input).await }
    });

    for (path, action) in [
        ("admin.tenants.activate", TenantAction::Activate),
        ("admin.tenants.deactivate", TenantAction::Deactivate),
        ("admin.tenants.delete", TenantAction::Delete),
        ("admin.tenants.deleteForever", TenantAction::DeleteForever),
        ("admin.tenants.lock", TenantAction::Lock),
        ("admin.tenants.unlock", TenantAction::Unlock),
        ("admin.tenants.undelete", TenantAction::Undelete),
    ] {
        let action_state = Arc::clone(&state);
        builder = builder.mutation(path, move |context, input: TenantNameInput| {
            let state = Arc::clone(&action_state);

            async move { apply_action(&state, &context, input, action).await }
        });
    }

    builder
}

async fn login(state: &AppState, input: AdminLoginInput) -> RpcResult<AdminLoginOutput> {
    let started = Instant::now();
    let token = state
        .auth
        .login_admin(&input.password, input.tenant.as_deref())
        .await;

    sleep(MIN_LOGIN_TIME.saturating_sub(started.elapsed())).await;

    token
        .map(|token| AdminLoginOutput { token })
        .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "Login failed").with_http_code(401))
}

async fn list(state: &AppState, context: &RequestContext) -> RpcResult<Vec<TenantSummary>> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    let rows = sqlx::query_as::<_, Tenant>("SELECT * FROM __tenants ORDER BY name")
        .fetch_all(state.tenants.master())
        .await
        .map_err(internal)?;

    Ok(rows.into_iter().map(TenantSummary::from).collect())
}

async fn get(
    state: &AppState,
    context: &RequestContext,
    input: TenantNameInput,
) -> RpcResult<TenantSummary> {
    let admin_for = admin_for(state, context).await?;
    let tenant_name = normalize_tenant_name(&input.name)?;

    ensure_tenant_access(&admin_for, &tenant_name)?;

    Ok(TenantSummary::from(tenant(state, &tenant_name).await?))
}

async fn create(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    let mut input = input
        .as_object()
        .cloned()
        .ok_or_else(|| bad_request("object input required"))?;
    let tenant_name = normalize_tenant_name(
        input
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_request("missing name"))?,
    )?;
    let contact_details = normalize_contact_details(
        input
            .remove("contact_details")
            .ok_or_else(|| bad_request("missing contact_details"))?,
    )?;
    let connection_details = normalize_connection_details(
        input
            .remove("connection_details")
            .unwrap_or_else(|| json!({})),
    )?;
    let options = normalize_options(input.remove("options").unwrap_or_else(default_options))?;

    if input.keys().any(|key| key != "name") {
        return Err(bad_request("unknown tenant property"));
    }

    let admin_password = generated_password(72)?;
    let admin_hash = password_hash(&admin_password).await?;

    sqlx::query(
        r#"
        INSERT INTO __tenants (
            name,
            admin_hash,
            disabled,
            contact_details,
            connection_details,
            options
        )
        VALUES ($1, $2, FALSE, $3, $4, $5)
        "#,
    )
    .bind(tenant_name)
    .bind(admin_hash)
    .bind(Json(contact_details))
    .bind(Json(connection_details))
    .bind(Json(options))
    .execute(state.tenants.master())
    .await
    .map_err(map_insert_error)?;

    Ok(json!({ "adminPassword": admin_password }))
}

async fn update(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let admin_for = admin_for(state, context).await?;
    let input = input
        .as_object()
        .ok_or_else(|| bad_request("object input required"))?;
    let tenant_name = normalize_tenant_name(
        input
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_request("missing name"))?,
    )?;

    ensure_tenant_access(&admin_for, &tenant_name)?;
    let current = tenant(state, &tenant_name).await?;
    ensure_not_locked(&admin_for, &current)?;

    let data = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;
    if data.is_empty() {
        return Err(bad_request("empty update"));
    }
    if data.keys().any(|key| {
        !matches!(
            key.as_str(),
            "contact_details" | "connection_details" | "options"
        )
    }) {
        return Err(bad_request("unknown tenant update property"));
    }

    let contact_details = data
        .get("contact_details")
        .cloned()
        .map(normalize_contact_details)
        .transpose()?;
    let connection_details = data
        .get("connection_details")
        .cloned()
        .map(normalize_connection_details)
        .transpose()?;
    let options = data
        .get("options")
        .cloned()
        .map(normalize_options)
        .transpose()?;

    sqlx::query(
        r#"
        UPDATE __tenants
        SET
            contact_details = COALESCE($2, contact_details),
            connection_details = COALESCE($3, connection_details),
            options = COALESCE($4, options)
        WHERE name = $1
        "#,
    )
    .bind(&tenant_name)
    .bind(contact_details.map(Json))
    .bind(connection_details.map(Json))
    .bind(options.map(Json))
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(json!({ "success": true }))
}

async fn apply_action(
    state: &AppState,
    context: &RequestContext,
    input: TenantNameInput,
    action: TenantAction,
) -> RpcResult<Success> {
    let admin_for = admin_for(state, context).await?;
    let tenant_name = normalize_tenant_name(&input.name)?;

    ensure_tenant_access(&admin_for, &tenant_name)?;
    let current = tenant(state, &tenant_name).await?;

    if action.requires_global() {
        require_global(&admin_for)?;
    } else if !matches!(action, TenantAction::Delete) {
        ensure_not_locked(&admin_for, &current)?;
    }

    if matches!(action, TenantAction::Unlock)
        && current
            .deleted_at
            .is_some_and(|deleted| deleted <= chrono::Utc::now())
    {
        return Err(forbidden());
    }

    let statement = match action {
        TenantAction::Activate => "UPDATE __tenants SET deactivated_at = NULL WHERE name = $1",
        TenantAction::Deactivate => {
            "UPDATE __tenants SET deactivated_at = NOW() WHERE name = $1 AND deactivated_at IS NULL"
        }
        TenantAction::Delete => {
            "UPDATE __tenants SET deleted_at = NOW(), deactivated_at = NOW() WHERE name = $1 AND deleted_at IS NULL"
        }
        TenantAction::DeleteForever => "DELETE FROM __tenants WHERE name = $1",
        TenantAction::Lock => {
            "UPDATE __tenants SET locked_at = NOW(), deactivated_at = NOW() WHERE name = $1 AND locked_at IS NULL"
        }
        TenantAction::Unlock => "UPDATE __tenants SET locked_at = NULL WHERE name = $1",
        TenantAction::Undelete => "UPDATE __tenants SET deleted_at = NULL WHERE name = $1",
    };

    sqlx::query(statement)
        .bind(&tenant_name)
        .execute(state.tenants.master())
        .await
        .map_err(internal)?;

    Ok(Success { success: true })
}

fn normalize_tenant_name(name: &str) -> RpcResult<String> {
    let name = name.trim().to_lowercase();
    let pattern =
        Regex::new(r"^[a-z0-9_]+(?:[.\-][a-z0-9_]+)*$").expect("static tenant-name regex");

    if name == "+all" || !pattern.is_match(&name) {
        Err(bad_request("invalid tenant name"))
    } else {
        Ok(name)
    }
}

fn normalize_contact_details(value: Value) -> RpcResult<Value> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| bad_request("contact_details must be an object"))?;
    let email = object
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|email| EmailAddress::is_valid(email))
        .ok_or_else(|| bad_request("invalid contact email"))?;

    object.insert("email".to_owned(), Value::String(email));

    Ok(Value::Object(object))
}

fn normalize_connection_details(value: Value) -> RpcResult<Value> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| bad_request("connection_details must be an object"))?;

    if let Some(storage) = object.get_mut("objectStorage")
        && !storage.is_null()
    {
        let storage = storage
            .as_object_mut()
            .ok_or_else(|| bad_request("objectStorage must be an object"))?;

        storage.entry("enabled").or_insert(Value::Bool(false));
        storage
            .entry("provider")
            .or_insert(Value::String("s3".to_owned()));
        storage
            .entry("forcePathStyle")
            .or_insert(Value::Bool(false));
        storage.entry("uploadUrlTtlSec").or_insert(json!(15 * 60));
        storage.entry("downloadUrlTtlSec").or_insert(json!(30 * 60));

        if storage.get("enabled").and_then(Value::as_bool) == Some(true) {
            for field in ["bucket", "region", "accessKeyId", "secretAccessKey"] {
                let present = storage
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty());

                if !present {
                    return Err(bad_request(format!(
                        "{field} is required when object storage is enabled"
                    )));
                }
            }
        }
    }

    Ok(Value::Object(object))
}

fn normalize_options(value: Value) -> RpcResult<Value> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(bad_request("options must be an object"))
    }
}

fn default_options() -> Value {
    json!({
        "sso": {
            "ms-entra-id": {
                "enabled": false,
                "importUserUsername": true,
                "importUserName": true,
                "importUserEmail": true,
            }
        }
    })
}

fn map_insert_error(error: sqlx::Error) -> RpcError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        RpcError::new(ErrorCode::Conflict, "Conflict").with_http_code(409)
    } else {
        internal(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TenantAction {
    Activate,
    Deactivate,
    Delete,
    DeleteForever,
    Lock,
    Unlock,
    Undelete,
}

impl TenantAction {
    fn requires_global(self) -> bool {
        matches!(
            self,
            Self::DeleteForever | Self::Lock | Self::Unlock | Self::Undelete
        )
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct AdminLoginInput {
    password: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    tenant: Option<String>,
}

#[derive(Debug, Serialize, TS)]
struct AdminLoginOutput {
    token: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct TenantNameInput {
    name: String,
}

#[derive(Debug, Serialize, TS)]
struct TenantSummary {
    name: String,
    locked_at: Option<chrono::DateTime<chrono::Utc>>,
    deleted_at: Option<chrono::DateTime<chrono::Utc>>,
    deactivated_at: Option<chrono::DateTime<chrono::Utc>>,
    connection_details: Value,
    contact_details: Value,
    options: Value,
}

impl From<Tenant> for TenantSummary {
    fn from(tenant: Tenant) -> Self {
        Self {
            name: tenant.name,
            locked_at: tenant.locked_at,
            deleted_at: tenant.deleted_at,
            deactivated_at: tenant.deactivated_at,
            connection_details: tenant.connection_details,
            contact_details: tenant.contact_details,
            options: tenant.options,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{default_options, normalize_tenant_name};

    #[test]
    fn normalizes_and_validates_tenant_names() {
        assert_eq!(
            normalize_tenant_name("  Acme-Test  ").expect("valid name"),
            "acme-test"
        );
        assert!(normalize_tenant_name("+all").is_err());
        assert!(normalize_tenant_name("bad name").is_err());
        assert!(default_options().is_object());
    }
}
