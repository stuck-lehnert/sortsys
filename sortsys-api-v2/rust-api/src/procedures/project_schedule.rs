//! Project deployments and planned unavailability.
//!
//! Both feature groups describe time ranges, but their boundaries differ:
//! deployments use instants and require `from < to`; unavailability uses
//! calendar days and permits a one-day `from == to` range.

use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use sqlx::FromRow;
use ts_rs::TS;

use super::common::{
    Patch, authenticated_pool, authorized_pool, bad_request, internal, not_found,
    parse_calendar_date_text, trim_nullable, trim_required,
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
    register_unavailability(register_deployments(builder, Arc::clone(&state)), state)
}

fn register_deployments(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let update_state = Arc::clone(&state);

    builder
        .query(
            "projects.deployments.list",
            move |context, input: DeploymentListInput| {
                let state = Arc::clone(&list_state);

                async move { list_deployments(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.deployments.create",
            move |context, mut input: DeploymentCreateInput| {
                let state = Arc::clone(&create_state);

                async move {
                    input.normalize()?;
                    create_deployment(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.deployments.update",
            move |context, input: DeploymentUpdateInput| {
                let state = Arc::clone(&update_state);

                async move { update_deployment(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.deployments.delete",
            move |context, input: IdentifierInput| {
                let state = Arc::clone(&state);

                async move { delete_deployment(&state, &context, input.id).await }
            },
        )
}

fn register_unavailability(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let update_state = Arc::clone(&state);

    builder
        .query(
            "projects.unavailability.list",
            move |context, input: UnavailabilityListInput| {
                let state = Arc::clone(&list_state);

                async move { list_unavailability(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.unavailability.create",
            move |context, mut input: UnavailabilityCreateInput| {
                let state = Arc::clone(&create_state);

                async move {
                    input.normalize()?;
                    create_unavailability(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.unavailability.update",
            move |context, input: UnavailabilityUpdateInput| {
                let state = Arc::clone(&update_state);

                async move { update_unavailability(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.unavailability.delete",
            move |context, input: IdentifierInput| {
                let state = Arc::clone(&state);

                async move { delete_unavailability(&state, &context, input.id).await }
            },
        )
}

async fn list_deployments(
    state: &AppState,
    context: &RequestContext,
    input: DeploymentListInput,
) -> RpcResult<Vec<Deployment>> {
    validate_instant_range(input.from, input.to)?;

    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let can_view_all = auth.can_do("view:projectDeployments");

    let rows = sqlx::query_as::<_, DeploymentRow>(
        r#"
        SELECT
            deployment.id,
            deployment.project_id,
            deployment.user_id,
            deployment."from",
            deployment."to",
            deployment.note,
            deployment.created_at,
            deployment.modified_at
        FROM project_deployments AS deployment
        WHERE ($1 OR deployment.user_id = $2)
          AND ($3::bigint IS NULL OR deployment.project_id = $3)
          AND ($4::bigint IS NULL OR deployment.user_id = $4)
          AND deployment."to" > $5
          AND deployment."from" < $6
          AND ($7::timestamptz IS NULL OR deployment.modified_at > $7)
        ORDER BY deployment."from" DESC
        "#,
    )
    .bind(can_view_all)
    .bind(user_id)
    .bind(input.project_id.map(|id| id.0))
    .bind(input.user_id.map(|id| id.0))
    .bind(input.from)
    .bind(input.to)
    .bind(input.since)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(Deployment::from).collect())
}

async fn create_deployment(
    state: &AppState,
    context: &RequestContext,
    input: DeploymentCreateInput,
) -> RpcResult<CreatedId> {
    let (_, pool) = authorized_pool(state, context, "manage:projectDeployments").await?;

    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO project_deployments (
            project_id,
            user_id,
            "from",
            "to",
            note
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.user_id.0)
    .bind(input.from)
    .bind(input.to)
    .bind(input.note)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(CreatedId { id: Id(id) })
}

async fn update_deployment(
    state: &AppState,
    context: &RequestContext,
    input: DeploymentUpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projectDeployments").await?;

    if input.data.is_empty() {
        return Err(bad_request("empty update"));
    }

    let existing = sqlx::query_as::<_, DeploymentWritable>(
        r#"
        SELECT project_id, user_id, "from", "to", note
        FROM project_deployments
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    let project_id = required_patch_id(input.data.project_id, existing.project_id, "projectId")?;
    let user_id = required_patch_id(input.data.user_id, existing.user_id, "userId")?;
    let from = required_patch_value(input.data.from, existing.from, "from")?;
    let to = required_patch_value(input.data.to, existing.to, "to")?;
    let mut note = input.data.note.apply(existing.note);

    trim_nullable(&mut note, "note", 255)?;
    validate_instant_range(from, to)?;

    sqlx::query(
        r#"
        UPDATE project_deployments
        SET project_id = $2, user_id = $3, "from" = $4, "to" = $5, note = $6
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .bind(project_id)
    .bind(user_id)
    .bind(from)
    .bind(to)
    .bind(note)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn delete_deployment(
    state: &AppState,
    context: &RequestContext,
    id: Id,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "delete:projectDeployments").await?;

    let result = sqlx::query("DELETE FROM project_deployments WHERE id = $1")
        .bind(id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn list_unavailability(
    state: &AppState,
    context: &RequestContext,
    input: UnavailabilityListInput,
) -> RpcResult<Vec<Unavailability>> {
    let from = input.from.map(|value| value.0);
    let to = input.to.map(|value| value.0);

    if let (Some(from), Some(to)) = (from, to) {
        validate_calendar_range(from, to)?;
    }

    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let can_view_all = auth.can_do("view:projectDeployments");

    let rows = sqlx::query_as::<_, UnavailabilityRow>(
        r#"
        SELECT
            period.id,
            period.project_id,
            period."from",
            period."to",
            period.reason,
            period.note,
            period.created_by_user_id,
            period.created_at,
            period.modified_at
        FROM project_unavailability_periods AS period
        WHERE ($1::date IS NULL OR period."to" >= $1)
          AND ($2::date IS NULL OR period."from" <= $2)
          AND ($3::bigint IS NULL OR period.project_id = $3)
          AND (
              $4
              OR EXISTS (
                  SELECT 1
                  FROM project_deployments AS deployment
                  WHERE deployment.project_id = period.project_id
                    AND deployment.user_id = $5
                    AND ($1::date IS NULL OR deployment."to" > $1::date)
                    AND ($2::date IS NULL OR deployment."from" < ($2::date + 1))
              )
          )
        ORDER BY period."from" DESC, period.id DESC
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(input.project_id.map(|id| id.0))
    .bind(can_view_all)
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(Unavailability::from).collect())
}

async fn create_unavailability(
    state: &AppState,
    context: &RequestContext,
    input: UnavailabilityCreateInput,
) -> RpcResult<CreatedId> {
    let (auth, pool) = authorized_pool(state, context, "manage:projectDeployments").await?;
    let creator_id = auth.user.id.parse::<i64>().map_err(internal)?;

    ensure_project_exists(&pool, input.project_id).await?;

    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO project_unavailability_periods (
            project_id,
            "from",
            "to",
            reason,
            note,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.from.0)
    .bind(input.to.0)
    .bind(input.reason)
    .bind(input.note)
    .bind(creator_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(CreatedId { id: Id(id) })
}

async fn update_unavailability(
    state: &AppState,
    context: &RequestContext,
    input: UnavailabilityUpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projectDeployments").await?;

    if input.data.is_empty() {
        return Err(bad_request("empty update"));
    }

    let existing = sqlx::query_as::<_, UnavailabilityWritable>(
        r#"
        SELECT project_id, "from", "to", reason, note
        FROM project_unavailability_periods
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    let project_id = required_patch_id(input.data.project_id, existing.project_id, "projectId")?;
    let from = required_patch_value(input.data.from, WireDate(existing.from), "from")?.0;
    let to = required_patch_value(input.data.to, WireDate(existing.to), "to")?.0;
    let mut reason = required_patch_value(input.data.reason, existing.reason, "reason")?;
    let mut note = input.data.note.apply(existing.note);

    trim_required(&mut reason, "reason", 127)?;
    trim_nullable(&mut note, "note", 255)?;
    validate_calendar_range(from, to)?;

    if project_id != existing.project_id {
        ensure_project_exists(&pool, Id(project_id)).await?;
    }

    sqlx::query(
        r#"
        UPDATE project_unavailability_periods
        SET project_id = $2, "from" = $3, "to" = $4, reason = $5, note = $6
        WHERE id = $1
        "#,
    )
    .bind(input.id.0)
    .bind(project_id)
    .bind(from)
    .bind(to)
    .bind(reason)
    .bind(note)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn delete_unavailability(
    state: &AppState,
    context: &RequestContext,
    id: Id,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "delete:projectDeployments").await?;

    let result = sqlx::query("DELETE FROM project_unavailability_periods WHERE id = $1")
        .bind(id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn ensure_project_exists(pool: &sqlx::PgPool, id: Id) -> RpcResult<()> {
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1)")
            .bind(id.0)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if exists { Ok(()) } else { Err(not_found()) }
}

fn validate_instant_range(from: DateTime<Utc>, to: DateTime<Utc>) -> RpcResult<()> {
    if from < to {
        Ok(())
    } else {
        Err(bad_request("from must be before to"))
    }
}

fn validate_calendar_range(from: NaiveDate, to: NaiveDate) -> RpcResult<()> {
    if from <= to {
        Ok(())
    } else {
        Err(bad_request("from must not be after to"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WireDate(NaiveDate);

impl<'de> Deserialize<'de> for WireDate {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let date = parse_calendar_date_text(&value)
            .ok_or_else(|| D::Error::custom("invalid calendar date"))?;

        Ok(Self(date))
    }
}

impl Serialize for WireDate {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&format!("{}T00:00:00.000Z", self.0.format("%Y-%m-%d")))
    }
}

fn required_patch_id(patch: Patch<Id>, current: i64, field: &str) -> RpcResult<i64> {
    match patch {
        Patch::Missing => Ok(current),
        Patch::Value(value) => Ok(value.0),
        Patch::Null => Err(bad_request(format!("{field} cannot be null"))),
    }
}

fn required_patch_value<T>(patch: Patch<T>, current: T, field: &str) -> RpcResult<T> {
    match patch {
        Patch::Missing => Ok(current),
        Patch::Value(value) => Ok(value),
        Patch::Null => Err(bad_request(format!("{field} cannot be null"))),
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdentifierInput {
    id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentListInput {
    #[serde(default)]
    #[ts(optional = nullable, type = "Date | null")]
    since: Option<DateTime<Utc>>,

    #[ts(type = "Date")]
    from: DateTime<Utc>,

    #[ts(type = "Date")]
    to: DateTime<Utc>,

    #[serde(default)]
    #[ts(optional = nullable)]
    project_id: Option<Id>,

    #[serde(default)]
    #[ts(optional = nullable)]
    user_id: Option<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentCreateInput {
    project_id: Id,
    user_id: Id,

    #[ts(type = "Date")]
    from: DateTime<Utc>,

    #[ts(type = "Date")]
    to: DateTime<Utc>,

    #[serde(default)]
    #[ts(optional = nullable)]
    note: Option<String>,
}

impl DeploymentCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_nullable(&mut self.note, "note", 255)?;
        validate_instant_range(self.from, self.to)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct DeploymentUpdateInput {
    id: Id,
    data: DeploymentPatch,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeploymentPatch {
    #[serde(default)]
    #[ts(optional, type = "string")]
    project_id: Patch<Id>,

    #[serde(default)]
    #[ts(optional, type = "string")]
    user_id: Patch<Id>,

    #[serde(default)]
    #[ts(optional, type = "Date")]
    from: Patch<DateTime<Utc>>,

    #[serde(default)]
    #[ts(optional, type = "Date")]
    to: Patch<DateTime<Utc>>,

    #[serde(default)]
    #[ts(optional, type = "string | null")]
    note: Patch<String>,
}

impl DeploymentPatch {
    fn is_empty(&self) -> bool {
        self.project_id.is_missing()
            && self.user_id.is_missing()
            && self.from.is_missing()
            && self.to.is_missing()
            && self.note.is_missing()
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnavailabilityListInput {
    #[serde(default)]
    #[ts(optional = nullable, type = "Date | null")]
    from: Option<WireDate>,

    #[serde(default)]
    #[ts(optional = nullable, type = "Date | null")]
    to: Option<WireDate>,

    #[serde(default)]
    #[ts(optional = nullable)]
    project_id: Option<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnavailabilityCreateInput {
    project_id: Id,

    #[ts(type = "Date")]
    from: WireDate,

    #[ts(type = "Date")]
    to: WireDate,

    reason: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    note: Option<String>,
}

impl UnavailabilityCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.reason, "reason", 127)?;
        trim_nullable(&mut self.note, "note", 255)?;

        validate_calendar_range(self.from.0, self.to.0)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct UnavailabilityUpdateInput {
    id: Id,
    data: UnavailabilityPatch,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnavailabilityPatch {
    #[serde(default)]
    #[ts(optional, type = "string")]
    project_id: Patch<Id>,

    #[serde(default)]
    #[ts(optional, type = "Date")]
    from: Patch<WireDate>,

    #[serde(default)]
    #[ts(optional, type = "Date")]
    to: Patch<WireDate>,

    #[serde(default)]
    #[ts(optional, type = "string")]
    reason: Patch<String>,

    #[serde(default)]
    #[ts(optional, type = "string | null")]
    note: Patch<String>,
}

impl UnavailabilityPatch {
    fn is_empty(&self) -> bool {
        self.project_id.is_missing()
            && self.from.is_missing()
            && self.to.is_missing()
            && self.reason.is_missing()
            && self.note.is_missing()
    }
}

#[derive(Debug, Serialize, TS)]
struct CreatedId {
    id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Deployment {
    id: Id,
    project_id: Id,
    user_id: Id,

    #[ts(type = "Date")]
    from: DateTime<Utc>,

    #[ts(type = "Date")]
    to: DateTime<Utc>,

    note: Option<String>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct DeploymentRow {
    id: i64,
    project_id: i64,
    user_id: i64,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    note: Option<String>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

impl From<DeploymentRow> for Deployment {
    fn from(row: DeploymentRow) -> Self {
        Self {
            id: Id(row.id),
            project_id: Id(row.project_id),
            user_id: Id(row.user_id),
            from: row.from,
            to: row.to,
            note: row.note,
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}

#[derive(FromRow)]
struct DeploymentWritable {
    project_id: i64,
    user_id: i64,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    note: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Unavailability {
    id: Id,
    project_id: Id,

    #[ts(type = "Date")]
    from: WireDate,

    #[ts(type = "Date")]
    to: WireDate,

    reason: String,
    note: Option<String>,
    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct UnavailabilityRow {
    id: i64,
    project_id: i64,
    from: NaiveDate,
    to: NaiveDate,
    reason: String,
    note: Option<String>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

impl From<UnavailabilityRow> for Unavailability {
    fn from(row: UnavailabilityRow) -> Self {
        Self {
            id: Id(row.id),
            project_id: Id(row.project_id),
            from: WireDate(row.from),
            to: WireDate(row.to),
            reason: row.reason,
            note: row.note,
            created_by_user_id: row.created_by_user_id.map(Id),
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}

#[derive(FromRow)]
struct UnavailabilityWritable {
    project_id: i64,
    from: NaiveDate,
    to: NaiveDate,
    reason: String,
    note: Option<String>,
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, NaiveDate, Utc};

    use super::{validate_calendar_range, validate_instant_range};

    #[test]
    fn validates_both_project_range_conventions() {
        let now = Utc::now();

        assert!(validate_instant_range(now, now + Duration::hours(1)).is_ok());
        assert!(validate_instant_range(now, now).is_err());

        let day = NaiveDate::from_ymd_opt(2026, 8, 25).expect("valid day");

        assert!(validate_calendar_range(day, day).is_ok());
        assert!(validate_calendar_range(day + Duration::days(1), day).is_err());
    }
}
