//! Notes attached to projects, customers, tools, and contacts.
//!
//! Every resource type shares one table. `ResourceType::column` is the only
//! source of dynamic SQL identifiers, keeping client input out of SQL syntax.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use ts_rs::TS;

use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const BODY_MAX: usize = 10_000;

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let update_state = Arc::clone(&state);
    let delete_state = Arc::clone(&state);

    builder
        .query(
            "remarks.list",
            move |context: RequestContext, input: ResourceInput| {
                let state = Arc::clone(&list_state);

                async move {
                    let auth = state.auth.authenticate(&context.headers).await?;
                    let pool = tenant_pool(&state, &auth).await?;

                    ensure_access(&pool, &auth, input.resource_type, input.resource_id, false)
                        .await?;

                    let query = format!(
                        "SELECT id, body, created_by_user_id, created_at, modified_at \
                         FROM resource_notes WHERE {} = $1 \
                         ORDER BY created_at DESC, id DESC",
                        input.resource_type.column()
                    );

                    sqlx::query_as::<_, Remark>(&query)
                        .bind(input.resource_id.0)
                        .fetch_all(&pool)
                        .await
                        .map_err(internal)
                }
            },
        )
        .mutation(
            "remarks.create",
            move |context: RequestContext, mut input: CreateInput| {
                let state = Arc::clone(&create_state);

                async move {
                    input.body = normalize_body(input.body)?;

                    let auth = state.auth.authenticate(&context.headers).await?;
                    let pool = tenant_pool(&state, &auth).await?;

                    ensure_access(&pool, &auth, input.resource_type, input.resource_id, true)
                        .await?;

                    let user_id = database_user_id(&auth)?;
                    let query = format!(
                        "INSERT INTO resource_notes ({}, body, created_by_user_id) \
                         VALUES ($1, $2, $3) RETURNING id",
                        input.resource_type.column()
                    );
                    let note_id = sqlx::query_scalar::<_, Id>(&query)
                        .bind(input.resource_id.0)
                        .bind(input.body)
                        .bind(user_id)
                        .fetch_one(&pool)
                        .await
                        .map_err(internal)?;

                    Ok(Created { id: note_id })
                }
            },
        )
        .mutation(
            "remarks.update",
            move |context: RequestContext, mut input: UpdateInput| {
                let state = Arc::clone(&update_state);

                async move {
                    input.body = normalize_body(input.body)?;

                    let auth = state.auth.authenticate(&context.headers).await?;
                    let pool = tenant_pool(&state, &auth).await?;
                    let resource = load_resource(&pool, input.id).await?;

                    ensure_access(&pool, &auth, resource.kind, resource.id, true).await?;

                    sqlx::query("UPDATE resource_notes SET body = $1 WHERE id = $2")
                        .bind(input.body)
                        .bind(input.id.0)
                        .execute(&pool)
                        .await
                        .map_err(internal)?;

                    Ok(Success { success: true })
                }
            },
        )
        .mutation(
            "remarks.delete",
            move |context: RequestContext, input: IdentifierInput| {
                let state = Arc::clone(&delete_state);

                async move {
                    let auth = state.auth.authenticate(&context.headers).await?;
                    let pool = tenant_pool(&state, &auth).await?;
                    let resource = load_resource(&pool, input.id).await?;

                    ensure_access(&pool, &auth, resource.kind, resource.id, true).await?;

                    sqlx::query("DELETE FROM resource_notes WHERE id = $1")
                        .bind(input.id.0)
                        .execute(&pool)
                        .await
                        .map_err(internal)?;

                    Ok(Success { success: true })
                }
            },
        )
}

async fn tenant_pool(state: &AppState, auth: &AuthResult) -> RpcResult<PgPool> {
    state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)
}

async fn load_resource(pool: &PgPool, id: Id) -> RpcResult<Resource> {
    let row = sqlx::query_as::<_, ResourceRow>(
        "SELECT project_id, customer_id, tool_id, contact_id \
         FROM resource_notes WHERE id = $1",
    )
    .bind(id.0)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    if let Some(id) = row.project_id {
        return Ok(Resource {
            kind: ResourceType::Project,
            id: Id(id),
        });
    }

    if let Some(id) = row.customer_id {
        return Ok(Resource {
            kind: ResourceType::Customer,
            id: Id(id),
        });
    }

    if let Some(id) = row.tool_id {
        return Ok(Resource {
            kind: ResourceType::Tool,
            id: Id(id),
        });
    }

    if let Some(id) = row.contact_id {
        return Ok(Resource {
            kind: ResourceType::Contact,
            id: Id(id),
        });
    }

    Err(not_found())
}

