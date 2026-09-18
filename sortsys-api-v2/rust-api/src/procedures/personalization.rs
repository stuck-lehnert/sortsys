//! Recent activity, visit history, and quick-action history.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use ts_rs::TS;

use super::common::{authenticated_pool, bad_request, internal};
use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const VISIT_HISTORY_LIMIT: i64 = 100;
const ACTION_HISTORY_LIMIT: i64 = 200;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<Option<ActivityListInput>, Vec<Activity>>("personalization.activity.list")
}

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let activity_state = Arc::clone(&state);
    builder = builder.query(
        "personalization.activity.list",
        move |context, input: Option<ActivityListInput>| {
            let state = Arc::clone(&activity_state);

            async move {
                let (auth, pool) = authenticated_pool(&state, &context).await?;

                list_activity(&pool, &auth, input.unwrap_or_default()).await
            }
        },
    );

    let list_visits_state = Arc::clone(&state);
    builder = builder.query(
        "personalization.visits.list",
        move |context, input: Option<HistoryListInput>| {
            let state = Arc::clone(&list_visits_state);

            async move { list_visits(&state, &context, input.unwrap_or_default()).await }
        },
    );

    let append_visit_state = Arc::clone(&state);
    builder = builder.mutation("personalization.visits.append", move |context, input| {
        let state = Arc::clone(&append_visit_state);

        async move { append_visit(&state, &context, input).await }
    });

    let list_actions_state = Arc::clone(&state);
    builder = builder.query(
        "personalization.actions.list",
        move |context, input: Option<ActionListInput>| {
            let state = Arc::clone(&list_actions_state);

            async move { list_actions(&state, &context, input.unwrap_or_default()).await }
        },
    );

    builder.mutation("personalization.actions.append", move |context, input| {
        let state = Arc::clone(&state);

        async move { append_action(&state, &context, input).await }
    })
}

async fn list_visits(
    state: &AppState,
    context: &RequestContext,
    input: HistoryListInput,
) -> RpcResult<Vec<Visit>> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let limit = input.limit.unwrap_or(20).clamp(1, VISIT_HISTORY_LIMIT);

    sqlx::query_as::<_, Visit>(
        r#"
        SELECT id, path, title, visited_at
        FROM user_visit_history
        WHERE user_id = $1
        ORDER BY visited_at DESC, id DESC
        LIMIT $2
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&pool)
    .await
    .map_err(internal)
}

async fn append_visit(
    state: &AppState,
    context: &RequestContext,
    mut input: AppendVisitInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    input.normalize()?;

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    sqlx::query(
        r#"
        INSERT INTO user_visit_history (user_id, path, title)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(user_id)
    .bind(input.path)
    .bind(input.title)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    // Keep pruning in the same transaction as the append so concurrent
    // requests cannot leave a history larger than the documented limit.
    sqlx::query(
        r#"
        DELETE FROM user_visit_history
        WHERE user_id = $1
          AND id NOT IN (
              SELECT id
              FROM user_visit_history
              WHERE user_id = $1
              ORDER BY visited_at DESC, id DESC
              LIMIT $2
          )
        "#,
    )
    .bind(user_id)
    .bind(VISIT_HISTORY_LIMIT)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(Success { success: true })
}

async fn list_actions(
    state: &AppState,
    context: &RequestContext,
    input: ActionListInput,
) -> RpcResult<Vec<Action>> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let limit = input.limit.unwrap_or(100).clamp(1, ACTION_HISTORY_LIMIT);

    sqlx::query_as::<_, Action>(
        r#"
        SELECT id, action_id, label, href, used_at
        FROM user_action_history
        WHERE user_id = $1
        ORDER BY used_at DESC, id DESC
        LIMIT $2
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&pool)
    .await
    .map_err(internal)
}

