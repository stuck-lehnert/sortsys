//! Tools, deployments, transfers, and inventory procedures.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgPool};

use super::common::{
    authenticated_pool, authorized_pool, bad_request, conflict, forbidden, input_id, input_object,
    input_string, internal, not_found, optional_input_id, optional_input_string,
};
use crate::{
    AppState,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query_json("tools.list", move |context, input| {
        let state = Arc::clone(&list_state);

        async move { list_tools(&state, &context, input).await }
    });

    let get_state = Arc::clone(&state);
    builder = builder.query_json("tools.get", move |context, input| {
        let state = Arc::clone(&get_state);

        async move { get_tool(&state, &context, input).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create_tool(&state, &context, input).await }
    });

    let update_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.update", move |context, input| {
        let state = Arc::clone(&update_state);

        async move { update_tool(&state, &context, input).await }
    });

    let delete_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.delete", move |context, input| {
        let state = Arc::clone(&delete_state);

        async move { delete_tool(&state, &context, input).await }
    });

    for (path, archive) in [("tools.archive", true), ("tools.unarchive", false)] {
        let archive_state = Arc::clone(&state);
        builder = builder.mutation_json(path, move |context, input| {
            let state = Arc::clone(&archive_state);

            async move { set_archived(&state, &context, input, archive).await }
        });
    }

    let track_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.track", move |context, input| {
        let state = Arc::clone(&track_state);

        async move { track(&state, &context, input).await }
    });

    let untrack_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.untrack", move |context, input| {
        let state = Arc::clone(&untrack_state);

        async move { untrack(&state, &context, input).await }
    });

    let tracking_list_state = Arc::clone(&state);
    builder = builder.query_json("tools.trackings.list", move |context, input| {
        let state = Arc::clone(&tracking_list_state);

        async move { list_trackings(&state, &context, input).await }
    });

    let transfer_list_state = Arc::clone(&state);
    builder = builder.query_json("tools.trackings.transfers.list", move |context, input| {
        let state = Arc::clone(&transfer_list_state);

        async move { list_transfers(&state, &context, input).await }
    });

    let transfer_request_state = Arc::clone(&state);
    builder = builder.mutation_json(
        "tools.trackings.transfers.request",
        move |context, input| {
            let state = Arc::clone(&transfer_request_state);

            async move { request_transfer(&state, &context, input).await }
        },
    );

    let transfer_accept_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.trackings.transfers.accept", move |context, input| {
        let state = Arc::clone(&transfer_accept_state);

        async move { accept_transfer(&state, &context, input).await }
    });

    let transfer_deny_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.trackings.transfers.deny", move |context, input| {
        let state = Arc::clone(&transfer_deny_state);

        async move { deny_transfer(&state, &context, input).await }
    });

    let inventory_overview_state = Arc::clone(&state);
    builder = builder.query_json("tools.inventories.overview", move |context, input| {
        let state = Arc::clone(&inventory_overview_state);

        async move { inventory_overview(&state, &context, input).await }
    });

    let inventory_list_state = Arc::clone(&state);
    builder = builder.query_json("tools.inventories.list", move |context, input| {
        let state = Arc::clone(&inventory_list_state);

        async move { list_inventories(&state, &context, input).await }
    });

    let inventory_create_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.inventories.create", move |context, input| {
        let state = Arc::clone(&inventory_create_state);

        async move { create_inventory(&state, &context, input).await }
    });

    let inventory_delete_state = Arc::clone(&state);
    builder = builder.mutation_json("tools.inventories.delete", move |context, input| {
        let state = Arc::clone(&inventory_delete_state);

        async move { delete_inventory(&state, &context, input).await }
    });

    let categories_state = Arc::clone(&state);
    builder = builder.query_json("tools.categories", move |context, input| {
        let state = Arc::clone(&categories_state);

        async move { list_distinct_tool_field(&state, &context, input, "category").await }
    });

    let brands_state = Arc::clone(&state);
    builder = builder.query_json("tools.brands", move |context, input| {
        let state = Arc::clone(&brands_state);

        async move { list_distinct_tool_field(&state, &context, input, "brand").await }
    });

    builder.query_json("tools.suggestNextCustomId", move |context, input| {
        let state = Arc::clone(&state);

        async move { suggest_next_custom_id(&state, &context, input).await }
    })
}

#[derive(FromRow)]
struct ToolRow {
    id: i64,
    custom_id: i32,
    brand: String,
    category: String,
    label: Option<String>,
    purchase_price: Option<f64>,
    usage_cost_per_day: Option<f64>,
    status: Option<String>,
    available: bool,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    archived_since: Option<DateTime<Utc>>,
}