async fn ensure_access(
    pool: &PgPool,
    auth: &AuthResult,
    kind: ResourceType,
    id: Id,
    manage: bool,
) -> RpcResult<()> {
    match kind {
        ResourceType::Project => ensure_project_access(pool, auth, id, manage).await,
        ResourceType::Tool => ensure_tool_access(pool, auth, id, manage).await,
        ResourceType::Customer | ResourceType::Contact => {
            let resource = if kind == ResourceType::Customer {
                "customers"
            } else {
                "contacts"
            };
            let permission = format!("{}:{}", if manage { "manage" } else { "view" }, resource);
            if !auth.can_do(&permission) {
                return Err(forbidden());
            }
            ensure_exists(pool, resource, id).await
        }
    }
}

async fn ensure_project_access(
    pool: &PgPool,
    auth: &AuthResult,
    id: Id,
    manage: bool,
) -> RpcResult<()> {
    if manage {
        if !auth.can_do("manage:projects") {
            return Err(forbidden());
        }
        return ensure_exists(pool, "projects", id).await;
    }

    let exists = if auth.can_do("view:projects") {
        exists(
            pool,
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = $1)",
            id,
        )
        .await?
    } else {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM projects p \
             JOIN project_user_assignments pua ON pua.project_id = p.id \
             WHERE p.id = $1 AND pua.user_id = $2)",
        )
        .bind(id.0)
        .bind(database_user_id(auth)?)
        .fetch_one(pool)
        .await
        .map_err(internal)?
    };
    exists.then_some(()).ok_or_else(not_found)
}

async fn ensure_tool_access(
    pool: &PgPool,
    auth: &AuthResult,
    id: Id,
    manage: bool,
) -> RpcResult<()> {
    if manage {
        if !auth.can_do("manage:tools") {
            return Err(forbidden());
        }
        return ensure_exists(pool, "tools", id).await;
    }

    let found = if auth.can_do("view:tools") {
        exists(pool, "SELECT EXISTS(SELECT 1 FROM tools WHERE id = $1)", id).await?
    } else {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM tools t \
             LEFT JOIN tool_trackings tt ON tt.tool_id = t.id AND tt.ended_at IS NULL \
             WHERE t.id = $1 AND tt.responsible_user_id = $2)",
        )
        .bind(id.0)
        .bind(database_user_id(auth)?)
        .fetch_one(pool)
        .await
        .map_err(internal)?
    };
    found.then_some(()).ok_or_else(not_found)
}

async fn ensure_exists(pool: &PgPool, table: &str, id: Id) -> RpcResult<()> {
    let query = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = $1)");
    exists(pool, &query, id)
        .await?
        .then_some(())
        .ok_or_else(not_found)
}

async fn exists(pool: &PgPool, query: &str, id: Id) -> RpcResult<bool> {
    sqlx::query_scalar(query)
        .bind(id.0)
        .fetch_one(pool)
        .await
        .map_err(internal)
}

fn database_user_id(auth: &AuthResult) -> RpcResult<i64> {
    auth.user.id.parse().map_err(internal)
}

fn normalize_body(body: String) -> RpcResult<String> {
    let body = body.trim().to_owned();
    if body.is_empty() || body.len() > BODY_MAX {
        return Err(RpcError::new(
            ErrorCode::BadRequest,
            "body must contain between 1 and 10000 characters",
        ));
    }
    Ok(body)
}

fn forbidden() -> RpcError {
    RpcError::new(ErrorCode::Forbidden, "Forbidden").with_http_code(403)
}

fn not_found() -> RpcError {
    RpcError::new(ErrorCode::NotFound, "Not found").with_http_code(404)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
enum ResourceType {
    Project,
    Customer,
    Tool,
    Contact,
}

impl ResourceType {
    const fn column(self) -> &'static str {
        match self {
            Self::Project => "project_id",
            Self::Customer => "customer_id",
            Self::Tool => "tool_id",
            Self::Contact => "contact_id",
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceInput {
    resource_type: ResourceType,
    resource_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    resource_type: ResourceType,
    resource_id: Id,
    body: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct UpdateInput {
    id: Id,
    body: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdentifierInput {
    id: Id,
}

#[derive(Debug, Serialize, TS)]
struct Created {
    id: Id,
}

#[derive(Debug, Serialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
struct Remark {
    id: Id,
    body: String,
    created_by_user_id: Option<Id>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ResourceRow {
    project_id: Option<i64>,
    customer_id: Option<i64>,
    tool_id: Option<i64>,
    contact_id: Option<i64>,
}

struct Resource {
    kind: ResourceType,
    id: Id,
}