async fn append_action(
    state: &AppState,
    context: &RequestContext,
    mut input: AppendActionInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    input.normalize()?;

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    sqlx::query(
        r#"
        INSERT INTO user_action_history (user_id, action_id, label, href)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(user_id)
    .bind(input.action_id)
    .bind(input.label)
    .bind(input.href)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    sqlx::query(
        r#"
        DELETE FROM user_action_history
        WHERE user_id = $1
          AND id NOT IN (
              SELECT id
              FROM user_action_history
              WHERE user_id = $1
              ORDER BY used_at DESC, id DESC
              LIMIT $2
          )
        "#,
    )
    .bind(user_id)
    .bind(ACTION_HISTORY_LIMIT)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(Success { success: true })
}

async fn list_activity(
    pool: &PgPool,
    auth: &AuthResult,
    input: ActivityListInput,
) -> RpcResult<Vec<Activity>> {
    let limit = input.limit.unwrap_or(25).clamp(1, 50);
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let resource_type = input
        .resource_type
        .as_ref()
        .map(ActivityResourceType::as_str);
    let resource_id = input.resource_id.map(|id| id.0);
    let context_id = input.context_id.map(|id| id.0);

    let supervised_users: Vec<i64> = super::vacations::supervised_user_ids(pool, user_id)
        .await?
        .into_iter()
        .collect();

    // Deduplicate only the dashboard overview, after applying visibility. Entity
    // timelines and cursor pages retain every individual audit event.
    let selection = if input.latest_per_resource.unwrap_or(false) {
        "SELECT * FROM (
            SELECT DISTINCT ON (resource_type, resource_id) * FROM visible
            ORDER BY resource_type, resource_id, occurred_at DESC, id DESC
        ) AS latest"
    } else {
        "SELECT * FROM visible"
    };
    let sql = format!("{ACTIVITY_SQL} {selection} ORDER BY occurred_at DESC, id DESC LIMIT $16");

    let rows = sqlx::query_as::<_, ActivityRow>(&sql)
        .bind(user_id)
        .bind(auth.can_do("view:projects"))
        .bind(auth.can_do("view:tools"))
        .bind(auth.can_do("view:users"))
        .bind(auth.can_do("view:customers"))
        .bind(auth.can_do("view:contacts"))
        .bind(auth.can_do("view:products"))
        .bind(auth.can_do("view:productVendors"))
        .bind(auth.can_do("view:deliveryNotes"))
        .bind(auth.can_do("view:regieReports"))
        .bind(auth.can_do("view:dailyProjectReports"))
        .bind(resource_type)
        .bind(resource_id)
        .bind(context_id)
        .bind(input.include_project_context.unwrap_or(false))
        .bind(limit)
        .bind(auth.can_do("view:projectDeployments"))
        .bind(input.cursor.map(|id| id.0))
        .bind(auth.can_do("view:userVacations") || auth.can_do("view:projectDeployments"))
        .bind(auth.is_admin())
        .bind(supervised_users)
        .bind(auth.can_do("view:toolTrackings"))
        .bind(auth.can_do("view:toolInventories"))
        .bind(auth.can_do("view:productPriceRecords"))
        .bind(
            auth.can_do("view:projects")
                && auth.can_do("view:deliveryNotes")
                && auth.can_do("view:dailyProjectReports"),
        )
        .fetch_all(pool)
        .await
        .map_err(internal)?;

    Ok(rows.into_iter().map(Activity::from).collect())
}