impl ToolRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "customId": self.custom_id,
            "brand": self.brand,
            "category": self.category,
            "label": self.label,
            "purchasePrice": self.purchase_price,
            "usageCostPerDay": self.usage_cost_per_day,
            "status": self.status,
            "available": self.available,
            "createdByUserId": self.created_by_user_id.map(Id),
            "createdAt": self.created_at,
            "modifiedAt": self.modified_at,
            "archivedSince": self.archived_since,
        })
    }
}

const TOOL_SELECT: &str = r#"
    SELECT
        tool.id,
        tool.custom_id,
        tool.brand,
        tool.category,
        tool.label,
        tool.purchase_price,
        tool.usage_cost_per_day,
        tool.status,
        active_tracking.id IS NULL AS available,
        tool.created_by_user_id,
        tool.created_at,
        tool.modified_at,
        tool.archived_since
    FROM tools AS tool
    LEFT JOIN tool_trackings AS active_tracking
      ON active_tracking.tool_id = tool.id
     AND active_tracking.ended_at IS NULL
"#;

async fn list_tools(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let input = input_object(&input)?;

    let search = optional_input_string(input, "search")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let brand = optional_input_string(input, "brand")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let category = optional_input_string(input, "category")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let status = optional_input_string(input, "status");

    validate_tool_filter(status)?;

    let sql = format!(
        r#"
        {TOOL_SELECT}
        WHERE (
            $1
            OR active_tracking.responsible_user_id = $2
        )
          AND (
              $3::text IS NULL
              OR tool._search @@ create_query($3)
          )
          AND ($4::text IS NULL OR tool.brand = $4)
          AND ($5::text IS NULL OR tool.category = $5)
          AND (
              $6::text IS NULL
              OR ($6 = 'lost' AND tool.status = 'lost')
              OR ($6 = 'broken' AND tool.status = 'broken')
              OR (
                  $6 = 'available'
                  AND active_tracking.id IS NULL
                  AND tool.status IS NULL
              )
              OR (
                  $6 = 'unavailable'
                  AND active_tracking.id IS NOT NULL
                  AND tool.status IS NULL
              )
          )
        ORDER BY tool.custom_id
        "#
    );

    let current_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let rows = sqlx::query_as::<_, ToolRow>(&sql)
        .bind(auth.can_do("view:tools"))
        .bind(current_user_id)
        .bind(search)
        .bind(brand)
        .bind(category)
        .bind(status)
        .fetch_all(&pool)
        .await
        .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter().map(ToolRow::into_wire_value).collect(),
    ))
}

async fn get_tool(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let tool_id = input_id(input_object(&input)?, "id")?;
    let current_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let sql = format!(
        r#"
        {TOOL_SELECT}
        WHERE tool.id = $1
          AND (
              $2
              OR active_tracking.responsible_user_id = $3
          )
        "#
    );

    let tool = sqlx::query_as::<_, ToolRow>(&sql)
        .bind(tool_id)
        .bind(auth.can_do("view:tools"))
        .bind(current_user_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;

    Ok(tool.into_wire_value())
}

async fn create_tool(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authorized_pool(state, context, "manage:tools").await?;
    let input = input_object(&input)?;

    let custom_id = positive_i32(input, "customId")?;
    let brand = required_text(input, "brand", 127)?;
    let category = required_text(input, "category", 127)?;
    let label = nullable_text(input, "label", 255)?;
    let purchase_price = optional_nonnegative(input, "purchasePrice")?;
    let usage_cost = optional_nonnegative(input, "usageCostPerDay")?;
    let status = optional_tool_status(input, "status")?;
    let created_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let tool_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO tools (
            custom_id,
            brand,
            category,
            label,
            purchase_price,
            usage_cost_per_day,
            status,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(custom_id)
    .bind(brand)
    .bind(category)
    .bind(label)
    .bind(purchase_price)
    .bind(usage_cost)
    .bind(status)
    .bind(created_by_user_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "id": Id(tool_id) }))
}

#[derive(FromRow)]
struct ToolUpdateRow {
    brand: String,
    category: String,
    label: Option<String>,
    purchase_price: Option<f64>,
    usage_cost_per_day: Option<f64>,
    status: Option<String>,
}

