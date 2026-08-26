//! Daily project reports, work hours, weather, and attached project photos.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use sqlx::{FromRow, PgPool, Postgres, Transaction, types::Json};
use ts_rs::TS;

use super::{
    common::{
        Patch, authorized_pool, bad_request, conflict, internal, not_found,
        parse_calendar_date_text, trim_nullable,
    },
    project_files::{ProjectFile, load_report_photos},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query(
        "projects.dailyReports.list",
        move |context, input: ReportListInput| {
            let state = Arc::clone(&list_state);

            async move { list(&state, &context, input).await }
        },
    );

    let get_state = Arc::clone(&state);
    builder = builder.query(
        "projects.dailyReports.get",
        move |context, input: ReportKey| {
            let state = Arc::clone(&get_state);

            async move { get(&state, &context, input).await }
        },
    );

    let create_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.dailyReports.create",
        move |context, mut input: ReportCreateInput| {
            let state = Arc::clone(&create_state);

            async move {
                input.normalize()?;
                create(&state, &context, input).await
            }
        },
    );

    let update_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.dailyReports.update",
        move |context, input: ReportUpdateInput| {
            let state = Arc::clone(&update_state);

            async move { update(&state, &context, input).await }
        },
    );

    let add_photo_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.dailyReports.photos.add",
        move |context, input: PhotoMutationInput| {
            let state = Arc::clone(&add_photo_state);

            async move { add_photo(&state, &context, input).await }
        },
    );

    let remove_photo_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.dailyReports.photos.remove",
        move |context, input: PhotoMutationInput| {
            let state = Arc::clone(&remove_photo_state);

            async move { remove_photo(&state, &context, input).await }
        },
    );

    builder.mutation(
        "projects.dailyReports.delete",
        move |context, input: ReportKey| {
            let state = Arc::clone(&state);

            async move { delete(&state, &context, input).await }
        },
    )
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    input: ReportListInput,
) -> RpcResult<Vec<DailyReport>> {
    let (auth, pool) = authorized_pool(state, context, "view:dailyProjectReports").await?;
    let from = input.from.map(|day| day.0);
    let to = input.to.map(|day| day.0);

    if input.limit == 0 || input.limit > i64::MAX as u64 {
        return Err(bad_request("limit must be positive"));
    }

    let rows = sqlx::query_as::<_, DailyReportRow>(
        r#"
        SELECT
            report.id,
            report.project_id,
            report.day,
            report.summary,
            report.weather,
            report.created_by_user_id,
            report.created_at
        FROM daily_project_reports AS report
        WHERE ($1::bigint IS NULL OR report.project_id = $1)
          AND ($2::date IS NULL OR report.day >= $2)
          AND ($3::date IS NULL OR report.day <= $3)
        ORDER BY report.day DESC, report.project_id
        LIMIT $4
        OFFSET $5
        "#,
    )
    .bind(input.project_id.map(|id| id.0))
    .bind(from)
    .bind(to)
    .bind(input.limit as i64)
    .bind(input.offset as i64)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    assemble_reports(state, &auth.tenant, &pool, rows).await
}

async fn get(
    state: &AppState,
    context: &RequestContext,
    input: ReportKey,
) -> RpcResult<DailyReport> {
    let (auth, pool) = authorized_pool(state, context, "view:dailyProjectReports").await?;

    let row = sqlx::query_as::<_, DailyReportRow>(
        r#"
        SELECT
            id,
            project_id,
            day,
            summary,
            weather,
            created_by_user_id,
            created_at
        FROM daily_project_reports
        WHERE project_id = $1
          AND day = $2
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.day.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    assemble_reports(state, &auth.tenant, &pool, vec![row])
        .await?
        .pop()
        .ok_or_else(not_found)
}

async fn assemble_reports(
    state: &AppState,
    tenant_name: &str,
    pool: &PgPool,
    rows: Vec<DailyReportRow>,
) -> RpcResult<Vec<DailyReport>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let report_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let work_hours = sqlx::query_as::<_, WorkHourRow>(
        r#"
        SELECT id, report_id, user_id, hours, cost_per_hour, contract_type
        FROM daily_project_report_work_hours
        WHERE report_id = ANY($1)
        ORDER BY id
        "#,
    )
    .bind(&report_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    let photos = load_report_photos(state, tenant_name, pool, &report_ids).await?;

    let mut work_by_report = HashMap::<i64, Vec<WorkHour>>::new();
    for row in work_hours {
        work_by_report
            .entry(row.report_id)
            .or_default()
            .push(WorkHour::from(row));
    }

    let mut photos_by_report = HashMap::<i64, Vec<ProjectFile>>::new();
    for (report_id, photo) in photos {
        photos_by_report.entry(report_id).or_default().push(photo);
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let report_id = row.id;

            DailyReport {
                id: Id(report_id),
                project_id: Id(row.project_id),
                day: WireDate(row.day),
                summary: row.summary,
                weather: row.weather.map(|weather| weather.0),
                created_by_user_id: row.created_by_user_id.map(Id),
                created_at: row.created_at,
                work_hours: work_by_report.remove(&report_id).unwrap_or_default(),
                photos: photos_by_report.remove(&report_id).unwrap_or_default(),
            }
        })
        .collect())
}