// History visibility follows current roles and assignments, including deleted
// entities. A stored actor is not an access grant to the reader.
const ACTIVITY_SQL: &str = r#"
    WITH visible AS (
    SELECT
        change.id,
        change.entity_table,
        change.entity_id,
        change.changed_columns,
        change.actor_user_id,
        change.actor_kind,
        COALESCE(change.actor_name, NULLIF(CONCAT_WS(' ', actor.first_name, actor.last_name), '')) AS actor_name,
        change.is_imported,
        change.resource_type,
        change.resource_id,
        CASE WHEN $2 OR context_assignment.user_id IS NOT NULL THEN change.context_id END AS context_id,
        CASE WHEN $2 OR context_assignment.user_id IS NOT NULL
            THEN COALESCE(project.title, change.context_title) END AS context_title,
        CASE WHEN $2 OR context_assignment.user_id IS NOT NULL
            THEN change.context_date::timestamp AT TIME ZONE 'UTC' END AS context_date,
        CASE WHEN change.title = change.entity_table OR change.entity_table NOT IN (
            'projects', 'tools', 'users', 'customers', 'contacts', 'products',
            'product_vendors', 'product_delivery_notes', 'regie_reports', 'daily_project_reports',
            'project_files', 'project_file_folders'
        ) THEN COALESCE(change.resource_title,
            entity_activity_resource_title(change.resource_type, change.resource_id), '')
            ELSE change.title END AS title,
        COALESCE(change.resource_title,
            entity_activity_resource_title(change.resource_type, change.resource_id),
            NULLIF(change.title, change.entity_table)) AS resource_title,
        change.description,
        change.action,
        change.occurred_at,
        COALESCE(change.entity_created_at, change.occurred_at) AS created_at,
        CASE WHEN change.action IN ('updated', 'completed', 'resumed') THEN change.occurred_at END AS modified_at
    FROM entity_changes AS change
    LEFT JOIN projects AS project ON project.id = change.context_id
    LEFT JOIN users AS actor ON actor.id = change.actor_user_id
    LEFT JOIN project_user_assignments AS context_assignment
        ON context_assignment.project_id = change.context_id AND context_assignment.user_id = $1
    LEFT JOIN project_deployments AS deployment
        ON deployment.id = CASE WHEN change.entity_table = 'project_deployments'
            THEN change.entity_id::bigint END
    LEFT JOIN tool_trackings AS tracking
        ON tracking.id = CASE WHEN change.entity_table = 'tool_trackings'
            THEN change.entity_id::bigint END
    WHERE CASE change.resource_type
        WHEN 'project' THEN $2 OR EXISTS (
            SELECT 1 FROM project_user_assignments
            WHERE project_id = change.resource_id AND user_id = $1
        )
        WHEN 'tool' THEN CASE
            WHEN change.entity_table IN ('tool_trackings', 'tool_tracking_transfer_requests')
                THEN $22 OR $1 = ANY(change.participant_user_ids)
                    OR COALESCE(change.subject_user_id, tracking.responsible_user_id) = $1
            WHEN change.entity_table = 'tool_inventories' THEN $23
            ELSE $3 OR EXISTS (
                SELECT 1 FROM tool_trackings
                WHERE tool_id = change.resource_id AND responsible_user_id = $1 AND ended_at IS NULL
            )
        END
        WHEN 'user' THEN CASE
            WHEN change.entity_table = 'user_passkeys' THEN change.resource_id = $1
            WHEN change.entity_table = 'user_role_assignments' THEN $20 OR change.resource_id = $1
            WHEN change.entity_table = 'user_vacations'
                THEN $19 OR change.resource_id = $1 OR change.resource_id = ANY($21::bigint[])
            ELSE $4 OR change.resource_id = $1
        END
        WHEN 'customer' THEN $5
        WHEN 'contact' THEN $6
        WHEN 'product' THEN $7
        WHEN 'productVendor' THEN $8
        WHEN 'deliveryNote' THEN $9
        WHEN 'regieReport' THEN $10
        WHEN 'dailyProjectReport' THEN $11
        ELSE FALSE
    END
      AND (change.entity_table <> 'project_deployments'
          OR $17 OR COALESCE(change.subject_user_id, deployment.user_id) = $1)
      AND (change.entity_table <> 'project_unavailability_periods'
          OR $17 OR context_assignment.user_id IS NOT NULL)
      AND (change.entity_table <> 'project_financial_entries' OR $25)
      AND (change.entity_table <> 'product_price_records' OR $24)
      AND (change.entity_table <> 'users'
          OR change.action <> 'updated'
          OR NOT (change.changed_columns && ARRAY['password', 'password_hash']::text[])
          OR $20 OR change.resource_id = $1)
      AND (change.resource_type NOT IN ('deliveryNote', 'regieReport', 'dailyProjectReport')
          OR change.context_id IS NULL OR $2 OR context_assignment.user_id IS NOT NULL)
      AND (
        CASE WHEN $15 AND $12 = 'project' AND $13 IS NOT NULL
            THEN (change.resource_type = 'project' AND change.resource_id = $13) OR change.context_id = $13
            ELSE ($12::text IS NULL OR change.resource_type = $12)
                AND ($13::bigint IS NULL OR change.resource_id = $13)
        END
      )
      AND ($14::bigint IS NULL OR (change.context_id = $14
          AND ($2 OR context_assignment.user_id IS NOT NULL)))
      AND ($18::bigint IS NULL OR (change.occurred_at, change.id) < (
          SELECT occurred_at, id FROM entity_changes WHERE id = $18
      ))
    )
