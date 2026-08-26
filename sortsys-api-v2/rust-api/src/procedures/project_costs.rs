//! Project financial entries and time-effective cost reporting.
//!
//! Cost queries are set-based: product prices and common-cost factors are
//! selected at each note/report's effective date inside PostgreSQL. This avoids
//! the per-record database round trips that dominated the former implementation.

use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, types::Json};
use ts_rs::TS;

use super::common::{
    Address, authorized_pool, bad_request, input_id, input_object, internal, not_found,
    optional_input_id, optional_input_string, trim_nullable,
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
    let create_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.costs.entries.create",
        move |context, mut input: FinancialEntryCreateInput| {
            let state = Arc::clone(&create_state);

            async move {
                input.normalize()?;
                create_entry(&state, &context, input).await
            }
        },
    );

    let update_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.costs.entries.update",
        move |context, mut input: FinancialEntryUpdateInput| {
            let state = Arc::clone(&update_state);

            async move {
                input.data.normalize()?;
                update_entry(&state, &context, input).await
            }
        },
    );

    let delete_state = Arc::clone(&state);
    builder = builder.mutation(
        "projects.costs.entries.delete",
        move |context, input: FinancialEntryKey| {
            let state = Arc::clone(&delete_state);

            async move { delete_entry(&state, &context, input).await }
        },
    );

    let filter_state = Arc::clone(&state);
    builder = builder.query_json("projects.costs.filterOptions", move |context, _| {
        let state = Arc::clone(&filter_state);

        async move { filter_options(&state, &context).await }
    });

    let overview_state = Arc::clone(&state);
    builder = builder.query_json("projects.costs.overview", move |context, input| {
        let state = Arc::clone(&overview_state);

        async move { overview(&state, &context, input).await }
    });

    builder.query_json("projects.costs.get", move |context, input| {
        let state = Arc::clone(&state);

        async move { get(&state, &context, input).await }
    })
}