async fn update_tool(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:tools").await?;
    let input = input_object(&input)?;
    let tool_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let current = sqlx::query_as::<_, ToolUpdateRow>(
        r#"
        SELECT
            brand,
            category,
            label,
            purchase_price,
            usage_cost_per_day,
            status
        FROM tools
        WHERE id = $1
        "#,
    )
    .bind(tool_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;
    let current = current.ok_or_else(not_found)?;

    let brand = if changes.contains_key("brand") {
        required_text(changes, "brand", 127)?
    } else {
        current.brand
    };
    let category = if changes.contains_key("category") {
        required_text(changes, "category", 127)?
    } else {
        current.category
    };
    let label = if changes.contains_key("label") {
        nullable_text(changes, "label", 255)?
    } else {
        current.label
    };
    let purchase_price = if changes.contains_key("purchasePrice") {
        optional_nonnegative(changes, "purchasePrice")?
    } else {
        current.purchase_price
    };
    let usage_cost = if changes.contains_key("usageCostPerDay") {
        optional_nonnegative(changes, "usageCostPerDay")?
    } else {
        current.usage_cost_per_day
    };
    let status = if changes.contains_key("status") {
        optional_tool_status(changes, "status")?
    } else {
        current.status
    };

    sqlx::query(
        r#"
        UPDATE tools
        SET
            brand = $2,
            category = $3,
            label = $4,
            purchase_price = $5,
            usage_cost_per_day = $6,
            status = $7
        WHERE id = $1
        "#,
    )
    .bind(tool_id)
    .bind(brand)
    .bind(category)
    .bind(label)
    .bind(purchase_price)
    .bind(usage_cost)
    .bind(status)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if changes.get("usageCostPerDay").is_some_and(Value::is_number) {
        // Historical rows with an explicit cost remain unchanged; only rows
        // that were waiting for the tool default inherit the new value.
        sqlx::query(
            r#"
            UPDATE tool_trackings
            SET tool_usage_cost_per_day = $2
            WHERE tool_id = $1
              AND tool_usage_cost_per_day IS NULL
            "#,
        )
        .bind(tool_id)
        .bind(usage_cost)
        .execute(&pool)
        .await
        .map_err(internal)?;
    }

    Ok(success())
}

async fn delete_tool(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:tools").await?;
    let tool_id = input_id(input_object(&input)?, "id")?;

    delete_by_id(&pool, "tools", tool_id).await?;

    Ok(success())
}

async fn set_archived(
    state: &AppState,
    context: &RequestContext,
    input: Value,
    archive: bool,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:tools").await?;
    let tool_id = input_id(input_object(&input)?, "id")?;

    let result = if archive {
        sqlx::query(
            r#"
            UPDATE tools
            SET archived_since = NOW()
            WHERE id = $1
              AND archived_since IS NULL
            "#,
        )
        .bind(tool_id)
        .execute(&pool)
        .await
        .map_err(internal)?
    } else {
        sqlx::query("UPDATE tools SET archived_since = NULL WHERE id = $1")
            .bind(tool_id)
            .execute(&pool)
            .await
            .map_err(internal)?
    };

    if result.rows_affected() == 0 {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tools WHERE id = $1)")
            .bind(tool_id)
            .fetch_one(&pool)
            .await
            .map_err(internal)?;

        if !exists {
            return Err(not_found());
        }
    }

    Ok(success())
}

fn validate_tool_filter(status: Option<&str>) -> RpcResult<()> {
    if status
        .is_some_and(|status| !["lost", "broken", "available", "unavailable"].contains(&status))
    {
        return Err(bad_request("invalid status"));
    }

    Ok(())
}

fn positive_i32(input: &Map<String, Value>, key: &str) -> RpcResult<i32> {
    let value = input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad_request(format!("missing {key}")))?;

    if value <= 0 || value > i64::from(i32::MAX) {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value as i32)
}

fn required_text(input: &Map<String, Value>, key: &str, max_length: usize) -> RpcResult<String> {
    let value = input_string(input, key)?.trim();

    if value.is_empty() || value.len() > max_length {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value.to_owned())
}