"#;

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryListInput {
    #[serde(default)]
    #[ts(optional)]
    limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionListInput {
    #[serde(default)]
    #[ts(optional)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppendVisitInput {
    path: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    title: Option<String>,
}
impl AppendVisitInput {
    fn normalize(&mut self) -> RpcResult<()> {
        self.path = self.path.trim().to_owned();
        if self.path.is_empty() || self.path.len() > 512 {
            return Err(bad_request("invalid path"));
        }
        self.title = self
            .title
            .take()
            .map(|title| title.trim().to_owned())
            .filter(|title| !title.is_empty());

        if self.title.as_ref().is_some_and(|title| title.len() > 160) {
            return Err(bad_request("invalid title"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppendActionInput {
    action_id: String,
    label: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    href: Option<String>,
}
impl AppendActionInput {
    fn normalize(&mut self) -> RpcResult<()> {
        self.action_id = self.action_id.trim().to_owned();
        self.label = self.label.trim().to_owned();
        self.href = self
            .href
            .take()
            .map(|href| href.trim().to_owned())
            .filter(|href| !href.is_empty());

        if self.action_id.is_empty()
            || self.action_id.len() > 128
            || self.label.is_empty()
            || self.label.len() > 160
            || self.href.as_ref().is_some_and(|href| href.len() > 512)
        {
            return Err(bad_request("invalid action"));
        }

        Ok(())
    }
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityListInput {
    #[serde(default)]
    #[ts(optional)]
    latest_per_resource: Option<bool>,
    #[serde(default)]
    #[ts(optional = nullable)]
    cursor: Option<Id>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    limit: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    resource_type: Option<ActivityResourceType>,
    #[serde(default)]
    #[ts(optional = nullable)]
    resource_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    context_id: Option<Id>,
    #[serde(default)]
    #[ts(optional)]
    include_project_context: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
enum ActivityResourceType {
    Project,
    Tool,
    User,
    Customer,
    Contact,
    Product,
    ProductVendor,
    DeliveryNote,
    RegieReport,
    DailyProjectReport,
}
impl ActivityResourceType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Tool => "tool",
            Self::User => "user",
            Self::Customer => "customer",
            Self::Contact => "contact",
            Self::Product => "product",
            Self::ProductVendor => "productVendor",
            Self::DeliveryNote => "deliveryNote",
            Self::RegieReport => "regieReport",
            Self::DailyProjectReport => "dailyProjectReport",
        }
    }
}

#[derive(Debug, Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct Visit {
    id: Id,
    path: String,
    title: Option<String>,
    #[ts(type = "Date")]
    visited_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct Action {
    id: Id,
    action_id: String,
    label: String,
    href: Option<String>,
    #[ts(type = "Date")]
    used_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct ActivityRow {
    id: Id,
    entity_table: String,
    entity_id: String,
    changed_columns: Vec<String>,
    actor_user_id: Option<Id>,
    actor_kind: String,
    actor_name: Option<String>,
    is_imported: bool,
    resource_type: String,
    resource_id: i64,
    context_id: Option<i64>,
    context_title: Option<String>,
    context_date: Option<DateTime<Utc>>,
    title: String,
    resource_title: Option<String>,
    description: Option<String>,
    action: String,
    occurred_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Activity {
    id: Id,
    entity_table: String,
    entity_id: String,
    changed_columns: Vec<String>,
    actor_user_id: Option<Id>,
    actor_kind: String,
    actor_name: Option<String>,
    is_imported: bool,
    #[ts(type = "ActivityResourceType")]
    resource_type: String,
    resource_id: Id,
    context_id: Option<Id>,
    context_title: Option<String>,
    #[ts(type = "Date | null")]
    context_date: Option<DateTime<Utc>>,
    title: String,
    resource_title: Option<String>,
    description: Option<String>,
    #[ts(type = "\"created\" | \"updated\" | \"deleted\" | \"completed\" | \"resumed\"")]
    action: String,
    #[ts(type = "Date")]
    occurred_at: DateTime<Utc>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date | null")]
    modified_at: Option<DateTime<Utc>>,
}
impl From<ActivityRow> for Activity {
    fn from(row: ActivityRow) -> Self {
        Self {
            id: row.id,
            entity_table: row.entity_table,
            entity_id: row.entity_id,
            changed_columns: row.changed_columns,
            actor_user_id: row.actor_user_id,
            actor_kind: row.actor_kind,
            actor_name: row.actor_name,
            is_imported: row.is_imported,
            resource_type: row.resource_type,
            resource_id: Id(row.resource_id),
            context_id: row.context_id.map(Id),
            context_title: row.context_title,
            context_date: row.context_date,
            title: row.title,
            resource_title: row.resource_title,
            description: row.description,
            action: row.action,
            occurred_at: row.occurred_at,
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}
