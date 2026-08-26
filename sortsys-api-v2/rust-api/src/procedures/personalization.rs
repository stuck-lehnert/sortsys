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

    let rows = sqlx::query_as::<_, ActivityRow>(ACTIVITY_SQL)
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
        .fetch_all(pool)
        .await
        .map_err(internal)?;

    Ok(rows.into_iter().map(Activity::from).collect())
}

// Each UNION branch is guarded by the matching role parameter. Projects and
// tools also expose records assigned to the current user, as the legacy API did.
const ACTIVITY_SQL: &str = r#"
    WITH activity AS (
        SELECT
            'project'::text AS resource_type,
            project.id AS resource_id,
            NULL::bigint AS context_id,
            NULL::timestamptz AS context_date,
            project.title::text AS title,
            NULL::text AS description,
            CASE
                WHEN project.modified_at
                    > project.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END AS action,
            GREATEST(
                project.created_at,
                project.modified_at
            ) AS occurred_at,
            project.created_at,
            project.modified_at
        FROM projects AS project
        WHERE $2
           OR EXISTS (
               SELECT 1
               FROM project_user_assignments AS assignment
               WHERE assignment.project_id = project.id
                 AND assignment.user_id = $1
           )

        UNION ALL

        SELECT
            'tool',
            tool.id,
            NULL,
            NULL,
            CONCAT(
                '#',
                tool.custom_id,
                ' ',
                tool.brand,
                ' ',
                tool.category,
                COALESCE(' ' || tool.label, '')
            ),
            NULL,
            CASE
                WHEN tool.modified_at
                    > tool.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END,
            GREATEST(tool.created_at, tool.modified_at),
            tool.created_at,
            tool.modified_at
        FROM tools AS tool
        WHERE $3
           OR EXISTS (
               SELECT 1
               FROM tool_trackings AS tracking
               WHERE tracking.tool_id = tool.id
                 AND tracking.ended_at IS NULL
                 AND tracking.responsible_user_id = $1
           )

        UNION ALL

        SELECT
            'user',
            users.id,
            NULL,
            NULL,
            CONCAT(
                users.first_name,
                COALESCE(' ' || users.last_name, '')
            ),
            users.username,
            CASE
                WHEN users.modified_at
                    > users.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END,
            GREATEST(users.created_at, users.modified_at),
            users.created_at,
            users.modified_at
        FROM users
        WHERE $4
          AND users.archived_at IS NULL

        UNION ALL

        SELECT
            'customer',
            customer.id,
            NULL,
            NULL,
            CONCAT(
                COALESCE(customer.salutation || ' ', ''),
                customer.name
            ),
            NULL,
            CASE
                WHEN customer.modified_at
                    > customer.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END,
            GREATEST(customer.created_at, customer.modified_at),
            customer.created_at,
            customer.modified_at
        FROM customers AS customer
        WHERE $5

        UNION ALL

        SELECT
            'contact',
            contact.id,
            NULL,
            NULL,
            CONCAT(
                COALESCE(contact.salutation || ' ', ''),
                COALESCE(contact.first_name, ''),
                COALESCE(' ' || contact.last_name, '')
            ),
            NULL,
            CASE
                WHEN contact.modified_at
                    > contact.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END,
            GREATEST(contact.created_at, contact.modified_at),
            contact.created_at,
            contact.modified_at
        FROM contacts AS contact
        WHERE $6

        UNION ALL

        SELECT
            'product',
            product.id,
            NULL,
            NULL,
            CONCAT(
                '#',
                product.custom_id,
                ' ',
                COALESCE(product.brand || ' ', ''),
                product.name
            ),
            product.description,
            CASE
                WHEN product.modified_at
                    > product.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END,
            GREATEST(product.created_at, product.modified_at),
            product.created_at,
            product.modified_at
        FROM products AS product
        WHERE $7

        UNION ALL

        SELECT
            'productVendor',
            vendor.id,
            NULL,
            NULL,
            vendor.name,
            vendor.description,
            CASE
                WHEN vendor.modified_at
                    > vendor.created_at + interval '1 second'
                    THEN 'updated'
                ELSE 'created'
            END,
            GREATEST(vendor.created_at, vendor.modified_at),
            vendor.created_at,
            vendor.modified_at
        FROM product_vendors AS vendor
        WHERE $8

        UNION ALL

        SELECT
            'deliveryNote',
            note.id,
            note.project_id,
            NULL,
            CONCAT('Lieferschein #', note.auto_id),
            NULL,
            'created',
            note.created_at,
            note.created_at,
            NULL
        FROM product_delivery_notes AS note
        WHERE $9

        UNION ALL

        SELECT
            'regieReport',
            report.id,
            report.project_id,
            report.day::timestamptz,
            CONCAT(
                'Regiebericht ',
                to_char(report.day, 'DD.MM.YYYY')
            ),
            report.summary,
            'created',
            report.created_at,
            report.created_at,
            NULL
        FROM regie_reports AS report
        WHERE $10

        UNION ALL

        SELECT
            'dailyProjectReport',
            report.id,
            report.project_id,
            report.day::timestamptz,
            CONCAT(
                'Bautagesbericht ',
                to_char(report.day, 'DD.MM.YYYY')
            ),
            report.summary,
            'created',
            report.created_at,
            report.created_at,
            NULL
        FROM daily_project_reports AS report
        WHERE $11
    )
    SELECT
        activity.resource_type,
        activity.resource_id,
        activity.context_id,
        project.title AS context_title,
        activity.context_date,
        activity.title,
        activity.description,
        activity.action,
        activity.occurred_at,
        activity.created_at,
        activity.modified_at
    FROM activity
    LEFT JOIN projects AS project
      ON project.id = activity.context_id
    WHERE (
        CASE
            WHEN $15
             AND $12 = 'project'
             AND $13 IS NOT NULL
                THEN (
                    activity.resource_type = 'project'
                    AND activity.resource_id = $13
                )
                OR activity.context_id = $13
            ELSE (
                $12::text IS NULL
                OR activity.resource_type = $12
            )
            AND (
                $13::bigint IS NULL
                OR activity.resource_id = $13
            )
        END
    )
      AND (
          $14::bigint IS NULL
          OR activity.context_id = $14
      )
    ORDER BY
        activity.occurred_at DESC,
        activity.resource_type,
        activity.resource_id
    LIMIT $16
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
    resource_type: String,
    resource_id: i64,
    context_id: Option<i64>,
    context_title: Option<String>,
    context_date: Option<DateTime<Utc>>,
    title: String,
    description: Option<String>,
    action: String,
    occurred_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Activity {
    #[ts(type = "ActivityResourceType")]
    resource_type: String,
    resource_id: Id,
    context_id: Option<Id>,
    context_title: Option<String>,
    #[ts(type = "Date | null")]
    context_date: Option<DateTime<Utc>>,
    title: String,
    description: Option<String>,
    #[ts(type = "\"created\" | \"updated\"")]
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
            resource_type: row.resource_type,
            resource_id: Id(row.resource_id),
            context_id: row.context_id.map(Id),
            context_title: row.context_title,
            context_date: row.context_date,
            title: row.title,
            description: row.description,
            action: row.action,
            occurred_at: row.occurred_at,
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}
