//! Weekly regie reports and their material-cost projection.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgPool};

use super::common::{
    authorized_pool, bad_request, input_date, input_id, input_object, input_string, internal,
    not_found, optional_input_date, optional_input_id, optional_input_string, wire_date,
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
    builder = builder.query_json("regieReports.list", move |context, input| {
        let state = Arc::clone(&list_state);

        async move { list(&state, &context, input).await }
    });

    let get_state = Arc::clone(&state);
    builder = builder.query_json("regieReports.get", move |context, input| {
        let state = Arc::clone(&get_state);

        async move { get(&state, &context, input).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("regieReports.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create(&state, &context, input).await }
    });

    let update_state = Arc::clone(&state);
    builder = builder.mutation_json("regieReports.update", move |context, input| {
        let state = Arc::clone(&update_state);

        async move { update(&state, &context, input).await }
    });

    let delete_state = Arc::clone(&state);
    builder = builder.mutation_json("regieReports.delete", move |context, input| {
        let state = Arc::clone(&delete_state);

        async move { delete(&state, &context, input).await }
    });

    builder.query_json("regieReports.costs.get", move |context, input| {
        let state = Arc::clone(&state);

        async move { costs(&state, &context, input).await }
    })
}

#[derive(FromRow)]
struct ReportRow {
    id: i64,
    project_id: i64,
    day: NaiveDate,
    summary: Option<String>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    auto_id: i64,
}

#[derive(FromRow)]
struct ProductRow {
    id: i64,
    report_id: i64,
    product_id: i64,
    quantity: f64,
    comment: Option<String>,
}

#[derive(FromRow)]
struct SpecialRow {
    id: i64,
    report_id: i64,
    name: String,
    unit: String,
    amount: f64,
    comment: Option<String>,
}

#[derive(FromRow)]
struct WorkHourRow {
    id: i64,
    report_id: i64,
    user_id: Option<i64>,
    day: NaiveDate,
    hours: f64,
}

async fn list(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:regieReports").await?;
    let input = input_object(&input)?;

    let project_id = optional_input_id(input, "projectId")?;
    let day_from = optional_input_date(input, "dayFrom")?;
    let day_to = optional_input_date(input, "dayTo")?;
    let limit = input.get("limit").and_then(Value::as_i64).unwrap_or(1_000);
    let offset = input.get("offset").and_then(Value::as_i64).unwrap_or(0);

    if limit <= 0 || offset < 0 {
        return Err(bad_request("invalid pagination"));
    }

    // Number reports before applying filters so autoId remains the stable
    // project-relative sequence number used by the former implementation.
    let reports = sqlx::query_as::<_, ReportRow>(
        r#"
        WITH numbered AS (
            SELECT
                id,
                project_id,
                day,
                summary,
                created_by_user_id,
                created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id
                    ORDER BY day, id
                ) AS auto_id
            FROM regie_reports
        )
        SELECT *
        FROM numbered
        WHERE ($1::bigint IS NULL OR project_id = $1)
          AND ($2::date IS NULL OR day >= $2)
          AND ($3::date IS NULL OR day <= $3)
        ORDER BY day DESC, id DESC
        LIMIT $4
        OFFSET $5
        "#,
    )
    .bind(project_id)
    .bind(day_from)
    .bind(day_to)
    .bind(limit)
    .bind(offset)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    load_complete_reports(&pool, reports).await
}

async fn get(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:regieReports").await?;
    let report_id = input_id(input_object(&input)?, "id")?;

    let report = sqlx::query_as::<_, ReportRow>(
        r#"
        WITH numbered AS (
            SELECT
                id,
                project_id,
                day,
                summary,
                created_by_user_id,
                created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id
                    ORDER BY day, id
                ) AS auto_id
            FROM regie_reports
        )
        SELECT *
        FROM numbered
        WHERE id = $1
        "#,
    )
    .bind(report_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    let mut reports = load_complete_reports(&pool, vec![report]).await?;
    reports
        .as_array_mut()
        .and_then(Vec::pop)
        .ok_or_else(not_found)
}

async fn load_complete_reports(pool: &PgPool, reports: Vec<ReportRow>) -> RpcResult<Value> {
    if reports.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }

    let report_ids: Vec<i64> = reports.iter().map(|report| report.id).collect();
    let products = sqlx::query_as::<_, ProductRow>(
        r#"
        SELECT id, report_id, product_id, quantity, comment
        FROM regie_report_products
        WHERE report_id = ANY($1)
        "#,
    )
    .bind(&report_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    let specials = sqlx::query_as::<_, SpecialRow>(
        r#"
        SELECT id, report_id, name, unit, amount, comment
        FROM regie_report_special_records
        WHERE report_id = ANY($1)
        "#,
    )
    .bind(&report_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    let work_hours = sqlx::query_as::<_, WorkHourRow>(
        r#"
        SELECT id, report_id, user_id, day, hours
        FROM regie_report_work_hours
        WHERE report_id = ANY($1)
        "#,
    )
    .bind(&report_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let mut products_by_report: HashMap<i64, Vec<Value>> = HashMap::new();
    for product in products {
        products_by_report
            .entry(product.report_id)
            .or_default()
            .push(product_value(product));
    }

    let mut specials_by_report: HashMap<i64, Vec<Value>> = HashMap::new();
    for special in specials {
        specials_by_report
            .entry(special.report_id)
            .or_default()
            .push(special_value(special));
    }

    let mut hours_by_report: HashMap<i64, Vec<Value>> = HashMap::new();
    for hours in work_hours {
        hours_by_report
            .entry(hours.report_id)
            .or_default()
            .push(work_hour_value(hours));
    }

    let values = reports
        .into_iter()
        .map(|report| {
            let report_id = report.id;

            json!({
                "id": Id(report_id),
                "projectId": Id(report.project_id),
                "day": wire_date(report.day),
                "summary": report.summary,
                "createdByUserId": report.created_by_user_id.map(Id),
                "createdAt": report.created_at,
                "autoId": report.auto_id,
                "products": products_by_report.remove(&report_id).unwrap_or_default(),
                "specialRecords": specials_by_report.remove(&report_id).unwrap_or_default(),
                "workHours": hours_by_report.remove(&report_id).unwrap_or_default(),
            })
        })
        .collect();

    Ok(Value::Array(values))
}

fn product_value(row: ProductRow) -> Value {
    json!({
        "id": Id(row.id),
        "reportId": Id(row.report_id),
        "productId": Id(row.product_id),
        "quantity": row.quantity,
        "comment": row.comment,
    })
}

fn special_value(row: SpecialRow) -> Value {
    json!({
        "id": Id(row.id),
        "reportId": Id(row.report_id),
        "name": row.name,
        "unit": row.unit,
        "amount": row.amount,
        "comment": row.comment,
    })
}

fn work_hour_value(row: WorkHourRow) -> Value {
    json!({
        "id": Id(row.id),
        "reportId": Id(row.report_id),
        "userId": row.user_id.map(Id),
        "day": wire_date(row.day),
        "hours": row.hours,
    })
}

async fn create(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authorized_pool(state, context, "manage:regieReports").await?;
    let input = input_object(&input)?;

    let project_id = input_id(input, "projectId")?;
    let selected_day = input_date(input, "day")?;
    let report_day = start_of_iso_week(selected_day);
    let summary = nullable_text(input, "summary", 4_095)?;
    let products = parse_products(input.get("products"))?;
    let specials = parse_specials(input.get("specialRecords"))?;
    let work_hours = parse_work_hours(input.get("workHours"))?;

    if products.is_empty() && specials.is_empty() && work_hours.is_empty() {
        return Err(bad_request("at least one record is required"));
    }
    validate_report_dates(selected_day, report_day, &work_hours)?;

    let created_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    let report_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO regie_reports (
            project_id,
            day,
            summary,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
    )
    .bind(project_id)
    .bind(report_day)
    .bind(summary)
    .bind(created_by_user_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;

    replace_products(&mut transaction, report_id, products, false).await?;
    replace_specials(&mut transaction, report_id, specials, false).await?;
    replace_work_hours(&mut transaction, report_id, work_hours, false).await?;

    transaction.commit().await.map_err(internal)?;

    Ok(json!({ "id": Id(report_id) }))
}

async fn update(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:regieReports").await?;
    let input = input_object(&input)?;
    let report_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let changes_day = changes.contains_key("day");
    let changes_summary = changes.contains_key("summary");
    let changes_products = changes.contains_key("products");
    let changes_specials = changes.contains_key("specialRecords");
    let changes_hours = changes.contains_key("workHours");

    if changes_day && !changes_hours {
        // Moving a weekly report without moving its dated hour rows would
        // create an internally inconsistent report.
        return Err(bad_request("workHours required when changing day"));
    }
    if !changes_day && !changes_summary && !changes_products && !changes_specials && !changes_hours
    {
        return Err(bad_request("empty update"));
    }

    let current_day: Option<NaiveDate> =
        sqlx::query_scalar("SELECT day FROM regie_reports WHERE id = $1")
            .bind(report_id)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?;
    let current_day = current_day.ok_or_else(not_found)?;

    let selected_day = if changes_day {
        input_date(changes, "day")?
    } else {
        current_day
    };
    let report_day = start_of_iso_week(selected_day);
    let work_hours = if changes_hours {
        Some(parse_work_hours(changes.get("workHours"))?)
    } else {
        None
    };

    if let Some(work_hours) = &work_hours {
        validate_report_dates(selected_day, report_day, work_hours)?;
    } else if is_future(selected_day) {
        return Err(bad_request("day cannot be in the future"));
    }

    let summary = if changes_summary {
        Some(nullable_text(changes, "summary", 4_095)?)
    } else {
        None
    };
    let products = if changes_products {
        Some(parse_products(changes.get("products"))?)
    } else {
        None
    };
    let specials = if changes_specials {
        Some(parse_specials(changes.get("specialRecords"))?)
    } else {
        None
    };

    let mut transaction = pool.begin().await.map_err(internal)?;

    if changes_day || changes_summary {
        sqlx::query(
            r#"
            UPDATE regie_reports
            SET
                day = CASE WHEN $2 THEN $3 ELSE day END,
                summary = CASE WHEN $4 THEN $5 ELSE summary END
            WHERE id = $1
            "#,
        )
        .bind(report_id)
        .bind(changes_day)
        .bind(report_day)
        .bind(changes_summary)
        .bind(summary.flatten())
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    }

    if let Some(products) = products {
        replace_products(&mut transaction, report_id, products, true).await?;
    }
    if let Some(specials) = specials {
        replace_specials(&mut transaction, report_id, specials, true).await?;
    }
    if let Some(work_hours) = work_hours {
        replace_work_hours(&mut transaction, report_id, work_hours, true).await?;
    }

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

async fn delete(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:regieReports").await?;
    let report_id = input_id(input_object(&input)?, "id")?;

    let result = sqlx::query("DELETE FROM regie_reports WHERE id = $1")
        .bind(report_id)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(success())
}

struct ProductInput {
    product_id: i64,
    quantity: f64,
    comment: Option<String>,
}

struct SpecialInput {
    name: String,
    unit: String,
    amount: f64,
    comment: Option<String>,
}

struct WorkHourInput {
    user_id: Option<i64>,
    day: NaiveDate,
    hours: f64,
}

fn parse_products(value: Option<&Value>) -> RpcResult<Vec<ProductInput>> {
    parse_array(value, "products", |value| {
        let value = input_object(value)?;

        Ok(ProductInput {
            product_id: input_id(value, "productId")?,
            quantity: require_number(value, "quantity")?,
            comment: nullable_text(value, "comment", 255)?,
        })
    })
}

fn parse_specials(value: Option<&Value>) -> RpcResult<Vec<SpecialInput>> {
    parse_array(value, "specialRecords", |value| {
        let value = input_object(value)?;

        Ok(SpecialInput {
            name: required_text(value, "name", 255)?,
            unit: required_text(value, "unit", 32)?,
            amount: require_number(value, "amount")?,
            comment: nullable_text(value, "comment", 255)?,
        })
    })
}

fn parse_work_hours(value: Option<&Value>) -> RpcResult<Vec<WorkHourInput>> {
    parse_array(value, "workHours", |value| {
        let value = input_object(value)?;
        let hours = require_number(value, "hours")?;
        if !(0.0..=10.0).contains(&hours) {
            return Err(bad_request("hours must be between 0 and 10"));
        }

        Ok(WorkHourInput {
            user_id: optional_input_id(value, "userId")?,
            day: input_date(value, "day")?,
            hours,
        })
    })
}

fn parse_array<T>(
    value: Option<&Value>,
    field: &str,
    parse: impl Fn(&Value) -> RpcResult<T>,
) -> RpcResult<Vec<T>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }

    value
        .as_array()
        .ok_or_else(|| bad_request(format!("invalid {field}")))?
        .iter()
        .map(parse)
        .collect()
}

async fn replace_products(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    report_id: i64,
    products: Vec<ProductInput>,
    delete_existing: bool,
) -> RpcResult<()> {
    if delete_existing {
        sqlx::query("DELETE FROM regie_report_products WHERE report_id = $1")
            .bind(report_id)
            .execute(&mut **transaction)
            .await
            .map_err(internal)?;
    }

    for product in products {
        sqlx::query(
            r#"
            INSERT INTO regie_report_products (
                report_id,
                product_id,
                quantity,
                comment
            )
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(report_id)
        .bind(product.product_id)
        .bind(product.quantity)
        .bind(product.comment)
        .execute(&mut **transaction)
        .await
        .map_err(internal)?;
    }

    Ok(())
}

async fn replace_specials(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    report_id: i64,
    specials: Vec<SpecialInput>,
    delete_existing: bool,
) -> RpcResult<()> {
    if delete_existing {
        sqlx::query("DELETE FROM regie_report_special_records WHERE report_id = $1")
            .bind(report_id)
            .execute(&mut **transaction)
            .await
            .map_err(internal)?;
    }

    for special in specials {
        sqlx::query(
            r#"
            INSERT INTO regie_report_special_records (
                report_id,
                name,
                unit,
                amount,
                comment
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(report_id)
        .bind(special.name)
        .bind(special.unit)
        .bind(special.amount)
        .bind(special.comment)
        .execute(&mut **transaction)
        .await
        .map_err(internal)?;
    }

    Ok(())
}

async fn replace_work_hours(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    report_id: i64,
    work_hours: Vec<WorkHourInput>,
    delete_existing: bool,
) -> RpcResult<()> {
    if delete_existing {
        sqlx::query("DELETE FROM regie_report_work_hours WHERE report_id = $1")
            .bind(report_id)
            .execute(&mut **transaction)
            .await
            .map_err(internal)?;
    }

    for work_hour in work_hours {
        sqlx::query(
            r#"
            INSERT INTO regie_report_work_hours (
                report_id,
                user_id,
                day,
                hours
            )
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(report_id)
        .bind(work_hour.user_id)
        .bind(work_hour.day)
        .bind(work_hour.hours)
        .execute(&mut **transaction)
        .await
        .map_err(internal)?;
    }

    Ok(())
}

fn start_of_iso_week(day: NaiveDate) -> NaiveDate {
    day - Duration::days(i64::from(day.weekday().num_days_from_monday()))
}

fn is_future(day: NaiveDate) -> bool {
    day > (Utc::now() + Duration::hours(6)).date_naive()
}

fn validate_report_dates(
    selected_day: NaiveDate,
    week_start: NaiveDate,
    work_hours: &[WorkHourInput],
) -> RpcResult<()> {
    if is_future(selected_day) {
        return Err(bad_request("day cannot be in the future"));
    }

    for work_hour in work_hours {
        let day_offset = (work_hour.day - week_start).num_days();
        if !(0..7).contains(&day_offset) {
            return Err(bad_request("work-hour day must be inside selected week"));
        }
        if is_future(work_hour.day) {
            return Err(bad_request("work-hour day cannot be in the future"));
        }
    }

    Ok(())
}

#[derive(FromRow)]
struct LatestPriceRow {
    product_id: i64,
    id: i64,
    vendor_id: Option<i64>,
    timestamp: DateTime<Utc>,
    price: f64,
    is_real_purchase: bool,
    comment: Option<String>,
}

async fn costs(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:regieReports").await?;
    let report_id = input_id(input_object(&input)?, "id")?;

    let report_day: Option<NaiveDate> =
        sqlx::query_scalar("SELECT day FROM regie_reports WHERE id = $1")
            .bind(report_id)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?;
    let report_day = report_day.ok_or_else(not_found)?;

    let products = sqlx::query_as::<_, ProductRow>(
        r#"
        SELECT id, report_id, product_id, quantity, comment
        FROM regie_report_products
        WHERE report_id = $1
        "#,
    )
    .bind(report_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let product_ids: Vec<i64> = products.iter().map(|row| row.product_id).collect();

    let end_of_week = report_day + Duration::days(7);
    let latest_prices = if product_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, LatestPriceRow>(
            r#"
            SELECT DISTINCT ON (product_id)
                product_id,
                id,
                vendor_id,
                timestamp,
                price,
                is_real_purchase,
                comment
            FROM product_price_records
            WHERE product_id = ANY($1)
              AND timestamp <= $2::date
            ORDER BY product_id, timestamp DESC
            "#,
        )
        .bind(product_ids)
        .bind(end_of_week)
        .fetch_all(&pool)
        .await
        .map_err(internal)?
    };
    let prices_by_product: HashMap<i64, LatestPriceRow> = latest_prices
        .into_iter()
        .map(|price| (price.product_id, price))
        .collect();

    let mut total_cost = 0.0;
    let product_costs: Vec<Value> = products
        .into_iter()
        .map(|product| {
            let price = prices_by_product.get(&product.product_id);
            total_cost += product.quantity * price.map(|price| price.price).unwrap_or(0.0);

            json!({
                "recordId": Id(product.id),
                "productId": Id(product.product_id),
                "quantity": product.quantity,
                "priceRecord": price.map(price_value),
            })
        })
        .collect();

    let specials = sqlx::query_as::<_, SpecialRow>(
        r#"
        SELECT id, report_id, name, unit, amount, comment
        FROM regie_report_special_records
        WHERE report_id = $1
        "#,
    )
    .bind(report_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let special_costs: Vec<Value> = specials
        .into_iter()
        .map(|special| {
            json!({
                "recordId": Id(special.id),
                "name": special.name,
                "unit": special.unit,
                "amount": special.amount,
                "comment": special.comment,
            })
        })
        .collect();

    let work_hours = sqlx::query_as::<_, WorkHourRow>(
        r#"
        SELECT id, report_id, user_id, day, hours
        FROM regie_report_work_hours
        WHERE report_id = $1
        "#,
    )
    .bind(report_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let work_hour_costs: Vec<Value> = work_hours
        .into_iter()
        .map(|work_hour| {
            json!({
                "recordId": Id(work_hour.id),
                "userId": work_hour.user_id.map(Id),
                "day": wire_date(work_hour.day),
                "hours": work_hour.hours,
            })
        })
        .collect();

    Ok(json!({
        "reportId": Id(report_id),
        "totalCost": total_cost,
        "products": product_costs,
        "specialRecords": special_costs,
        "workHours": work_hour_costs,
    }))
}

fn price_value(price: &LatestPriceRow) -> Value {
    json!({
        "id": Id(price.id),
        "productId": Id(price.product_id),
        "vendorId": price.vendor_id.map(Id),
        "timestamp": price.timestamp,
        "price": price.price,
        "isRealPurchase": price.is_real_purchase,
        "comment": price.comment,
    })
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

fn require_number(input: &Map<String, Value>, key: &str) -> RpcResult<f64> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad_request(format!("missing {key}")))
}

fn success() -> Value {
    json!({ "success": true })
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, NaiveDate, Utc};

    use super::{is_future, start_of_iso_week};

    #[test]
    fn normalizes_report_days_to_iso_monday() {
        let thursday = NaiveDate::from_ymd_opt(2026, 8, 27).unwrap();
        let monday = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();

        assert_eq!(start_of_iso_week(thursday), monday);
    }

    #[test]
    fn rejects_dates_well_into_the_future() {
        let future = Utc::now().date_naive() + Duration::days(2);

        assert!(is_future(future));
    }
}