fn nullable_text(
    input: &Map<String, Value>,
    key: &str,
    max_length: usize,
) -> RpcResult<Option<String>> {
    let value = optional_input_string(input, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if value.as_ref().is_some_and(|value| value.len() > max_length) {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value)
}

fn optional_nonnegative(input: &Map<String, Value>, key: &str) -> RpcResult<Option<f64>> {
    let value = input.get(key).and_then(Value::as_f64);

    if value.is_some_and(|value| value < 0.0) {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value)
}

fn optional_tool_status(input: &Map<String, Value>, key: &str) -> RpcResult<Option<String>> {
    let status = optional_input_string(input, key).map(str::to_owned);

    if status
        .as_deref()
        .is_some_and(|status| !["lost", "broken"].contains(&status))
    {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(status)
}

fn optional_timestamp(input: &Map<String, Value>, key: &str) -> RpcResult<Option<DateTime<Utc>>> {
    let Some(value) = optional_input_string(input, key) else {
        return Ok(None);
    };

    DateTime::parse_from_rfc3339(value)
        .map(|value| Some(value.with_timezone(&Utc)))
        .map_err(|_| bad_request(format!("invalid {key}")))
}

async fn track(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authorized_pool(state, context, "manage:toolTrackings").await?;
    let input = input_object(&input)?;
    let tool_id = input_id(input, "id")?;
    let data = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let project_id = optional_input_id(data, "projectId")?;
    let responsible_user_id = optional_input_id(data, "responsibleUserId")?;
    let mut deadline_at = optional_timestamp(data, "deadlineAt")?;
    if deadline_at.is_some_and(|deadline| deadline <= Utc::now()) {
        deadline_at = Some(Utc::now());
    }
    let comment = nullable_text(data, "comment", 255)?;

    let usage_cost: Option<f64> =
        sqlx::query_scalar("SELECT usage_cost_per_day FROM tools WHERE id = $1")
            .bind(tool_id)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?
            .ok_or_else(not_found)?;

    let started_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let tracking_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO tool_trackings (
            tool_id,
            project_id,
            responsible_user_id,
            deadline_at,
            comment,
            started_by_user_id,
            tool_usage_cost_per_day
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(tool_id)
    .bind(project_id)
    .bind(responsible_user_id)
    .bind(deadline_at)
    .bind(comment)
    .bind(started_by_user_id)
    .bind(usage_cost)
    .fetch_one(&pool)
    .await
    .map_err(|error| {
        if error.as_database_error().is_some_and(|database_error| {
            database_error.is_unique_violation() || database_error.is_check_violation()
        }) {
            conflict()
        } else {
            internal(error)
        }
    })?;

    Ok(json!({ "trackingId": Id(tracking_id) }))
}

async fn untrack(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authorized_pool(state, context, "manage:toolTrackings").await?;
    let tool_id = input_id(input_object(&input)?, "id")?;
    let ended_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let mut transaction = pool.begin().await.map_err(internal)?;
    let tracking_ids: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM tool_trackings
        WHERE tool_id = $1
          AND ended_at IS NULL
        "#,
    )
    .bind(tool_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(internal)?;

    if !tracking_ids.is_empty() {
        sqlx::query(
            r#"
            UPDATE tool_tracking_transfer_requests
            SET status = 'denied'
            WHERE tool_tracking_id = ANY($1)
              AND status = 'open'
            "#,
        )
        .bind(&tracking_ids)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    }

    sqlx::query(
        r#"
        UPDATE tool_trackings
        SET
            ended_at = NOW(),
            ended_by_user_id = $2
        WHERE tool_id = $1
          AND ended_at IS NULL
        "#,
    )
    .bind(tool_id)
    .bind(ended_by_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

#[derive(FromRow)]
struct TrackingRow {
    id: i64,
    tool_id: i64,
    project_id: Option<i64>,
    responsible_user_id: Option<i64>,
    started_by_user_id: Option<i64>,
    ended_by_user_id: Option<i64>,
    tool_usage_cost_per_day: Option<f64>,
    comment: Option<String>,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    deadline_at: Option<DateTime<Utc>>,
}

impl TrackingRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "toolId": Id(self.tool_id),
            "projectId": self.project_id.map(Id),
            "responsibleUserId": self.responsible_user_id.map(Id),
            "startedByUserId": self.started_by_user_id.map(Id),
            "endedByUserId": self.ended_by_user_id.map(Id),
            "toolUsageCostPerDay": self.tool_usage_cost_per_day,
            "comment": self.comment,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "deadlineAt": self.deadline_at,
        })
    }
}

async fn list_trackings(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let input = input_object(&input)?;

    let finished = input.get("finished").and_then(Value::as_bool);
    let tool_id = optional_input_id(input, "toolId")?;
    let project_id = optional_input_id(input, "projectId")?;
    let responsible_user_id = optional_input_id(input, "responsibleUserId")?;
    let started_by_user_id = optional_input_id(input, "startedByUserId")?;
    let ended_by_user_id = optional_input_id(input, "endedByUserId")?;
    let started_before = optional_timestamp(input, "startedBefore")?;
    let started_after = optional_timestamp(input, "startedAfter")?;
    let ended_before = optional_timestamp(input, "endedBefore")?;
    let ended_after = optional_timestamp(input, "endedAfter")?;
    let limit = positive_limit(input, "limit", 1_000)?;
    let offset = nonnegative_offset(input, "offset")?;
    let current_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let rows = sqlx::query_as::<_, TrackingRow>(
        r#"
        SELECT
            id,
            tool_id,
            project_id,
            responsible_user_id,
            started_by_user_id,
            ended_by_user_id,
            tool_usage_cost_per_day,
            comment,
            started_at,
            ended_at,
            deadline_at
        FROM tool_trackings
        WHERE (
            $1
            OR responsible_user_id = $2
        )
          AND ($3::bigint IS NULL OR tool_id = $3)
          AND ($4::bigint IS NULL OR project_id = $4)
          AND ($5::bigint IS NULL OR responsible_user_id = $5)
          AND ($6::bigint IS NULL OR started_by_user_id = $6)
          AND ($7::bigint IS NULL OR ended_by_user_id = $7)
          AND ($8::timestamptz IS NULL OR started_at <= $8)
          AND ($9::timestamptz IS NULL OR started_at >= $9)
          AND (
              $10::timestamptz IS NULL
              OR (ended_at IS NOT NULL AND ended_at <= $10)
          )
          AND (
              $11::timestamptz IS NULL
              OR (ended_at IS NOT NULL AND ended_at >= $11)
          )
          AND (
              $12::bool IS NULL
              OR ($12 AND ended_at IS NOT NULL)
              OR (NOT $12 AND ended_at IS NULL)
          )
        ORDER BY started_at DESC
        LIMIT $13
        OFFSET $14
        "#,
    )
    .bind(auth.can_do("view:toolTrackings"))
    .bind(current_user_id)
    .bind(tool_id)
    .bind(project_id)
    .bind(responsible_user_id)
    .bind(started_by_user_id)
    .bind(ended_by_user_id)
    .bind(started_before)
    .bind(started_after)
    .bind(ended_before)
    .bind(ended_after)
    .bind(finished)
    .bind(limit)
    .bind(offset)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter().map(TrackingRow::into_wire_value).collect(),
    ))
}