async fn create_entry(
    state: &AppState,
    context: &RequestContext,
    input: FinancialEntryCreateInput,
) -> RpcResult<Success> {
    let (auth, pool) = authorized_pool(state, context, "manage:projects").await?;
    let creator_id = auth.user.id.parse::<i64>().map_err(internal)?;

    ensure_project_exists(&pool, input.project_id).await?;

    sqlx::query(
        r#"
        INSERT INTO project_financial_entries (
            project_id,
            type,
            amount,
            comment,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.entry_type)
    .bind(input.amount)
    .bind(input.comment)
    .bind(creator_id)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(Success { success: true })
}

async fn update_entry(
    state: &AppState,
    context: &RequestContext,
    input: FinancialEntryUpdateInput,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    let result = sqlx::query(
        r#"
        UPDATE project_financial_entries
        SET amount = $3, comment = $4
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(input.id.0)
    .bind(input.project_id.0)
    .bind(input.data.amount)
    .bind(input.data.comment)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn delete_entry(
    state: &AppState,
    context: &RequestContext,
    input: FinancialEntryKey,
) -> RpcResult<Success> {
    let (_, pool) = authorized_pool(state, context, "manage:projects").await?;

    let result =
        sqlx::query("DELETE FROM project_financial_entries WHERE id = $1 AND project_id = $2")
            .bind(input.id.0)
            .bind(input.project_id.0)
            .execute(&pool)
            .await
            .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn filter_options(state: &AppState, context: &RequestContext) -> RpcResult<Value> {
    let (_, pool) = cost_overview_pool(state, context).await?;

    let years = sqlx::query_scalar::<_, i32>(
        r#"
        SELECT DISTINCT EXTRACT(YEAR FROM finished_at)::integer
        FROM projects
        WHERE finished_at IS NOT NULL
        ORDER BY 1 DESC
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let leaders = sqlx::query_as::<_, ProjectLeaderRow>(
        r#"
        SELECT user_account.id, user_account.first_name, user_account.last_name
        FROM users AS user_account
        WHERE EXISTS (
            SELECT 1
            FROM projects AS project
            WHERE project.responsible_project_leader_user_id = user_account.id
        )
        ORDER BY
            LOWER(COALESCE(user_account.last_name, '')),
            LOWER(user_account.first_name),
            user_account.id
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({
        "finishingYears": years,
        "projectLeaders": leaders
            .into_iter()
            .map(|leader| json!({
                "id": Id(leader.id),
                "firstName": leader.first_name,
                "lastName": leader.last_name,
            }))
            .collect::<Vec<_>>(),
    }))
}

async fn overview(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = cost_overview_pool(state, context).await?;
    let input = input.as_object();

    let status = input
        .and_then(|input| optional_input_string(input, "status"))
        .unwrap_or("active");
    if !matches!(status, "active" | "finished" | "all") {
        return Err(bad_request("invalid status"));
    }

    let closing_year = input
        .and_then(|input| input.get("closingYear"))
        .and_then(Value::as_i64);
    if closing_year.is_some_and(|year| !(1900..=3000).contains(&year)) {
        return Err(bad_request("invalid closingYear"));
    }

    let leader_id = input
        .map(|input| optional_input_id(input, "responsibleProjectLeaderUserId"))
        .transpose()?
        .flatten();

    let rows = sqlx::query_as::<_, OverviewRow>(
        r#"
        WITH project_scope AS (
            SELECT
                project.id,
                project.title,
                project.address,
                project.finished_at,
                project.responsible_project_leader_user_id
            FROM projects AS project
            WHERE (
                $1 = 'all'
                OR ($1 = 'active' AND project.finished_at IS NULL)
                OR ($1 = 'finished' AND project.finished_at IS NOT NULL)
            )
              AND (
                  $2::integer IS NULL
                  OR (
                      project.finished_at >= make_date($2, 1, 1)
                      AND project.finished_at < make_date($2 + 1, 1, 1)
                  )
              )
              AND (
                  $3::bigint IS NULL
                  OR project.responsible_project_leader_user_id = $3
              )
        ),
        financial AS (
            SELECT
                entry.project_id,
                COALESCE(SUM(entry.amount) FILTER (WHERE entry.type = 'offer'), 0) AS offers_total,
                COALESCE(SUM(entry.amount) FILTER (WHERE entry.type = 'invoice'), 0) AS invoices_total,
                COUNT(*) FILTER (WHERE entry.type = 'invoice') AS invoice_count
            FROM project_financial_entries AS entry
            WHERE entry.project_id IN (SELECT id FROM project_scope)
            GROUP BY entry.project_id
        ),
        material_note AS (
            SELECT
                note.id,
                note.project_id,
                note.effective_timestamp,
                COALESCE(product_cost.base_cost, 0) + COALESCE(special_cost.base_cost, 0) AS base_cost,
                COALESCE(product_cost.record_count, 0) + COALESCE(special_cost.record_count, 0) AS record_count
            FROM product_delivery_notes AS note
            LEFT JOIN LATERAL (
                SELECT
                    COALESCE(SUM(record.quantity * COALESCE(price.price, 0)), 0) AS base_cost,
                    COUNT(*) AS record_count
                FROM product_delivery_records AS record
                LEFT JOIN LATERAL (
                    SELECT price_record.price
                    FROM product_price_records AS price_record
                    WHERE price_record.product_id = record.product_id
                      AND price_record."timestamp" <= note.effective_timestamp
                    ORDER BY price_record."timestamp" DESC
                    LIMIT 1
                ) AS price ON TRUE
                WHERE record.note_id = note.id
            ) AS product_cost ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    COALESCE(SUM(record.amount * COALESCE(record.price_per_unit, 0)), 0) AS base_cost,
                    COUNT(*) AS record_count
                FROM product_delivery_special_records AS record
                WHERE record.note_id = note.id
            ) AS special_cost ON TRUE
            WHERE note.project_id IN (SELECT id FROM project_scope)
        ),
        material AS (
            SELECT
                note.project_id,
                COALESCE(SUM(note.base_cost), 0) AS base_cost,
                COALESCE(SUM(
                    CASE WHEN note.record_count > 0
                    THEN note.base_cost * COALESCE(common.relative_factor, 0)
                         + COALESCE(common.constant, 0)
                    ELSE 0 END
                ), 0) AS overhead
            FROM material_note AS note
            LEFT JOIN LATERAL (
                SELECT entry.relative_factor, entry.constant
                FROM global_common_cost_entries AS entry
                WHERE entry.type = 'mgk'
                  AND entry.effective_at <= note.effective_timestamp
                ORDER BY entry.effective_at DESC
                LIMIT 1
            ) AS common ON TRUE
            GROUP BY note.project_id
        ),
        report_base AS (
            SELECT
                report.id,
                report.project_id,
                report.day,
                COALESCE(SUM(hours.hours * COALESCE(hours.cost_per_hour, 0))
                    FILTER (WHERE hours.contract_type = 'internal'), 0) AS internal_cost,
                COUNT(hours.id) FILTER (WHERE hours.contract_type = 'internal') AS internal_count,
                COALESCE(SUM(hours.hours * COALESCE(hours.cost_per_hour, 0))
                    FILTER (WHERE hours.contract_type = 'subcontractor'), 0) AS subcontractor_cost,
                COUNT(hours.id) FILTER (WHERE hours.contract_type = 'subcontractor') AS subcontractor_count
            FROM daily_project_reports AS report
            LEFT JOIN daily_project_report_work_hours AS hours
                ON hours.report_id = report.id
            WHERE report.project_id IN (SELECT id FROM project_scope)
            GROUP BY report.id
        ),
        labor AS (
            SELECT
                report.project_id,
                COALESCE(SUM(report.internal_cost + report.subcontractor_cost), 0) AS base_cost,
                COALESCE(SUM(
                    CASE WHEN report.internal_count > 0
                    THEN report.internal_cost * COALESCE(fgk.relative_factor, 0)
                         + COALESCE(fgk.constant, 0)
                    ELSE 0 END
                ), 0)
                + COALESCE(SUM(
                    CASE WHEN report.subcontractor_count > 0
                    THEN report.subcontractor_cost * COALESCE(ngk.relative_factor, 0)
                         + COALESCE(ngk.constant, 0)
                    ELSE 0 END
                ), 0) AS overhead
            FROM report_base AS report
            LEFT JOIN LATERAL (
                SELECT entry.relative_factor, entry.constant
                FROM global_common_cost_entries AS entry
                WHERE entry.type = 'fgk'
                  AND entry.effective_at <= report.day
                ORDER BY entry.effective_at DESC
                LIMIT 1
            ) AS fgk ON TRUE
            LEFT JOIN LATERAL (
                SELECT entry.relative_factor, entry.constant
                FROM global_common_cost_entries AS entry
                WHERE entry.type = 'ngk'
                  AND entry.effective_at <= report.day
                ORDER BY entry.effective_at DESC
                LIMIT 1
            ) AS ngk ON TRUE
            GROUP BY report.project_id
        ),
        tools AS (
            SELECT
                tracking.project_id,
                COALESCE(SUM(
                    GREATEST(
                        DATE_TRUNC('day', COALESCE(tracking.ended_at, NOW()))::date
                        - DATE_TRUNC('day', tracking.started_at)::date
                        + 1,
                        0
                    ) * COALESCE(tracking.tool_usage_cost_per_day, 0)
                ), 0) AS total
            FROM tool_trackings AS tracking
            WHERE tracking.project_id IN (SELECT id FROM project_scope)
            GROUP BY tracking.project_id
        )
        SELECT
            project.id,
            project.title,
            project.address,
            project.finished_at,
            project.responsible_project_leader_user_id,
            COALESCE(financial.offers_total, 0) AS offers_total,
            COALESCE(financial.invoices_total, 0) AS invoices_total,
            COALESCE(financial.invoice_count, 0) AS invoice_count,
            COALESCE(material.base_cost, 0)
                + COALESCE(material.overhead, 0)
                + COALESCE(labor.base_cost, 0)
                + COALESCE(labor.overhead, 0)
                + COALESCE(tools.total, 0) AS costs
        FROM project_scope AS project
        LEFT JOIN financial ON financial.project_id = project.id
        LEFT JOIN material ON material.project_id = project.id
        LEFT JOIN labor ON labor.project_id = project.id
        LEFT JOIN tools ON tools.project_id = project.id
        ORDER BY costs DESC, LOWER(project.title), project.id
        "#,
    )
    .bind(status)
    .bind(closing_year.map(|year| year as i32))
    .bind(leader_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter()
            .map(|row| {
                json!({
                    "projectId": Id(row.id),
                    "title": row.title,
                    "address": row.address.map(|address| address.0),
                    "costs": row.costs,
                    "offersTotal": row.offers_total,
                    "invoicesTotal": row.invoices_total,
                    "gainOrLoss": (row.invoice_count > 0)
                        .then_some(row.invoices_total - row.costs),
                    "hasInvoices": row.invoice_count > 0,
                    "finishedAt": row.finished_at,
                    "responsibleProjectLeaderUserId":
                        row.responsible_project_leader_user_id.map(Id),
                })
            })
            .collect(),
    ))
}

async fn get(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:projects").await?;
    let input = input_object(&input)?;
    let project_id = input_id(input, "projectId")?;
    let from = parse_optional_timestamp(input.get("from"), "from")?;
    let to = parse_optional_timestamp(input.get("to"), "to")?;

    let financial_entries = sqlx::query_as::<_, FinancialEntryRow>(
        r#"
        SELECT id, project_id, type, amount, comment, created_by_user_id, created_at
        FROM project_financial_entries
        WHERE project_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at <= $3)
        ORDER BY created_at DESC, id DESC
        "#,
    )
    .bind(project_id)
    .bind(from)
    .bind(to)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let delivery_notes = sqlx::query_as::<_, DeliveryCostRow>(
        r#"
        SELECT
            note.id AS note_id,
            note.auto_id,
            note.effective_timestamp,
            COALESCE(product_cost.total_cost, 0)
                + COALESCE(special_cost.total_cost, 0) AS total_cost,
            COALESCE(product_cost.record_count, 0)
                + COALESCE(special_cost.record_count, 0) AS record_count
        FROM product_delivery_notes AS note
        LEFT JOIN LATERAL (
            SELECT
                COALESCE(SUM(record.quantity * COALESCE(price.price, 0)), 0) AS total_cost,
                COUNT(*) AS record_count
            FROM product_delivery_records AS record
            LEFT JOIN LATERAL (
                SELECT price_record.price
                FROM product_price_records AS price_record
                WHERE price_record.product_id = record.product_id
                  AND price_record."timestamp" <= note.effective_timestamp
                ORDER BY price_record."timestamp" DESC
                LIMIT 1
            ) AS price ON TRUE
            WHERE record.note_id = note.id
        ) AS product_cost ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                COALESCE(SUM(record.amount * COALESCE(record.price_per_unit, 0)), 0) AS total_cost,
                COUNT(*) AS record_count
            FROM product_delivery_special_records AS record
            WHERE record.note_id = note.id
        ) AS special_cost ON TRUE
        WHERE note.project_id = $1
          AND ($2::timestamptz IS NULL OR note.effective_timestamp >= $2)
          AND ($3::timestamptz IS NULL OR note.effective_timestamp <= $3)
        ORDER BY note.effective_timestamp DESC, note.id DESC
        "#,
    )
    .bind(project_id)
    .bind(from)
    .bind(to)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let products = sqlx::query_as::<_, ProductCostRow>(
        r#"
        WITH note AS (
            SELECT id, effective_timestamp
            FROM product_delivery_notes
            WHERE project_id = $1
              AND ($2::timestamptz IS NULL OR effective_timestamp >= $2)
              AND ($3::timestamptz IS NULL OR effective_timestamp <= $3)
        ),
        priced AS (
            SELECT
                record.product_id,
                record.quantity,
                price.id AS price_id,
                price.vendor_id,
                price."timestamp" AS price_timestamp,
                price.price,
                price.is_real_purchase,
                price.comment
            FROM note
            INNER JOIN product_delivery_records AS record
                ON record.note_id = note.id
            LEFT JOIN LATERAL (
                SELECT price_record.*
                FROM product_price_records AS price_record
                WHERE price_record.product_id = record.product_id
                  AND price_record."timestamp" <= note.effective_timestamp
                ORDER BY price_record."timestamp" DESC
                LIMIT 1
            ) AS price ON TRUE
        )
        SELECT
            product_id,
            price_id,
            vendor_id,
            price_timestamp,
            price,
            is_real_purchase,
            comment,
            COALESCE(SUM(quantity), 0) AS quantity,
            COALESCE(SUM(quantity * COALESCE(price, 0)), 0) AS total_cost
        FROM priced
        GROUP BY
            product_id,
            price_id,
            vendor_id,
            price_timestamp,
            price,
            is_real_purchase,
            comment
        ORDER BY product_id, price_timestamp DESC NULLS LAST
        "#,
    )
    .bind(project_id)
    .bind(from)
    .bind(to)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let special_records = sqlx::query_as::<_, SpecialCostRow>(
        r#"
        SELECT
            record.id,
            record.note_id,
            note.auto_id AS note_auto_id,
            note.effective_timestamp,
            record.name,
            record.unit,
            record.amount,
            record.price_per_unit,
            record.comment,
            record.amount * COALESCE(record.price_per_unit, 0) AS total_cost
        FROM product_delivery_special_records AS record
        INNER JOIN product_delivery_notes AS note
            ON note.id = record.note_id
        WHERE note.project_id = $1
          AND ($2::timestamptz IS NULL OR note.effective_timestamp >= $2)
          AND ($3::timestamptz IS NULL OR note.effective_timestamp <= $3)
        ORDER BY note.effective_timestamp DESC, record.id DESC
        "#,
    )
    .bind(project_id)
    .bind(from)
    .bind(to)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let work_hours = sqlx::query_as::<_, WorkCostRow>(
        r#"
        SELECT
            hours.id,
            hours.user_id,
            report.day,
            hours.hours,
            hours.cost_per_hour,
            hours.contract_type,
            hours.hours * COALESCE(hours.cost_per_hour, 0) AS total_cost
        FROM daily_project_reports AS report
        INNER JOIN daily_project_report_work_hours AS hours
            ON hours.report_id = report.id
        WHERE report.project_id = $1
          AND ($2::timestamptz IS NULL OR report.day >= $2::date)
          AND ($3::timestamptz IS NULL OR report.day <= $3::date)
        ORDER BY hours.id DESC
        "#,
    )
    .bind(project_id)
    .bind(from)
    .bind(to)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let tool_trackings = sqlx::query_as::<_, ToolCostRow>(
        r#"
        SELECT
            tracking.id,
            tracking.tool_id,
            tracking.responsible_user_id,
            tracking.started_by_user_id,
            tracking.ended_by_user_id,
            tracking.tool_usage_cost_per_day,
            tracking.comment,
            tracking.started_at,
            tracking.ended_at,
            tracking.deadline_at,
            GREATEST(
                DATE_TRUNC('day', COALESCE(tracking.ended_at, NOW()))::date
                - DATE_TRUNC('day', tracking.started_at)::date
                + 1,
                0
            ) * COALESCE(tracking.tool_usage_cost_per_day, 0) AS total_cost
        FROM tool_trackings AS tracking
        WHERE tracking.project_id = $1
          AND ($2::timestamptz IS NULL OR COALESCE(tracking.ended_at, NOW()) >= $2)
          AND ($3::timestamptz IS NULL OR tracking.started_at <= $3)
        ORDER BY tracking.started_at DESC, tracking.id DESC
        "#,
    )
    .bind(project_id)
    .bind(from)
    .bind(to)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let common_history = sqlx::query_as::<_, CommonCostRow>(
        r#"
        SELECT type, effective_at, relative_factor, constant
        FROM global_common_cost_entries
        WHERE type IN ('fgk', 'mgk', 'ngk')
        ORDER BY type, effective_at
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(build_cost_output(
        financial_entries,
        delivery_notes,
        products,
        special_records,
        work_hours,
        tool_trackings,
        common_history,
    ))
}

#[allow(clippy::too_many_arguments)]
fn build_cost_output(
    financial_entries: Vec<FinancialEntryRow>,
    delivery_notes: Vec<DeliveryCostRow>,
    products: Vec<ProductCostRow>,
    special_records: Vec<SpecialCostRow>,
    work_hours: Vec<WorkCostRow>,
    tool_trackings: Vec<ToolCostRow>,
    common_history: Vec<CommonCostRow>,
) -> Value {
    let offers = financial_entries
        .iter()
        .filter(|entry| entry.entry_type == "offer")
        .map(FinancialEntryRow::to_json)
        .collect::<Vec<_>>();
    let invoices = financial_entries
        .iter()
        .filter(|entry| entry.entry_type == "invoice")
        .map(FinancialEntryRow::to_json)
        .collect::<Vec<_>>();

    let mut fgk = CostBucket::default();
    let mut mgk = CostBucket::default();
    let mut ngk = CostBucket::default();

    let delivery_json = delivery_notes
        .iter()
        .map(|note| {
            mgk.base_cost += note.total_cost;
            if note.record_count > 0 {
                let factor = common_at(&common_history, "mgk", note.effective_timestamp);
                mgk.overhead_cost += note.total_cost * factor.relative_factor + factor.constant;
            }

            json!({
                "noteId": Id(note.note_id),
                "autoId": note.auto_id,
                "effectiveTimestamp": note.effective_timestamp,
                "totalCost": note.total_cost,
            })
        })
        .collect::<Vec<_>>();

    let mut internal_work = Vec::new();
    let mut subcontractor_work = Vec::new();
    for entry in &work_hours {
        let value = entry.to_json();

        if entry.contract_type == "subcontractor" {
            ngk.base_cost += entry.total_cost;
            subcontractor_work.push(value);
        } else {
            if entry.contract_type == "internal" {
                fgk.base_cost += entry.total_cost;
            }
            internal_work.push(value);
        }
    }

    // Constants apply once per report that contains the corresponding labor
    // category, not once per individual work-hour entry.
    let mut labor_by_day = std::collections::BTreeMap::<NaiveDate, (f64, usize, f64, usize)>::new();
    for entry in &work_hours {
        let aggregate = labor_by_day.entry(entry.day).or_default();

        if entry.contract_type == "internal" {
            aggregate.0 += entry.total_cost;
            aggregate.1 += 1;
        } else if entry.contract_type == "subcontractor" {
            aggregate.2 += entry.total_cost;
            aggregate.3 += 1;
        }
    }
    for (day, (internal, internal_count, subcontractor, subcontractor_count)) in labor_by_day {
        let effective_at = day
            .and_hms_opt(0, 0, 0)
            .expect("calendar day has midnight")
            .and_utc();

        if internal_count > 0 {
            let factor = common_at(&common_history, "fgk", effective_at);
            fgk.overhead_cost += internal * factor.relative_factor + factor.constant;
        }
        if subcontractor_count > 0 {
            let factor = common_at(&common_history, "ngk", effective_at);
            ngk.overhead_cost += subcontractor * factor.relative_factor + factor.constant;
        }
    }

    fgk.finish();
    mgk.finish();
    ngk.finish();

    let products_total = products.iter().map(|row| row.total_cost).sum::<f64>();
    let specials_total = special_records
        .iter()
        .map(|row| row.total_cost)
        .sum::<f64>();
    let delivery_total = delivery_notes.iter().map(|row| row.total_cost).sum::<f64>();
    let internal_total = work_hours
        .iter()
        .filter(|row| row.contract_type != "subcontractor")
        .map(|row| row.total_cost)
        .sum::<f64>();
    let subcontractor_total = work_hours
        .iter()
        .filter(|row| row.contract_type == "subcontractor")
        .map(|row| row.total_cost)
        .sum::<f64>();
    let tool_total = tool_trackings.iter().map(|row| row.total_cost).sum::<f64>();
    let overall_overhead = fgk.overhead_cost + mgk.overhead_cost + ngk.overhead_cost;
    let overall =
        delivery_total + internal_total + subcontractor_total + tool_total + overall_overhead;

    json!({
        "offers": offers,
        "invoices": invoices,
        "deliveryNotes": delivery_json,
        "products": products.iter().map(ProductCostRow::to_json).collect::<Vec<_>>(),
        "specialRecords": special_records.iter().map(SpecialCostRow::to_json).collect::<Vec<_>>(),
        "workHours": internal_work,
        "subcontractorWorkHours": subcontractor_work,
        "toolTrackings": tool_trackings.iter().map(ToolCostRow::to_json).collect::<Vec<_>>(),
        "commonCosts": {
            "fgk": fgk,
            "mgk": mgk,
            "ngk": ngk,
            "overallOverhead": overall_overhead,
        },
        "totalCosts": {
            "offers": financial_entries.iter().filter(|row| row.entry_type == "offer").map(|row| row.amount).sum::<f64>(),
            "invoices": financial_entries.iter().filter(|row| row.entry_type == "invoice").map(|row| row.amount).sum::<f64>(),
            "deliveryNotes": delivery_total,
            "products": products_total,
            "specialRecords": specials_total,
            "workHours": internal_total,
            "subcontractorWorkHours": subcontractor_total,
            "toolTrackings": tool_total,
            "overall": overall,
        },
    })
}

fn common_at(history: &[CommonCostRow], cost_type: &str, at: DateTime<Utc>) -> CommonFactor {
    history
        .iter()
        .rfind(|entry| entry.cost_type == cost_type && entry.effective_at <= at)
        .map(|entry| CommonFactor {
            relative_factor: entry.relative_factor,
            constant: entry.constant,
        })
        .unwrap_or_default()
}

async fn cost_overview_pool(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<(crate::auth::AuthResult, sqlx::PgPool)> {
    let (auth, pool) = super::common::authenticated_pool(state, context).await?;

    for role in [
        "view:projects",
        "view:deliveryNotes",
        "view:dailyProjectReports",
    ] {
        super::common::require_role(&auth, role)?;
    }

    Ok((auth, pool))
}

async fn ensure_project_exists(pool: &sqlx::PgPool, project_id: Id) -> RpcResult<()> {
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1)")
            .bind(project_id.0)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if exists { Ok(()) } else { Err(not_found()) }
}

fn parse_optional_timestamp(
    value: Option<&Value>,
    field: &str,
) -> RpcResult<Option<DateTime<Utc>>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let text = value
        .as_str()
        .ok_or_else(|| bad_request(format!("invalid {field}")))?;

    DateTime::parse_from_rfc3339(text)
        .map(|timestamp| Some(timestamp.with_timezone(&Utc)))
        .map_err(|_| bad_request(format!("invalid {field}")))
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinancialEntryCreateInput {
    project_id: Id,

    #[serde(rename = "type")]
    entry_type: String,

    amount: f64,

    #[serde(default)]
    #[ts(optional = nullable)]
    comment: Option<String>,
}

impl FinancialEntryCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        if !matches!(self.entry_type.as_str(), "offer" | "invoice") {
            return Err(bad_request("invalid financial entry type"));
        }
        if !self.amount.is_finite() || self.amount <= 0.0 {
            return Err(bad_request("amount must be positive"));
        }

        trim_nullable(&mut self.comment, "comment", 5_000)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinancialEntryUpdateInput {
    project_id: Id,
    id: Id,
    data: FinancialEntryData,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct FinancialEntryData {
    amount: f64,

    #[serde(default)]
    #[ts(optional = nullable)]
    comment: Option<String>,
}

impl FinancialEntryData {
    fn normalize(&mut self) -> RpcResult<()> {
        if !self.amount.is_finite() || self.amount <= 0.0 {
            return Err(bad_request("amount must be positive"));
        }

        trim_nullable(&mut self.comment, "comment", 5_000)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinancialEntryKey {
    project_id: Id,
    id: Id,
}

#[derive(FromRow)]
struct ProjectLeaderRow {
    id: i64,
    first_name: String,
    last_name: Option<String>,
}

#[derive(FromRow)]
struct OverviewRow {
    id: i64,
    title: String,
    address: Option<Json<Address>>,
    finished_at: Option<DateTime<Utc>>,
    responsible_project_leader_user_id: Option<i64>,
    offers_total: f64,
    invoices_total: f64,
    invoice_count: i64,
    costs: f64,
}

#[derive(FromRow)]
struct FinancialEntryRow {
    id: i64,
    project_id: i64,

    #[sqlx(rename = "type")]
    entry_type: String,

    amount: f64,
    comment: Option<String>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
}

impl FinancialEntryRow {
    fn to_json(&self) -> Value {
        json!({
            "id": Id(self.id),
            "projectId": Id(self.project_id),
            "type": self.entry_type,
            "amount": self.amount,
            "comment": self.comment,
            "createdByUserId": self.created_by_user_id.map(Id),
            "createdAt": self.created_at,
        })
    }
}

#[derive(FromRow)]
struct DeliveryCostRow {
    note_id: i64,
    auto_id: i64,
    effective_timestamp: DateTime<Utc>,
    total_cost: f64,
    record_count: i64,
}

#[derive(FromRow)]
struct ProductCostRow {
    product_id: i64,
    price_id: Option<i64>,
    vendor_id: Option<i64>,
    price_timestamp: Option<DateTime<Utc>>,
    price: Option<f64>,
    is_real_purchase: Option<bool>,
    comment: Option<String>,
    quantity: f64,
    total_cost: f64,
}

impl ProductCostRow {
    fn to_json(&self) -> Value {
        let price_record = self.price_id.map(|price_id| {
            json!({
                "id": Id(price_id),
                "productId": Id(self.product_id),
                "vendorId": self.vendor_id.map(Id),
                "timestamp": self.price_timestamp,
                "price": self.price,
                "isRealPurchase": self.is_real_purchase.unwrap_or(false),
                "comment": self.comment,
            })
        });

        json!({
            "productId": Id(self.product_id),
            "quantity": self.quantity,
            "totalCost": self.total_cost,
            "priceRecord": price_record,
        })
    }
}

#[derive(FromRow)]
struct SpecialCostRow {
    id: i64,
    note_id: i64,
    note_auto_id: i64,
    effective_timestamp: DateTime<Utc>,
    name: String,
    unit: String,
    amount: f64,
    price_per_unit: Option<f64>,
    comment: Option<String>,
    total_cost: f64,
}

impl SpecialCostRow {
    fn to_json(&self) -> Value {
        json!({
            "id": Id(self.id),
            "noteId": Id(self.note_id),
            "noteAutoId": self.note_auto_id,
            "effectiveTimestamp": self.effective_timestamp,
            "name": self.name,
            "unit": self.unit,
            "amount": self.amount,
            "pricePerUnit": self.price_per_unit,
            "comment": self.comment,
            "totalCost": self.total_cost,
        })
    }
}

#[derive(FromRow)]
struct WorkCostRow {
    id: i64,
    user_id: Option<i64>,
    day: NaiveDate,
    hours: f64,
    cost_per_hour: Option<f64>,
    contract_type: String,
    total_cost: f64,
}

impl WorkCostRow {
    fn to_json(&self) -> Value {
        json!({
            "id": Id(self.id),
            "userId": self.user_id.map(Id),
            "day": super::common::wire_date(self.day),
            "hours": self.hours,
            "costPerHour": self.cost_per_hour,
            "contractType": self.contract_type,
            "totalCost": self.total_cost,
        })
    }
}

#[derive(FromRow)]
struct ToolCostRow {
    id: i64,
    tool_id: i64,
    responsible_user_id: Option<i64>,
    started_by_user_id: Option<i64>,
    ended_by_user_id: Option<i64>,
    tool_usage_cost_per_day: Option<f64>,
    comment: Option<String>,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    deadline_at: Option<DateTime<Utc>>,
    total_cost: f64,
}

impl ToolCostRow {
    fn to_json(&self) -> Value {
        json!({
            "id": Id(self.id),
            "toolId": Id(self.tool_id),
            "responsibleUserId": self.responsible_user_id.map(Id),
            "startedByUserId": self.started_by_user_id.map(Id),
            "endedByUserId": self.ended_by_user_id.map(Id),
            "toolUsageCostPerDay": self.tool_usage_cost_per_day,
            "comment": self.comment,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "deadlineAt": self.deadline_at,
            "totalCost": self.total_cost,
        })
    }
}

#[derive(FromRow)]
struct CommonCostRow {
    #[sqlx(rename = "type")]
    cost_type: String,
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
}

#[derive(Default)]
struct CommonFactor {
    relative_factor: f64,
    constant: f64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CostBucket {
    base_cost: f64,
    overhead_cost: f64,
    total_cost: f64,
}

impl CostBucket {
    fn finish(&mut self) {
        self.total_cost = self.base_cost + self.overhead_cost;
    }
}

#[cfg(test)]
mod tests {
    use super::{FinancialEntryCreateInput, FinancialEntryData};

    #[test]
    fn validates_positive_financial_entries_and_known_types() {
        let mut valid = FinancialEntryCreateInput {
            project_id: crate::ids::Id(1),
            entry_type: "offer".to_owned(),
            amount: 120.0,
            comment: Some("  quote  ".to_owned()),
        };

        valid.normalize().expect("valid entry");
        assert_eq!(valid.comment.as_deref(), Some("quote"));

        let mut invalid = FinancialEntryData {
            amount: 0.0,
            comment: None,
        };
        assert!(invalid.normalize().is_err());
    }
}