async fn create(
    state: &AppState,
    context: &RequestContext,
    input: ReportCreateInput,
) -> RpcResult<Success> {
    let (auth, pool) = authorized_pool(state, context, "manage:dailyProjectReports").await?;
    let creator_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    let report_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO daily_project_reports (
            project_id,
            day,
            summary,
            weather,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.day.0)
    .bind(input.summary)
    .bind(input.weather.map(Json))
    .bind(creator_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_write_error)?;

    replace_work_hours(&mut transaction, report_id, input.work_hours).await?;
    transaction.commit().await.map_err(internal)?;

    Ok(Success { success: true })
}

async fn update(
    state: &AppState,
    context: &RequestContext,
    input: ReportUpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:dailyProjectReports").await?;

    if input.data.is_empty() {
        return Err(bad_request("empty update"));
    }

    let mut transaction = pool.begin().await.map_err(internal)?;
    let existing = sqlx::query_as::<_, ReportWritable>(
        r#"
        SELECT id, day, summary, weather
        FROM daily_project_reports
        WHERE project_id = $1
          AND day = $2
        FOR UPDATE
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.day.0)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    let next_day = match input.data.day {
        Patch::Missing => existing.day,
        Patch::Value(day) => day.0,
        Patch::Null => return Err(bad_request("day cannot be null")),
    };
    ensure_not_future(next_day)?;

    let mut summary = input.data.summary.apply(existing.summary);
    trim_nullable(&mut summary, "summary", 5_000)?;

    let weather = input
        .data
        .weather
        .apply(existing.weather.map(|value| value.0));

    sqlx::query(
        r#"
        UPDATE daily_project_reports
        SET day = $3, summary = $4, weather = $5
        WHERE project_id = $1
          AND day = $2
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.day.0)
    .bind(next_day)
    .bind(summary)
    .bind(weather.map(Json))
    .execute(&mut *transaction)
    .await
    .map_err(map_write_error)?;

    match input.data.work_hours {
        Patch::Missing => {}
        Patch::Null => replace_work_hours(&mut transaction, existing.id, Vec::new()).await?,
        Patch::Value(work_hours) => {
            validate_work_hours(&work_hours)?;
            replace_work_hours(&mut transaction, existing.id, work_hours).await?;
        }
    }

    transaction.commit().await.map_err(internal)?;

    Ok(Success { success: true })
}

