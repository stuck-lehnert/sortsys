//! Vacation request procedures.
//!
//! The authorization model is hierarchical: supervisors can see and decide
//! requests for every user below them, not just direct reports.

use std::{collections::HashSet, sync::Arc};

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgPool};

use super::common::{bad_request, internal, not_found, parse_calendar_date};
use crate::{
    AppState,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query_json("users.vacations.list", move |context, input| {
        let state = Arc::clone(&list_state);

        async move { list(&state, &context, input).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("users.vacations.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create(&state, &context, input).await }
    });

    for (path, decision) in [
        ("users.vacations.approve", Decision::Approve),
        ("users.vacations.deny", Decision::Deny),
    ] {
        let decision_state = Arc::clone(&state);
        builder = builder.mutation_json(path, move |context, input| {
            let state = Arc::clone(&decision_state);

            async move { decide(&state, &context, input, decision).await }
        });
    }

    builder.mutation_json("users.vacations.delete", move |context, input| {
        let state = Arc::clone(&state);

        async move { delete(&state, &context, input).await }
    })
}

async fn authenticate(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<(AuthResult, PgPool)> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    Ok((auth, pool))
}

fn require_object(input: &Value) -> RpcResult<&Map<String, Value>> {
    input
        .as_object()
        .ok_or_else(|| bad_request("object input required"))
}

fn require_id(input: &Map<String, Value>, key: &str) -> RpcResult<i64> {
    let encoded = input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request(format!("missing {key}")))?;

    Id::decode(encoded)
        .map(|id| id.0)
        .map_err(|_| bad_request(format!("invalid {key}")))
}

fn optional_id(input: &Map<String, Value>, key: &str) -> RpcResult<Option<i64>> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(|encoded| {
            Id::decode(encoded)
                .map(|id| id.0)
                .map_err(|_| bad_request(format!("invalid {key}")))
        })
        .transpose()
}

fn require_date(input: &Map<String, Value>, key: &str) -> RpcResult<NaiveDate> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request(format!("missing {key}")))?;

    parse_calendar_date(value, key)
}

fn optional_date(input: &Map<String, Value>, key: &str) -> RpcResult<Option<NaiveDate>> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(|value| parse_calendar_date(value, key))
        .transpose()
}

fn wire_date(value: NaiveDate) -> String {
    // SuperJSON recognizes this representation and revives it as a Date.
    format!("{}T00:00:00.000Z", value.format("%Y-%m-%d"))
}

fn authenticated_user_id(auth: &AuthResult) -> RpcResult<i64> {
    auth.user.id.parse().map_err(internal)
}

async fn supervised_user_ids(pool: &PgPool, supervisor_user_id: i64) -> RpcResult<HashSet<i64>> {
    // A recursive CTE preserves the legacy behavior where senior supervisors
    // inherit access to every level below their direct reports.
    let rows: Vec<i64> = sqlx::query_scalar(
        r#"
        WITH RECURSIVE supervised(id) AS (
            SELECT id
            FROM users
            WHERE supervisor_user_id = $1

            UNION

            SELECT users.id
            FROM users
            JOIN supervised ON users.supervisor_user_id = supervised.id
        )
        SELECT id
        FROM supervised
        "#,
    )
    .bind(supervisor_user_id)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().collect())
}