fn positive_limit(input: &Map<String, Value>, key: &str, default: i64) -> RpcResult<i64> {
    let value = input.get(key).and_then(Value::as_i64).unwrap_or(default);

    if value <= 0 {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value)
}

fn nonnegative_offset(input: &Map<String, Value>, key: &str) -> RpcResult<i64> {
    let value = input.get(key).and_then(Value::as_i64).unwrap_or(0);

    if value < 0 {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value)
}

#[derive(FromRow)]
struct TransferRow {
    id: i64,
    tool_tracking_id: i64,
    tool_id: i64,
    transfer_to_user_id: i64,
    created_by_user_id: i64,
    project_id: Option<i64>,
    status: String,
    notes: Option<String>,
    created_at: DateTime<Utc>,
    responsible_user_id: Option<i64>,
    tool_usage_cost_per_day: Option<f64>,
}

impl TransferRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "toolTrackingId": Id(self.tool_tracking_id),
            "toolId": Id(self.tool_id),
            "transferToUserId": Id(self.transfer_to_user_id),
            "createdByUserId": Id(self.created_by_user_id),
            "projectId": self.project_id.map(Id),
            "status": self.status,
            "notes": self.notes,
            "createdAt": self.created_at,
            "responsibleUserId": self.responsible_user_id.map(Id),
            "toolUsageCostPerDay": self.tool_usage_cost_per_day,
        })
    }
}

