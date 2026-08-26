//! Tenant-provided client script lifecycle procedures.
//!
//! Script code is returned only by detail/create/update operations. List
//! responses deliberately use the smaller summary projection.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::{FromRow, Postgres, QueryBuilder};
use ts_rs::TS;

use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const SCRIPT_CODE_MAX: usize = 200_000;
const SCRIPT_LIST_LIMIT: i64 = 200;
const SUMMARY_COLUMNS: &str = "id, name, description, enabled, \
    created_by_user_id, modified_by_user_id, \
    created_at, modified_at";
const DETAIL_COLUMNS: &str = "id, name, description, code, enabled, \
    created_by_user_id, modified_by_user_id, \
    created_at, modified_at";

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let get_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let update_state = Arc::clone(&state);
    let delete_state = Arc::clone(&state);

    builder
        .query("clientScripts.list", move |context, input| {
            let state = Arc::clone(&list_state);

            async move { list(&state, &context, input).await }
        })
        .query("clientScripts.get", move |context, input| {
            let state = Arc::clone(&get_state);

            async move { get(&state, &context, input).await }
        })
        .mutation("clientScripts.create", move |context, input| {
            let state = Arc::clone(&create_state);

            async move { create(&state, &context, input).await }
        })
        .mutation("clientScripts.update", move |context, input| {
            let state = Arc::clone(&update_state);

            async move { update(&state, &context, input).await }
        })
        .mutation("clientScripts.delete", move |context, input| {
            let state = Arc::clone(&delete_state);

            async move { delete(&state, &context, input).await }
        })
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    input: Option<ListInput>,
) -> RpcResult<Vec<ScriptSummary>> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require(&auth, "view:clientScripts")?;

    let input = input.unwrap_or_default();
    input.validate()?;

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let mut query =
        QueryBuilder::<Postgres>::new(format!("SELECT {SUMMARY_COLUMNS} FROM client_scripts"));
    let mut has_where_clause = false;

    if !input.include_disabled.unwrap_or(true) {
        query.push(" WHERE enabled = TRUE");
        has_where_clause = true;
    }

    if let Some(search) = input.search.filter(|value| !value.is_empty()) {
        query.push(if has_where_clause { " AND " } else { " WHERE " });
        query
            .push("_search @@ create_query(")
            .push_bind(search)
            .push(")");
    }

    query
        .push(" ORDER BY name LIMIT ")
        .push_bind(input.limit.unwrap_or(SCRIPT_LIST_LIMIT));

    query
        .build_query_as::<ScriptSummary>()
        .fetch_all(&pool)
        .await
        .map_err(internal)
}

async fn get(
    state: &AppState,
    context: &RequestContext,
    input: IdInput,
) -> RpcResult<Option<ScriptDetail>> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require(&auth, "view:clientScripts")?;

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    sqlx::query_as::<_, ScriptDetail>(&format!(
        "SELECT {DETAIL_COLUMNS} FROM client_scripts WHERE id = $1"
    ))
    .bind(input.id.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)
}

async fn create(
    state: &AppState,
    context: &RequestContext,
    mut input: ScriptInput,
) -> RpcResult<ScriptDetail> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require(&auth, "manage:clientScripts")?;

    input.normalize_and_validate()?;

    let user_id = parse_database_id(&auth.user.id)?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    sqlx::query_as::<_, ScriptDetail>(&format!(
        "INSERT INTO client_scripts \
         (name, description, code, enabled, created_by_user_id, modified_by_user_id) \
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING {DETAIL_COLUMNS}"
    ))
    .bind(input.name)
    .bind(input.description.filter(|value| !value.is_empty()))
    .bind(input.code)
    .bind(input.enabled.unwrap_or(true))
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)
}

async fn update(
    state: &AppState,
    context: &RequestContext,
    mut input: UpdateInput,
) -> RpcResult<Option<ScriptDetail>> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require(&auth, "manage:clientScripts")?;

    input.data.normalize_and_validate()?;
    if input.data.is_empty() {
        return Err(bad_input("No changes supplied"));
    }

    let user_id = parse_database_id(&auth.user.id)?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let mut query = QueryBuilder::<Postgres>::new("UPDATE client_scripts SET ");

    {
        let mut fields = query.separated(", ");

        if let Some(value) = input.data.name {
            fields.push("name = ").push_bind_unseparated(value);
        }

        if let Some(value) = input.data.description {
            fields
                .push("description = ")
                .push_bind_unseparated(value.filter(|description| !description.is_empty()));
        }

        if let Some(value) = input.data.code {
            fields.push("code = ").push_bind_unseparated(value);
        }

        if let Some(value) = input.data.enabled {
            fields.push("enabled = ").push_bind_unseparated(value);
        }

        fields
            .push("modified_by_user_id = ")
            .push_bind_unseparated(user_id);
    }

    query
        .push(" WHERE id = ")
        .push_bind(input.id.0)
        .push(format!(" RETURNING {DETAIL_COLUMNS}"));

    query
        .build_query_as::<ScriptDetail>()
        .fetch_optional(&pool)
        .await
        .map_err(internal)
}

