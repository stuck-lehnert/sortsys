//! Absence request procedures.
//!
//! The authorization model is hierarchical: supervisors can see and decide
//! requests for every user below them, not just direct reports.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

use chrono::{DateTime, Datelike, NaiveDate, Utc};
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

pub(super) async fn supervised_user_ids(
    pool: &PgPool,
    supervisor_user_id: i64,
) -> RpcResult<HashSet<i64>> {
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
    absence_type: String,
    label: Option<String>,
    vacation_days_per_year: Option<i16>,
    status: String,
    note: Option<String>,
    denial_reason: Option<String>,
    requested_by_user_id: Option<i64>,
    decided_by_user_id: Option<i64>,
    decided_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct ApprovedVacationRange {
    from: NaiveDate,
    to: NaiveDate,
}

async fn list(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticate(state, context).await?;
    let input = require_object(&input)?;

    let from = optional_date(input, "from")?;
    let to = optional_date(input, "to")?;
    if from.zip(to).is_some_and(|(from, to)| from > to) {
        return Err(bad_request("invalid absence range"));
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
            user_vacations.id,
            user_vacations.user_id,
            user_vacations."from",
            user_vacations."to",
            user_vacations.absence_type,
            user_vacations.label,
            users.vacation_days_per_year,
            user_vacations.status,
            user_vacations.note,
            user_vacations.denial_reason,
            user_vacations.requested_by_user_id,
            user_vacations.decided_by_user_id,
            user_vacations.decided_at,
            user_vacations.created_at,
            user_vacations.modified_at
        FROM user_vacations
        JOIN users ON users.id = user_vacations.user_id
        WHERE ($1::date IS NULL OR user_vacations."to" >= $1)
          AND ($2::date IS NULL OR user_vacations."from" <= $2)
          AND ($3::bigint IS NULL OR user_vacations.user_id = $3)
          AND ($4 OR user_vacations.status <> 'denied')
          AND ($5::bigint[] IS NULL OR user_vacations.user_id = ANY($5))
        ORDER BY user_vacations."from" DESC, user_vacations.id DESC
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

    let mut vacation_usage_by_id = HashMap::new();
    for row in &rows {
        let may_decide = row.status == "requested"
            && (auth.is_admin() || supervised_users.contains(&row.user_id));

        if may_decide && row.absence_type == "vacation" {
            vacation_usage_by_id.insert(row.id, vacation_usage(&pool, row).await?);
        }
    }

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
                "type": row.absence_type,
                "label": row.label,
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
                "vacationUsage": vacation_usage_by_id.remove(&row.id).unwrap_or_default(),
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
        return Err(bad_request("invalid absence range"));
    }

    let absence_type = normalize_absence_type(input.get("type"))?;
    let label = normalize_absence_label(absence_type, input.get("label"))?;

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
            absence_type,
            label,
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
            $8,
            $9,
            CASE WHEN $9::bigint IS NULL THEN NULL ELSE NOW() END
        )
        RETURNING id, status
        "#,
    )
    .bind(vacation_user_id)
    .bind(actor_user_id)
    .bind(from)
    .bind(to)
    .bind(absence_type)
    .bind(label.as_deref())
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
        SELECT user_vacations.user_id, user_vacations.status
        FROM user_vacations
        JOIN users ON users.id = user_vacations.user_id
        WHERE user_vacations.id = $1
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
        SELECT user_vacations.requested_by_user_id, user_vacations.status
        FROM user_vacations
        JOIN users ON users.id = user_vacations.user_id
        WHERE user_vacations.id = $1
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

