//! Core project lifecycle procedures.
//!
//! Scheduling, contacts, files, reports, and costs live in focused sibling
//! modules so this file remains easy to navigate.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, types::Json};
use ts_rs::TS;

use super::common::{
    Address, Patch, authorized_pool, bad_request, internal, not_found, trim_required,
    validate_address,
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let get_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let update_state = Arc::clone(&state);
    let finish_state = Arc::clone(&state);
    let resume_state = Arc::clone(&state);

    builder
        .query("projects.list", move |context, input: ProjectListInput| {
            let state = Arc::clone(&list_state);

            async move { list(&state, &context, input).await }
        })
        .query("projects.get", move |context, input: IdentifierInput| {
            let state = Arc::clone(&get_state);

            async move { get(&state, &context, input.id).await }
        })
        .mutation(
            "projects.create",
            move |context, mut input: ProjectCreateInput| {
                let state = Arc::clone(&create_state);

                async move {
                    input.normalize()?;
                    create(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.update",
            move |context, input: ProjectUpdateInput| {
                let state = Arc::clone(&update_state);

                async move { update(&state, &context, input).await }
            },
        )
        .mutation("projects.finish", move |context, input: IdentifierInput| {
            let state = Arc::clone(&finish_state);

            async move { set_finished(&state, &context, input.id, true).await }
        })
        .mutation("projects.resume", move |context, input: IdentifierInput| {
            let state = Arc::clone(&resume_state);

            async move { set_finished(&state, &context, input.id, false).await }
        })
        .mutation("projects.delete", move |context, input: IdentifierInput| {
            let state = Arc::clone(&state);

            async move { delete(&state, &context, input.id).await }
        })
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    input: ProjectListInput,
) -> RpcResult<Vec<Project>> {
    let (auth, pool) = super::common::authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let can_view_all = auth.can_do("view:projects");
    let search = input
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let rows = sqlx::query_as::<_, ProjectRow>(
        r#"
        SELECT
            project.id,
            project.title,
            project.address,
            project.customer_id,
            project.responsible_project_leader_user_id,
            project.order_received_at,
            project.created_by_user_id,
            project.created_at,
            project.modified_at,
            project.finished_at
        FROM projects AS project
        WHERE (
            $1
            OR EXISTS (
                SELECT 1
                FROM project_user_assignments AS assignment
                WHERE assignment.project_id = project.id
                  AND assignment.user_id = $2
            )
        )
          AND (
              $3::boolean IS NULL
              OR ($3 AND project.finished_at IS NOT NULL)
              OR (NOT $3 AND project.finished_at IS NULL)
          )
          AND (
              $4::text IS NULL
              OR project._search @@ create_query($4)
          )
          AND (
              $5::bigint IS NULL
              OR project.customer_id = $5
          )
        ORDER BY LOWER(project.title)
        "#,
    )
    .bind(can_view_all)
    .bind(user_id)
    .bind(input.finished)
    .bind(search)
    .bind(input.customer_id.map(|id| id.0))
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(Project::from).collect())
}

async fn get(state: &AppState, context: &RequestContext, id: Id) -> RpcResult<Project> {
    let (auth, pool) = super::common::authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let can_view_all = auth.can_do("view:projects");

    project_by_id(&pool, id, can_view_all, user_id)
        .await?
        .ok_or_else(not_found)
}

async fn project_by_id(
    pool: &PgPool,
    id: Id,
    can_view_all: bool,
    user_id: i64,
) -> RpcResult<Option<Project>> {
    let row = sqlx::query_as::<_, ProjectRow>(
        r#"
        SELECT
            project.id,
            project.title,
            project.address,
            project.customer_id,
            project.responsible_project_leader_user_id,
            project.order_received_at,
            project.created_by_user_id,
            project.created_at,
            project.modified_at,
            project.finished_at
        FROM projects AS project
        WHERE project.id = $1
          AND (
              $2
              OR EXISTS (
                  SELECT 1
                  FROM project_user_assignments AS assignment
                  WHERE assignment.project_id = project.id
                    AND assignment.user_id = $3
              )
          )
        "#,
    )
    .bind(id.0)
    .bind(can_view_all)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(internal)?;

    Ok(row.map(Project::from))
}

async fn create(
    state: &AppState,
    context: &RequestContext,
    input: ProjectCreateInput,
) -> RpcResult<CreatedId> {
    let (auth, pool) = authorized_pool(state, context, "manage:projects").await?;
    let creator_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO projects (
            title,
            address,
            customer_id,
            responsible_project_leader_user_id,
            order_received_at,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(input.title)
    .bind(input.address.map(Json))
    .bind(input.customer_id.map(|id| id.0))
    .bind(input.responsible_project_leader_user_id.map(|id| id.0))
    .bind(input.order_received_at)
    .bind(creator_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(CreatedId { id: Id(id) })
}

async fn update(
    state: &AppState,
    context: &RequestContext,
    input: ProjectUpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    if input.data.is_empty() {
        return Err(bad_request("empty update"));
    }

    let existing = sqlx::query_as::<_, ProjectWritable>(
        r#"
        SELECT
            title,
            address,
            customer_id,
            responsible_project_leader_user_id,
            order_received_at
        FROM projects
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    let title = match input.data.title {
        Patch::Missing => existing.title,
        Patch::Null => return Err(bad_request("title cannot be null")),
        Patch::Value(mut title) => {
            trim_required(&mut title, "title", 127)?;
            title
        }
    };

    let mut address = input
        .data
        .address
        .apply(existing.address.map(|value| value.0));
    validate_address(&mut address)?;

    let customer_id = input
        .data
        .customer_id
        .apply(existing.customer_id.map(Id))
        .map(|id| id.0);
    let leader_id = input
        .data
        .responsible_project_leader_user_id
        .apply(existing.responsible_project_leader_user_id.map(Id))
        .map(|id| id.0);
    let order_received_at = input
        .data
        .order_received_at
        .apply(existing.order_received_at);

    sqlx::query(
        r#"
        UPDATE projects
        SET
            title = $2,
            address = $3,
            customer_id = $4,
            responsible_project_leader_user_id = $5,
            order_received_at = $6
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .bind(title)
    .bind(address.map(Json))
    .bind(customer_id)
    .bind(leader_id)
    .bind(order_received_at)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn set_finished(
    state: &AppState,
    context: &RequestContext,
    id: Id,
    finished: bool,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    // Finishing an already-finished project is intentionally idempotent, but a
    // missing project must still be distinguishable from that no-op.
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1)")
            .bind(id.0)
            .fetch_one(&pool)
            .await
            .map_err(internal)?;

    if !exists {
        return Err(not_found());
    }

    if finished {
        sqlx::query(
            "UPDATE projects SET finished_at = NOW() WHERE id = $1 AND finished_at IS NULL",
        )
        .bind(id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;
    } else {
        sqlx::query("UPDATE projects SET finished_at = NULL WHERE id = $1")
            .bind(id.0)
            .execute(&pool)
            .await
            .map_err(internal)?;
    }

    Ok(Success { success: true })
}

async fn delete(state: &AppState, context: &RequestContext, id: Id) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "delete:projects").await?;

    let result = sqlx::query("DELETE FROM projects WHERE id = $1")
        .bind(id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectListInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    search: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    finished: Option<bool>,

    #[serde(default)]
    #[ts(optional = nullable)]
    customer_id: Option<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdentifierInput {
    id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectCreateInput {
    title: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    address: Option<Address>,

    #[serde(default)]
    #[ts(optional = nullable)]
    customer_id: Option<Id>,

    #[serde(default)]
    #[ts(optional = nullable)]
    responsible_project_leader_user_id: Option<Id>,

    #[serde(default)]
    #[ts(optional = nullable, type = "Date | null")]
    order_received_at: Option<DateTime<Utc>>,
}

impl ProjectCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.title, "title", 127)?;
        validate_address(&mut self.address)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ProjectUpdateInput {
    id: Id,
    data: ProjectPatch,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectPatch {
    #[serde(default)]
    #[ts(optional, type = "string")]
    title: Patch<String>,

    #[serde(default)]
    #[ts(optional, type = "Address | null")]
    address: Patch<Address>,

    #[serde(default)]
    #[ts(optional, type = "string | null")]
    customer_id: Patch<Id>,

    #[serde(default)]
    #[ts(optional, type = "string | null")]
    responsible_project_leader_user_id: Patch<Id>,

    #[serde(default)]
    #[ts(optional, type = "Date | null")]
    order_received_at: Patch<DateTime<Utc>>,
}

impl ProjectPatch {
    fn is_empty(&self) -> bool {
        self.title.is_missing()
            && self.address.is_missing()
            && self.customer_id.is_missing()
            && self.responsible_project_leader_user_id.is_missing()
            && self.order_received_at.is_missing()
    }
}

#[derive(Debug, Serialize, TS)]
struct CreatedId {
    id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: Id,
    title: String,
    address: Option<Address>,
    customer_id: Option<Id>,
    responsible_project_leader_user_id: Option<Id>,

    #[ts(type = "Date | null")]
    order_received_at: Option<DateTime<Utc>>,

    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,

    #[ts(type = "Date | null")]
    finished_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct ProjectRow {
    id: i64,
    title: String,
    address: Option<Json<Address>>,
    customer_id: Option<i64>,
    responsible_project_leader_user_id: Option<i64>,
    order_received_at: Option<DateTime<Utc>>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

impl From<ProjectRow> for Project {
    fn from(row: ProjectRow) -> Self {
        Self {
            id: Id(row.id),
            title: row.title,
            address: row.address.map(|value| value.0),
            customer_id: row.customer_id.map(Id),
            responsible_project_leader_user_id: row.responsible_project_leader_user_id.map(Id),
            order_received_at: row.order_received_at,
            created_by_user_id: row.created_by_user_id.map(Id),
            created_at: row.created_at,
            modified_at: row.modified_at,
            finished_at: row.finished_at,
        }
    }
}

#[derive(FromRow)]
struct ProjectWritable {
    title: String,
    address: Option<Json<Address>>,
    customer_id: Option<i64>,
    responsible_project_leader_user_id: Option<i64>,
    order_received_at: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::{ProjectCreateInput, ProjectPatch};

    #[test]
    fn normalizes_project_titles_and_rejects_empty_updates() {
        let mut input: ProjectCreateInput = serde_json::from_value(serde_json::json!({
            "title": "  Test project  "
        }))
        .expect("valid input");

        input.normalize().expect("normalization succeeds");

        assert_eq!(input.title, "Test project");
        assert!(ProjectPatch::default().is_empty());
    }
}