#[derive(FromRow)]
struct VacationRow {
    id: i64,
    user_id: i64,
    from: NaiveDate,
    to: NaiveDate,
    status: String,
    note: Option<String>,
    denial_reason: Option<String>,
    requested_by_user_id: Option<i64>,
    decided_by_user_id: Option<i64>,
    decided_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

async fn list(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticate(state, context).await?;
    let input = require_object(&input)?;

    let from = optional_date(input, "from")?;
    let to = optional_date(input, "to")?;
    if from.zip(to).is_some_and(|(from, to)| from > to) {
        return Err(bad_request("invalid vacation range"));
    }

    let requested_user_id = optional_id(input, "userId")?;
    let include_denied = input
        .get("includeDenied")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let current_user_id = authenticated_user_id(&auth)?;
    let supervised_users = if auth.is_admin() {
        HashSet::new()
    } else {
        supervised_user_ids(&pool, current_user_id).await?
    };

    let has_global_visibility = auth.can_do("view:userVacations")
        || auth.can_do("manage:userVacations")
        || auth.can_do("view:projectDeployments");

    let accessible_user_ids = if has_global_visibility {
        None
    } else {
        let mut user_ids = supervised_users.clone();
        user_ids.insert(current_user_id);

        Some(user_ids.into_iter().collect::<Vec<_>>())
    };

    let rows = sqlx::query_as::<_, VacationRow>(
        r#"
        SELECT
            id,
            user_id,
            "from",
            "to",
            status,
            note,
            denial_reason,
            requested_by_user_id,
            decided_by_user_id,
            decided_at,
            created_at,
            modified_at
        FROM user_vacations
        WHERE ($1::date IS NULL OR "to" >= $1)
          AND ($2::date IS NULL OR "from" <= $2)
          AND ($3::bigint IS NULL OR user_id = $3)
          AND ($4 OR status <> 'denied')
          AND ($5::bigint[] IS NULL OR user_id = ANY($5))
        ORDER BY "from" DESC, id DESC
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(requested_user_id)
    .bind(include_denied)
    .bind(accessible_user_ids)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let may_manage = auth.can_do("manage:userVacations");
    let may_delete = auth.can_do("delete:userVacations") || may_manage;

    let vacations = rows
        .into_iter()
        .map(|row| {
            let may_decide = row.status == "requested"
                && (auth.is_admin() || supervised_users.contains(&row.user_id));
            let may_delete_this = may_delete
                || (row.requested_by_user_id == Some(current_user_id) && row.status == "requested");

            json!({
                "id": Id(row.id),
                "userId": Id(row.user_id),
                "from": wire_date(row.from),
                "to": wire_date(row.to),
                "status": row.status,
                "note": row.note,
                "denialReason": row.denial_reason,
                "requestedByUserId": row.requested_by_user_id.map(Id),
                "decidedByUserId": row.decided_by_user_id.map(Id),
                "decidedAt": row.decided_at,
                "createdAt": row.created_at,
                "modifiedAt": row.modified_at,
                "canApprove": may_decide,
                "canDeny": may_decide,
                "canDelete": may_delete_this,
            })
        })
        .collect();

    Ok(Value::Array(vacations))
}

async fn create(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticate(state, context).await?;
    let input = require_object(&input)?;

    let from = require_date(input, "from")?;
    let to = require_date(input, "to")?;
    if from > to {
        return Err(bad_request("invalid vacation range"));
    }

    let actor_user_id = authenticated_user_id(&auth)?;
    let vacation_user_id = optional_id(input, "userId")?.unwrap_or(actor_user_id);
    if vacation_user_id != actor_user_id && !auth.can_do("manage:userVacations") {
        return Err(forbidden());
    }

    let user: Option<(String, Option<i64>)> = sqlx::query_as(
        r#"
        SELECT contract_type, supervisor_user_id
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(vacation_user_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;

    let Some((contract_type, supervisor_user_id)) = user else {
        return Err(not_found());
    };

    // Managers, external workers, and users without a supervisor do not need
    // an approval round-trip. This mirrors the former TypeScript API.
    let immediately_approved = auth.can_do("manage:userVacations")
        || contract_type != "internal"
        || supervisor_user_id.is_none();
    let status = if immediately_approved {
        "approved"
    } else {
        "requested"
    };
    let deciding_user_id = immediately_approved.then_some(actor_user_id);

    let note = input
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|note| !note.is_empty());

    let row: (i64, String) = sqlx::query_as(
        r#"
        INSERT INTO user_vacations (
            user_id,
            requested_by_user_id,
            "from",
            "to",
            status,
            note,
            decided_by_user_id,
            decided_at
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            CASE WHEN $7::bigint IS NULL THEN NULL ELSE NOW() END
        )
        RETURNING id, status
        "#,
    )
    .bind(vacation_user_id)
    .bind(actor_user_id)
    .bind(from)
    .bind(to)
    .bind(status)
    .bind(note)
    .bind(deciding_user_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({
        "id": Id(row.0),
        "status": row.1,
    }))
}

#[derive(Clone, Copy)]
enum Decision {
    Approve,
    Deny,
}

async fn decide(
    state: &AppState,
    context: &RequestContext,
    input: Value,
    decision: Decision,
) -> RpcResult<Value> {
    let (auth, pool) = authenticate(state, context).await?;
    let input = require_object(&input)?;
    let vacation_id = require_id(input, "id")?;

    let vacation: Option<(i64, String)> = sqlx::query_as(
        r#"
        SELECT user_id, status
        FROM user_vacations
        WHERE id = $1
        "#,
    )
    .bind(vacation_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;

    let Some((vacation_user_id, current_status)) = vacation else {
        return Err(not_found());
    };
    if current_status != "requested" {
        return Err(conflict());
    }

    let actor_user_id = authenticated_user_id(&auth)?;
    let may_decide = auth.is_admin()
        || supervised_user_ids(&pool, actor_user_id)
            .await?
            .contains(&vacation_user_id);
    if !may_decide {
        return Err(forbidden());
    }

    let (new_status, denial_reason) = match decision {
        Decision::Approve => ("approved", None),
        Decision::Deny => {
            let reason = input
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .ok_or_else(|| bad_request("missing reason"))?;

            if reason.len() > 255 {
                return Err(bad_request("reason exceeds 255 characters"));
            }

            ("denied", Some(reason))
        }
    };

    sqlx::query(
        r#"
        UPDATE user_vacations
        SET
            status = $2,
            denial_reason = $3,
            decided_by_user_id = $4,
            decided_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(vacation_id)
    .bind(new_status)
    .bind(denial_reason)
    .bind(actor_user_id)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "success": true }))
}

async fn delete(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticate(state, context).await?;
    let vacation_id = require_id(require_object(&input)?, "id")?;

    let vacation: Option<(Option<i64>, String)> = sqlx::query_as(
        r#"
        SELECT requested_by_user_id, status
        FROM user_vacations
        WHERE id = $1
        "#,
    )
    .bind(vacation_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;

    let Some((requested_by_user_id, status)) = vacation else {
        return Err(not_found());
    };

    let actor_user_id = authenticated_user_id(&auth)?;
    let may_delete = auth.can_do("delete:userVacations")
        || auth.can_do("manage:userVacations")
        || (requested_by_user_id == Some(actor_user_id) && status == "requested");
    if !may_delete {
        return Err(forbidden());
    }

    sqlx::query("DELETE FROM user_vacations WHERE id = $1")
        .bind(vacation_id)
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(json!({ "success": true }))
}

fn forbidden() -> RpcError {
    RpcError::new(ErrorCode::Forbidden, "Forbidden").with_http_code(403)
}

fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Conflict").with_http_code(409)
}