async fn list_transfers(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let input = input_object(&input)?;

    let tool_id = optional_input_id(input, "toolId")?;
    let status = optional_input_string(input, "status");
    validate_transfer_status(status)?;

    let created_by_user_id = optional_input_id(input, "createdByUserId")?;
    let transfer_to_user_id = optional_input_id(input, "transferToUserId")?;
    let project_id = optional_input_id(input, "projectId")?;
    let limit = positive_limit(input, "limit", 1_000)?;
    let offset = nonnegative_offset(input, "offset")?;
    let current_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let rows = sqlx::query_as::<_, TransferRow>(
        r#"
        SELECT
            transfer.id,
            transfer.tool_tracking_id,
            tracking.tool_id,
            transfer.transfer_to_user_id,
            transfer.created_by_user_id,
            transfer.project_id,
            transfer.status,
            transfer.notes,
            transfer.created_at,
            tracking.responsible_user_id,
            tracking.tool_usage_cost_per_day
        FROM tool_tracking_transfer_requests AS transfer
        JOIN tool_trackings AS tracking
          ON tracking.id = transfer.tool_tracking_id
        WHERE ($1::bigint IS NULL OR tracking.tool_id = $1)
          AND ($2::text IS NULL OR transfer.status = $2)
          AND (
              $3::bigint IS NULL
              OR transfer.created_by_user_id = $3
          )
          AND (
              $4::bigint IS NULL
              OR transfer.transfer_to_user_id = $4
          )
          AND ($5::bigint IS NULL OR transfer.project_id = $5)
          AND (
              $6
              OR transfer.created_by_user_id = $7
              OR transfer.transfer_to_user_id = $7
          )
        ORDER BY transfer.created_at DESC
        LIMIT $8
        OFFSET $9
        "#,
    )
    .bind(tool_id)
    .bind(status)
    .bind(created_by_user_id)
    .bind(transfer_to_user_id)
    .bind(project_id)
    .bind(auth.can_do("manage:toolTrackings"))
    .bind(current_user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter().map(TransferRow::into_wire_value).collect(),
    ))
}

#[derive(FromRow)]
struct TransferTrackingState {
    ended_at: Option<DateTime<Utc>>,
    started_by_user_id: Option<i64>,
}