async fn vacation_usage(pool: &PgPool, vacation: &VacationRow) -> RpcResult<Vec<Value>> {
    let first_day = NaiveDate::from_ymd_opt(vacation.from.year(), 1, 1)
        .ok_or_else(|| internal("invalid vacation start year"))?;
    let last_day = NaiveDate::from_ymd_opt(vacation.to.year(), 12, 31)
        .ok_or_else(|| internal("invalid vacation end year"))?;

    let approved_ranges = sqlx::query_as::<_, ApprovedVacationRange>(
        r#"
        SELECT "from", "to"
        FROM user_vacations
        WHERE user_id = $1
          AND absence_type = 'vacation'
          AND status = 'approved'
          AND "to" >= $2
          AND "from" <= $3
        "#,
    )
    .bind(vacation.user_id)
    .bind(first_day)
    .bind(last_day)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let mut approved_by_year = BTreeMap::<i32, HashSet<NaiveDate>>::new();
    for range in approved_ranges {
        add_business_days(&mut approved_by_year, range.from, range.to);
    }

    let mut requested_by_year = BTreeMap::<i32, HashSet<NaiveDate>>::new();
    add_business_days(&mut requested_by_year, vacation.from, vacation.to);

    Ok(requested_by_year
        .into_iter()
        .map(|(year, requested_days)| {
            let approved_days = approved_by_year.remove(&year).unwrap_or_default();
            let total_after_approval = approved_days.union(&requested_days).count() as i64;
            let allowance_days = vacation.vacation_days_per_year.map(i64::from);

            json!({
                "year": year,
                "allowanceDays": allowance_days,
                "approvedDays": approved_days.len(),
                "requestedDays": requested_days.len(),
                "remainingAfterApproval": allowance_days.map(|days| days - total_after_approval),
            })
        })
        .collect())
}

fn add_business_days(
    days_by_year: &mut BTreeMap<i32, HashSet<NaiveDate>>,
    from: NaiveDate,
    to: NaiveDate,
) {
    let mut day = from;

    while day <= to {
        if day.weekday().number_from_monday() <= 5 {
            days_by_year.entry(day.year()).or_default().insert(day);
        }

        let Some(next_day) = day.succ_opt() else {
            break;
        };
        day = next_day;
    }
}

fn normalize_absence_type(value: Option<&Value>) -> RpcResult<&'static str> {
    match value.and_then(Value::as_str).unwrap_or("vacation") {
        "vacation" => Ok("vacation"),
        "other" => Ok("other"),
        _ => Err(bad_request("invalid absence type")),
    }
}

fn normalize_absence_label(absence_type: &str, value: Option<&Value>) -> RpcResult<Option<String>> {
    if absence_type == "vacation" {
        if value.is_some_and(|value| !value.is_null()) {
            return Err(bad_request("vacation absence must not have a label"));
        }

        return Ok(None);
    }

    let label = value
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request("other absence requires a label"))?
        .trim();
    if label.is_empty() {
        return Err(bad_request("other absence requires a label"));
    }
    if label.chars().count() > 63 {
        return Err(bad_request("absence label exceeds 63 characters"));
    }

    Ok(Some(label.to_owned()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{normalize_absence_label, normalize_absence_type};

    #[test]
    fn normalizes_absence_types_and_custom_labels() {
        assert_eq!(normalize_absence_type(None).unwrap(), "vacation");
        assert_eq!(
            normalize_absence_type(Some(&json!("other"))).unwrap(),
            "other"
        );
        assert!(normalize_absence_type(Some(&json!("training"))).is_err());

        assert_eq!(normalize_absence_label("vacation", None).unwrap(), None);
        assert_eq!(
            normalize_absence_label("vacation", Some(&json!(null))).unwrap(),
            None
        );
        assert_eq!(
            normalize_absence_label("other", Some(&json!("  ÜLO  "))).unwrap(),
            Some("ÜLO".to_owned())
        );
    }

    #[test]
    fn rejects_invalid_absence_labels() {
        assert!(normalize_absence_label("vacation", Some(&json!("Urlaub"))).is_err());
        assert!(normalize_absence_label("other", None).is_err());
        assert!(normalize_absence_label("other", Some(&json!("   "))).is_err());
        assert!(normalize_absence_label("other", Some(&json!("a".repeat(64)))).is_err());
    }
}