async fn delete(state: &AppState, context: &RequestContext, input: IdInput) -> RpcResult<Success> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require(&auth, "delete:clientScripts")?;

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    sqlx::query("DELETE FROM client_scripts WHERE id = $1")
        .bind(input.id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(Success { success: true })
}

fn require(auth: &AuthResult, role: &str) -> RpcResult<()> {
    auth.can_do(role)
        .then_some(())
        .ok_or_else(|| RpcError::new(ErrorCode::Forbidden, "Forbidden").with_http_code(403))
}

fn parse_database_id(value: &str) -> RpcResult<i64> {
    value
        .parse()
        .map_err(|_| bad_input("id must be a decimal integer"))
}

fn bad_input(message: &str) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    #[ts(optional = nullable)]
    search: Option<String>,
    #[ts(optional)]
    include_disabled: Option<bool>,
    #[ts(optional, type = "number")]
    limit: Option<i64>,
}

impl ListInput {
    fn validate(&self) -> RpcResult<()> {
        if self
            .limit
            .is_some_and(|limit| !(1..=SCRIPT_LIST_LIMIT).contains(&limit))
        {
            return Err(bad_input("limit must be between 1 and 200"));
        }
        if self
            .search
            .as_deref()
            .is_some_and(|value| value.len() > 200)
        {
            return Err(bad_input("search must not exceed 200 characters"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdInput {
    id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ScriptInput {
    name: String,
    #[ts(optional = nullable)]
    description: Option<String>,
    code: String,
    #[ts(optional)]
    enabled: Option<bool>,
}

impl ScriptInput {
    fn normalize_and_validate(&mut self) -> RpcResult<()> {
        self.name = self.name.trim().to_owned();
        self.description = self.description.take().map(|value| value.trim().to_owned());
        validate_fields(
            self.name.as_str(),
            self.description.as_deref(),
            self.code.as_str(),
        )
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct UpdateInput {
    id: Id,
    data: ScriptPatch,
}

#[derive(Debug, Default, TS)]
struct ScriptPatch {
    #[ts(optional)]
    name: Option<String>,
    #[ts(optional)]
    description: Option<Option<String>>,
    #[ts(optional)]
    code: Option<String>,
    #[ts(optional)]
    enabled: Option<bool>,
}

impl<'de> Deserialize<'de> for ScriptPatch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WirePatch {
            name: Option<String>,
            #[serde(default, deserialize_with = "double_option")]
            description: Option<Option<String>>,
            code: Option<String>,
            enabled: Option<bool>,
        }

        let wire = WirePatch::deserialize(deserializer)?;
        Ok(Self {
            name: wire.name,
            description: wire.description,
            code: wire.code,
            enabled: wire.enabled,
        })
    }
}

impl ScriptPatch {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.description.is_none()
            && self.code.is_none()
            && self.enabled.is_none()
    }

    fn normalize_and_validate(&mut self) -> RpcResult<()> {
        self.name = self.name.take().map(|value| value.trim().to_owned());
        self.description = self
            .description
            .take()
            .map(|value| value.map(|description| description.trim().to_owned()));

        if let Some(name) = self.name.as_deref() {
            validate_name(name)?;
        }

        if let Some(Some(description)) = self.description.as_ref() {
            validate_description(description)?;
        }

        if self
            .code
            .as_deref()
            .is_some_and(|value| value.len() > SCRIPT_CODE_MAX)
        {
            return Err(bad_input("code must not exceed 200000 characters"));
        }

        Ok(())
    }
}

fn double_option<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

fn validate_fields(name: &str, description: Option<&str>, code: &str) -> RpcResult<()> {
    validate_name(name)?;

    if let Some(description) = description {
        validate_description(description)?;
    }

    if code.len() > SCRIPT_CODE_MAX {
        return Err(bad_input("code must not exceed 200000 characters"));
    }

    Ok(())
}

fn validate_name(value: &str) -> RpcResult<()> {
    if value.is_empty() || value.len() > 160 {
        Err(bad_input("name must contain between 1 and 160 characters"))
    } else {
        Ok(())
    }
}

fn validate_description(value: &str) -> RpcResult<()> {
    if value.len() > 2_000 {
        Err(bad_input("description must not exceed 2000 characters"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Serialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
struct ScriptSummary {
    id: Id,
    name: String,
    description: Option<String>,
    enabled: bool,
    created_by_user_id: Option<Id>,
    modified_by_user_id: Option<Id>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
struct ScriptDetail {
    id: Id,
    name: String,
    description: Option<String>,
    code: String,
    enabled: bool,
    created_by_user_id: Option<Id>,
    modified_by_user_id: Option<Id>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}