async fn request_transfer(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let input = input_object(&input)?;

    let tracking_id = input_id(input, "toolTrackingId")?;
    let actor_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let transfer_to_user_id =
        optional_input_id(input, "transferToUserId")?.unwrap_or(actor_user_id);
    let project_id = optional_input_id(input, "projectId")?;
    let notes = nullable_text(input, "notes", usize::MAX)?;

    let mut transaction = pool.begin().await.map_err(internal)?;
    let tracking = sqlx::query_as::<_, TransferTrackingState>(
        r#"
            SELECT ended_at, started_by_user_id
            FROM tool_trackings
            WHERE id = $1
            "#,
    )
    .bind(tracking_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal)?;
    let tracking = tracking.ok_or_else(not_found)?;

    if tracking.ended_at.is_some() {
        return Err(conflict());
    }

    let may_manage = auth.can_do("manage:toolTrackings");
    let actor_started_tracking = tracking.started_by_user_id == Some(actor_user_id);
    if !may_manage && transfer_to_user_id != actor_user_id && !actor_started_tracking {
        return Err(forbidden());
    }

    let has_open_or_accepted: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM tool_tracking_transfer_requests
            WHERE tool_tracking_id = $1
              AND status IN ('open', 'accepted')
        )
        "#,
    )
    .bind(tracking_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;

    if has_open_or_accepted {
        return Err(conflict());
    }

    let transfer_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO tool_tracking_transfer_requests (
            tool_tracking_id,
            transfer_to_user_id,
            created_by_user_id,
            project_id,
            notes
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(tracking_id)
    .bind(transfer_to_user_id)
    .bind(actor_user_id)
    .bind(project_id)
    .bind(notes)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(json!({ "id": Id(transfer_id) }))
}

#[derive(FromRow)]
struct TransferAcceptance {
    id: i64,
    tool_tracking_id: i64,
    transfer_to_user_id: i64,
    requested_project_id: Option<i64>,
    notes: Option<String>,
    tool_id: i64,
    current_project_id: Option<i64>,
    deadline_at: Option<DateTime<Utc>>,
}

async fn accept_transfer(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let input = input_object(&input)?;

    let transfer_id = input_id(input, "id")?;
    let override_project_id = optional_input_id(input, "projectId")?;
    let actor_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let mut transaction = pool.begin().await.map_err(internal)?;
    let request = sqlx::query_as::<_, TransferAcceptance>(
        r#"
        SELECT
            transfer.id,
            transfer.tool_tracking_id,
            transfer.transfer_to_user_id,
            transfer.project_id AS requested_project_id,
            transfer.notes,
            tracking.tool_id,
            tracking.project_id AS current_project_id,
            tracking.deadline_at
        FROM tool_tracking_transfer_requests AS transfer
        JOIN tool_trackings AS tracking
          ON tracking.id = transfer.tool_tracking_id
        WHERE transfer.id = $1
          AND transfer.status = 'open'
          AND tracking.ended_at IS NULL
        "#,
    )
    .bind(transfer_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    if !auth.can_do("manage:toolTrackings") && request.transfer_to_user_id != actor_user_id {
        return Err(forbidden());
    }

    sqlx::query(
        r#"
        UPDATE tool_trackings
        SET
            ended_at = NOW(),
            ended_by_user_id = $2
        WHERE id = $1
        "#,
    )
    .bind(request.tool_tracking_id)
    .bind(actor_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    let target_project_id = override_project_id
        .or(request.requested_project_id)
        .or(request.current_project_id);
    let usage_cost: Option<f64> =
        sqlx::query_scalar("SELECT usage_cost_per_day FROM tools WHERE id = $1")
            .bind(request.tool_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(internal)?
            .flatten();

    // A transfer closes the current deployment and creates a continuation so
    // history remains immutable while responsibility moves to the recipient.
    sqlx::query(
        r#"
        INSERT INTO tool_trackings (
            continuation_of,
            tool_id,
            project_id,
            responsible_user_id,
            deadline_at,
            notes,
            tool_usage_cost_per_day,
            started_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(request.tool_tracking_id)
    .bind(request.tool_id)
    .bind(target_project_id)
    .bind(request.transfer_to_user_id)
    .bind(request.deadline_at)
    .bind(request.notes)
    .bind(usage_cost)
    .bind(actor_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    sqlx::query(
        r#"
        UPDATE tool_tracking_transfer_requests
        SET status = 'accepted'
        WHERE id = $1
        "#,
    )
    .bind(request.id)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

async fn deny_transfer(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let transfer_id = input_id(input_object(&input)?, "id")?;
    let actor_user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let recipient_user_id: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT transfer_to_user_id
        FROM tool_tracking_transfer_requests
        WHERE id = $1
          AND status = 'open'
        "#,
    )
    .bind(transfer_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;
    let recipient_user_id = recipient_user_id.ok_or_else(not_found)?;

    if !auth.can_do("manage:toolTrackings") && recipient_user_id != actor_user_id {
        return Err(forbidden());
    }

    sqlx::query(
        r#"
        UPDATE tool_tracking_transfer_requests
        SET status = 'denied'
        WHERE id = $1
        "#,
    )
    .bind(transfer_id)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(success())
}

fn validate_transfer_status(status: Option<&str>) -> RpcResult<()> {
    if status.is_some_and(|status| !["open", "accepted", "denied"].contains(&status)) {
        return Err(bad_request("invalid status"));
    }

    Ok(())
}

#[derive(FromRow)]
struct InventoryOverviewRow {
    id: i64,
    custom_id: i32,
    brand: String,
    category: String,
    label: Option<String>,
    status: Option<String>,
    available: bool,
    archived_since: Option<DateTime<Utc>>,
    last_inventory_at: Option<DateTime<Utc>>,
    last_responsible_user_id: Option<i64>,
    last_responsible_first_name: Option<String>,
    last_responsible_last_name: Option<String>,
}

impl InventoryOverviewRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "customId": self.custom_id,
            "brand": self.brand,
            "category": self.category,
            "label": self.label,
            "status": self.status,
            "available": self.available,
            "archivedSince": self.archived_since,
            "lastInventoryAt": self.last_inventory_at,
            "lastResponsibleUserId": self.last_responsible_user_id.map(Id),
            "lastResponsibleFirstName": self.last_responsible_first_name,
            "lastResponsibleLastName": self.last_responsible_last_name,
        })
    }
}

async fn inventory_overview(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:toolInventories").await?;
    let input = input_object(&input)?;

    let days = input.get("days").and_then(Value::as_i64).unwrap_or(30);
    if !(1..=3_650).contains(&days) {
        return Err(bad_request("invalid days"));
    }
    let had_inventory = input
        .get("hadInventory")
        .and_then(Value::as_bool)
        .ok_or_else(|| bad_request("missing hadInventory"))?;

    let rows = sqlx::query_as::<_, InventoryOverviewRow>(
        r#"
        SELECT
            tool.id,
            tool.custom_id,
            tool.brand,
            tool.category,
            tool.label,
            tool.status,
            active_tracking.id IS NULL AS available,
            tool.archived_since,
            latest_inventory.last_inventory_at,
            latest_tracking.responsible_user_id
                AS last_responsible_user_id,
            responsible.first_name
                AS last_responsible_first_name,
            responsible.last_name
                AS last_responsible_last_name
        FROM tools AS tool
        LEFT JOIN LATERAL (
            SELECT MAX(inventory.created_at) AS last_inventory_at
            FROM tool_inventories AS inventory
            WHERE inventory.tool_id = tool.id
        ) AS latest_inventory ON TRUE
        LEFT JOIN LATERAL (
            SELECT tracking.responsible_user_id
            FROM tool_trackings AS tracking
            WHERE tracking.tool_id = tool.id
            ORDER BY tracking.started_at DESC, tracking.id DESC
            LIMIT 1
        ) AS latest_tracking ON TRUE
        LEFT JOIN users AS responsible
          ON responsible.id = latest_tracking.responsible_user_id
        LEFT JOIN LATERAL (
            SELECT tracking.id
            FROM tool_trackings AS tracking
            WHERE tracking.tool_id = tool.id
              AND tracking.ended_at IS NULL
            LIMIT 1
        ) AS active_tracking ON TRUE
        WHERE (
            $2 = EXISTS (
                SELECT 1
                FROM tool_inventories AS recent_inventory
                WHERE recent_inventory.tool_id = tool.id
                  AND recent_inventory.created_at
                      >= NOW() - ($1::int * INTERVAL '1 day')
            )
        )
        ORDER BY tool.custom_id
        "#,
    )
    .bind(days)
    .bind(had_inventory)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter()
            .map(InventoryOverviewRow::into_wire_value)
            .collect(),
    ))
}

#[derive(FromRow)]
struct InventoryRow {
    id: i64,
    tool_id: i64,
    comment: Option<String>,
    created_at: DateTime<Utc>,
}

impl InventoryRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "toolId": Id(self.tool_id),
            "comment": self.comment,
            "createdAt": self.created_at,
        })
    }
}