async fn replace_work_hours(
    transaction: &mut Transaction<'_, Postgres>,
    report_id: i64,
    entries: Vec<WorkHourInput>,
) -> RpcResult<()> {
    sqlx::query("DELETE FROM daily_project_report_work_hours WHERE report_id = $1")
        .bind(report_id)
        .execute(&mut **transaction)
        .await
        .map_err(internal)?;

    if entries.is_empty() {
        return Ok(());
    }

    let user_ids = entries
        .iter()
        .filter_map(|entry| entry.user_id.map(|id| id.0))
        .collect::<Vec<_>>();
    let user_contracts = sqlx::query_as::<_, UserContractRow>(
        "SELECT id, contract_type FROM users WHERE id = ANY($1)",
    )
    .bind(&user_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(internal)?
    .into_iter()
    .map(|row| (row.id, row.contract_type))
    .collect::<HashMap<_, _>>();

    for entry in entries {
        let contract_type = entry
            .contract_type
            .or_else(|| {
                entry
                    .user_id
                    .and_then(|id| user_contracts.get(&id.0).cloned())
            })
            .unwrap_or_else(|| "external".to_owned());

        sqlx::query(
            r#"
            INSERT INTO daily_project_report_work_hours (
                report_id,
                user_id,
                hours,
                cost_per_hour,
                contract_type
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(report_id)
        .bind(entry.user_id.map(|id| id.0))
        .bind(entry.hours)
        .bind(entry.cost_per_hour)
        .bind(contract_type)
        .execute(&mut **transaction)
        .await
        .map_err(internal)?;
    }

    Ok(())
}

async fn add_photo(
    state: &AppState,
    context: &RequestContext,
    input: PhotoMutationInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:dailyProjectReports").await?;
    let report_id = report_id_for_key(&pool, input.project_id, input.day).await?;

    let valid_file = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM project_files
            WHERE id = $1
              AND project_id = $2
              AND kind = 'image'
              AND status = 'uploaded'
        )
        "#,
    )
    .bind(input.file_id.0)
    .bind(input.project_id.0)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    if !valid_file {
        return Err(bad_request(
            "file must be an uploaded image from this project",
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO daily_project_report_files (report_id, project_file_id)
        VALUES ($1, $2)
        ON CONFLICT (report_id, project_file_id) DO NOTHING
        "#,
    )
    .bind(report_id)
    .bind(input.file_id.0)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn remove_photo(
    state: &AppState,
    context: &RequestContext,
    input: PhotoMutationInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:dailyProjectReports").await?;
    let report_id = report_id_for_key(&pool, input.project_id, input.day).await?;

    let result = sqlx::query(
        "DELETE FROM daily_project_report_files WHERE report_id = $1 AND project_file_id = $2",
    )
    .bind(report_id)
    .bind(input.file_id.0)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn delete(
    state: &AppState,
    context: &RequestContext,
    input: ReportKey,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "delete:dailyProjectReports").await?;

    let result =
        sqlx::query("DELETE FROM daily_project_reports WHERE project_id = $1 AND day = $2")
            .bind(input.project_id.0)
            .bind(input.day.0)
            .execute(&pool)
            .await
            .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn report_id_for_key(pool: &PgPool, project_id: Id, day: WireDate) -> RpcResult<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT id FROM daily_project_reports WHERE project_id = $1 AND day = $2",
    )
    .bind(project_id.0)
    .bind(day.0)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)
}

fn ensure_not_future(day: NaiveDate) -> RpcResult<()> {
    let submitted = day
        .and_hms_opt(0, 0, 0)
        .expect("calendar day always has midnight")
        .and_utc();

    if submitted > Utc::now() + Duration::hours(6) {
        Err(bad_request("Day cannot be in the future."))
    } else {
        Ok(())
    }
}

fn validate_work_hours(entries: &[WorkHourInput]) -> RpcResult<()> {
    for entry in entries {
        if !(0.0..=10.0).contains(&entry.hours) {
            return Err(bad_request("hours must be between 0 and 10"));
        }

        if entry.cost_per_hour.is_some_and(|cost| !cost.is_finite()) {
            return Err(bad_request("costPerHour must be finite"));
        }

        if entry
            .contract_type
            .as_deref()
            .is_some_and(|contract| !matches!(contract, "internal" | "subcontractor" | "external"))
        {
            return Err(bad_request("invalid contractType"));
        }
    }

    Ok(())
}

fn map_write_error(error: sqlx::Error) -> crate::error::RpcError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        conflict()
    } else {
        internal(error)
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
        let day = parse_calendar_date_text(&value)
            .ok_or_else(|| D::Error::custom("invalid calendar date"))?;
        Ok(Self(day))
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

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportListInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    project_id: Option<Id>,

    #[serde(default)]
    #[ts(optional = nullable, type = "Date | null")]
    from: Option<WireDate>,

    #[serde(default)]
    #[ts(optional = nullable, type = "Date | null")]
    to: Option<WireDate>,

    #[serde(default = "default_limit")]
    limit: u64,

    #[serde(default)]
    offset: u64,
}

const fn default_limit() -> u64 {
    1_000
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportKey {
    project_id: Id,

    #[ts(type = "Date")]
    day: WireDate,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoMutationInput {
    project_id: Id,

    #[ts(type = "Date")]
    day: WireDate,

    file_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportCreateInput {
    project_id: Id,

    #[ts(type = "Date")]
    day: WireDate,

    #[serde(default)]
    #[ts(optional = nullable)]
    summary: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    weather: Option<Weather>,

    #[serde(default)]
    work_hours: Vec<WorkHourInput>,
}

impl ReportCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        ensure_not_future(self.day.0)?;
        trim_nullable(&mut self.summary, "summary", 5_000)?;
        validate_work_hours(&self.work_hours)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportUpdateInput {
    project_id: Id,

    #[ts(type = "Date")]
    day: WireDate,

    data: ReportPatch,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportPatch {
    #[serde(default)]
    #[ts(optional, type = "Date")]
    day: Patch<WireDate>,

    #[serde(default)]
    #[ts(optional, type = "string | null")]
    summary: Patch<String>,

    #[serde(default)]
    #[ts(optional, type = "Weather | null")]
    weather: Patch<Weather>,

    #[serde(default)]
    #[ts(optional, type = "Array<WorkHourInput> | null")]
    work_hours: Patch<Vec<WorkHourInput>>,
}

impl ReportPatch {
    fn is_empty(&self) -> bool {
        self.day.is_missing()
            && self.summary.is_missing()
            && self.weather.is_missing()
            && self.work_hours.is_missing()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Weather {
    #[serde(default)]
    #[ts(optional = nullable)]
    summary: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    temperature_c: Option<f64>,

    #[serde(default)]
    #[ts(optional = nullable)]
    precipitation_mm: Option<f64>,

    #[serde(default)]
    #[ts(optional = nullable)]
    wind_kph: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkHourInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    user_id: Option<Id>,

    hours: f64,
    cost_per_hour: Option<f64>,

    #[serde(default)]
    #[ts(optional = nullable)]
    contract_type: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DailyReport {
    id: Id,
    project_id: Id,

    #[ts(type = "Date")]
    day: WireDate,

    summary: Option<String>,
    weather: Option<Weather>,
    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    work_hours: Vec<WorkHour>,
    photos: Vec<ProjectFile>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct WorkHour {
    id: Id,
    report_id: Id,
    user_id: Option<Id>,
    hours: f64,
    cost_per_hour: Option<f64>,
    contract_type: String,
}

#[derive(FromRow)]
struct DailyReportRow {
    id: i64,
    project_id: i64,
    day: NaiveDate,
    summary: Option<String>,
    weather: Option<Json<Weather>>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct WorkHourRow {
    id: i64,
    report_id: i64,
    user_id: Option<i64>,
    hours: f64,
    cost_per_hour: Option<f64>,
    contract_type: String,
}

impl From<WorkHourRow> for WorkHour {
    fn from(row: WorkHourRow) -> Self {
        Self {
            id: Id(row.id),
            report_id: Id(row.report_id),
            user_id: row.user_id.map(Id),
            hours: row.hours,
            cost_per_hour: row.cost_per_hour,
            contract_type: row.contract_type,
        }
    }
}

#[derive(FromRow)]
struct ReportWritable {
    id: i64,
    day: NaiveDate,
    summary: Option<String>,
    weather: Option<Json<Weather>>,
}

#[derive(FromRow)]
struct UserContractRow {
    id: i64,
    contract_type: String,
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};

    use super::{WireDate, WorkHourInput, ensure_not_future, validate_work_hours};

    #[test]
    fn rejects_future_reports_and_invalid_work_hours() {
        let future = (Utc::now() + Duration::days(2)).date_naive();
        assert!(ensure_not_future(future).is_err());

        let entries = vec![WorkHourInput {
            user_id: None,
            hours: 10.5,
            cost_per_hour: None,
            contract_type: Some("external".to_owned()),
        }];

        assert!(validate_work_hours(&entries).is_err());

        let wire: WireDate =
            serde_json::from_str("\"2026-08-25T00:00:00.000Z\"").expect("wire date");
        assert_eq!(wire.0.to_string(), "2026-08-25");
    }
}