async fn list_inventories(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:toolInventories").await?;
    let tool_id = optional_input_id(input_object(&input)?, "toolId")?;

    let rows = sqlx::query_as::<_, InventoryRow>(
        r#"
        SELECT id, tool_id, comment, created_at
        FROM tool_inventories
        WHERE $1::bigint IS NULL OR tool_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(tool_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter()
            .map(InventoryRow::into_wire_value)
            .collect(),
    ))
}

async fn create_inventory(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:toolInventories").await?;
    let input = input_object(&input)?;

    let tool_id = input_id(input, "toolId")?;
    let comment = nullable_text(input, "comment", 511)?;
    let inventory_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO tool_inventories (tool_id, comment)
        VALUES ($1, $2)
        RETURNING id
        "#,
    )
    .bind(tool_id)
    .bind(comment)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "id": Id(inventory_id) }))
}

async fn delete_inventory(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:toolInventories").await?;
    let inventory_id = input_id(input_object(&input)?, "id")?;

    delete_by_id(&pool, "tool_inventories", inventory_id).await?;

    Ok(success())
}

async fn list_distinct_tool_field(
    state: &AppState,
    context: &RequestContext,
    _input: Value,
    field: &str,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:tools").await?;

    // The caller only supplies the two module-private field literals.
    let sql = format!(
        r#"
        SELECT {field}
        FROM (
            SELECT DISTINCT {field}
            FROM tools
        ) AS values
        ORDER BY LOWER({field})
        "#
    );
    let values: Vec<String> = sqlx::query_scalar(&sql)
        .fetch_all(&pool)
        .await
        .map_err(internal)?;

    Ok(json!(values))
}

async fn suggest_next_custom_id(
    state: &AppState,
    context: &RequestContext,
    _input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:tools").await?;

    let custom_id: Option<i32> = sqlx::query_scalar("SELECT MAX(custom_id) FROM tools")
        .fetch_one(&pool)
        .await
        .map_err(internal)?;

    Ok(json!(custom_id.unwrap_or(0) + 1))
}

async fn delete_by_id(pool: &PgPool, table: &str, id: i64) -> RpcResult<()> {
    // Only module-private table literals reach this helper.
    let sql = format!("DELETE FROM {table} WHERE id = $1");
    let result = sqlx::query(&sql)
        .bind(id)
        .execute(pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(())
}

fn success() -> Value {
    json!({ "success": true })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{optional_tool_status, positive_i32, validate_transfer_status};

    #[test]
    fn validates_tool_status_and_positive_custom_ids() {
        let valid = json!({ "customId": 1, "status": "lost" });
        let invalid = json!({ "customId": 0, "status": "unknown" });

        assert!(positive_i32(valid.as_object().unwrap(), "customId").is_ok());
        assert!(optional_tool_status(valid.as_object().unwrap(), "status").is_ok());
        assert!(positive_i32(invalid.as_object().unwrap(), "customId").is_err());
        assert!(optional_tool_status(invalid.as_object().unwrap(), "status").is_err());
    }

    #[test]
    fn validates_transfer_statuses() {
        assert!(validate_transfer_status(Some("open")).is_ok());
        assert!(validate_transfer_status(Some("cancelled")).is_err());
    }
}
