//! Product delivery notes and their cost calculation.

use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgPool, types::Json};
use ts_rs::TS;

use super::common::{
    authorized_pool, bad_request, forbidden, input_id, input_object, input_string, internal,
    not_found, optional_input_id, optional_input_string,
};
use crate::{
    AppState,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    job_queue::{self, DELIVERY_NOTE_OCR_JOB_TYPE},
    llm,
    object_storage::{self, Audience},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query_json("deliveryNotes.list", move |context, input| {
        let state = Arc::clone(&list_state);

        async move { list(&state, &context, input).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("deliveryNotes.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create(&state, &context, input).await }
    });

    let update_state = Arc::clone(&state);
    builder = builder.mutation_json("deliveryNotes.update", move |context, input| {
        let state = Arc::clone(&update_state);

        async move { update(&state, &context, input).await }
    });

    let get_state = Arc::clone(&state);
    builder = builder.query_json("deliveryNotes.get", move |context, input| {
        let state = Arc::clone(&get_state);

        async move { get(&state, &context, input).await }
    });

    let delete_state = Arc::clone(&state);
    builder = builder.mutation_json("deliveryNotes.delete", move |context, input| {
        let state = Arc::clone(&delete_state);

        async move { delete(&state, &context, input).await }
    });

    let costs_state = Arc::clone(&state);
    builder = builder.query_json("deliveryNotes.costs.get", move |context, input| {
        let state = Arc::clone(&costs_state);

        async move { costs(&state, &context, input).await }
    });

    let upload_state = Arc::clone(&state);
    builder = builder.mutation(
        "deliveryNotes.scan.createUpload",
        move |context, input: CreateScanUploadInput| {
            let state = Arc::clone(&upload_state);

            async move { create_scan_upload(&state, &context, input).await }
        },
    );

    let scan_history_state = Arc::clone(&state);
    builder = builder.query("deliveryNotes.scan.list", move |context, _input: ()| {
        let state = Arc::clone(&scan_history_state);

        async move { scan_history(state, &context).await }
    });

    let scan_start_state = Arc::clone(&state);
    builder = builder.mutation(
        "deliveryNotes.scan.start",
        move |context, input: StartScanInput| {
            let state = Arc::clone(&scan_start_state);

            async move { start_scan(state, &context, input).await }
        },
    );

    let scan_status_state = Arc::clone(&state);
    builder = builder.query(
        "deliveryNotes.scan.status",
        move |context, input: ScanJobInput| {
            let state = Arc::clone(&scan_status_state);

            async move { scan_status(state, &context, input).await }
        },
    );

    let scan_complete_state = Arc::clone(&state);
    builder = builder.mutation(
        "deliveryNotes.scan.complete",
        move |context, input: CompleteScanInput| {
            let state = Arc::clone(&scan_complete_state);

            async move { complete_scan(state, &context, input).await }
        },
    );

    builder.mutation(
        "deliveryNotes.scan.parse",
        move |context, input: ParseScanInput| {
            let state = Arc::clone(&state);

            async move { parse_scan(&state, &context, input).await }
        },
    )
}

#[derive(FromRow)]
struct NoteRow {
    id: i64,
    auto_id: i64,
    project_id: i64,
    created_by_user_id: Option<i64>,
    comment: Option<String>,
    created_at: DateTime<Utc>,
    effective_timestamp: DateTime<Utc>,
}

#[derive(FromRow)]
struct ProductRecordRow {
    id: i64,
    note_id: i64,
    product_id: i64,
    quantity: f64,
    unit: String,
    comment: Option<String>,
}

#[derive(FromRow)]
struct SpecialRecordRow {
    id: i64,
    note_id: i64,
    name: String,
    unit: String,
    amount: f64,
    price_per_unit: Option<f64>,
    comment: Option<String>,
}

async fn list(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:deliveryNotes").await?;
    let input = input_object(&input)?;

    let project_id = optional_input_id(input, "projectId")?;
    let created_by_user_id = optional_input_id(input, "createdByUserId")?;

    let notes = sqlx::query_as::<_, NoteRow>(
        r#"
        SELECT
            id,
            auto_id,
            project_id,
            created_by_user_id,
            comment,
            created_at,
            effective_timestamp
        FROM product_delivery_notes
        WHERE ($1::bigint IS NULL OR project_id = $1)
          AND ($2::bigint IS NULL OR created_by_user_id = $2)
        ORDER BY auto_id DESC
        "#,
    )
    .bind(project_id)
    .bind(created_by_user_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    load_complete_notes(&pool, notes).await
}

async fn get(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:deliveryNotes").await?;
    let input = input_object(&input)?;

    let note = if input.contains_key("id") {
        let note_id = input_id(input, "id")?;

        sqlx::query_as::<_, NoteRow>(
            r#"
            SELECT
                id,
                auto_id,
                project_id,
                created_by_user_id,
                comment,
                created_at,
                effective_timestamp
            FROM product_delivery_notes
            WHERE id = $1
            "#,
        )
        .bind(note_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
    } else {
        let auto_id = input
            .get("autoId")
            .and_then(Value::as_i64)
            .ok_or_else(|| bad_request("missing autoId"))?;

        sqlx::query_as::<_, NoteRow>(
            r#"
            SELECT
                id,
                auto_id,
                project_id,
                created_by_user_id,
                comment,
                created_at,
                effective_timestamp
            FROM product_delivery_notes
            WHERE auto_id = $1
            "#,
        )
        .bind(auto_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
    }
    .ok_or_else(not_found)?;

    let mut notes = load_complete_notes(&pool, vec![note]).await?;
    notes
        .as_array_mut()
        .and_then(Vec::pop)
        .ok_or_else(not_found)
}

async fn load_complete_notes(pool: &PgPool, notes: Vec<NoteRow>) -> RpcResult<Value> {
    if notes.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }

    let note_ids: Vec<i64> = notes.iter().map(|note| note.id).collect();
    let product_records = sqlx::query_as::<_, ProductRecordRow>(
        r#"
        SELECT id, note_id, product_id, quantity, unit, comment
        FROM product_delivery_records
        WHERE note_id = ANY($1)
        "#,
    )
    .bind(&note_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    let special_records = sqlx::query_as::<_, SpecialRecordRow>(
        r#"
        SELECT
            id,
            note_id,
            name,
            unit,
            amount,
            price_per_unit,
            comment
        FROM product_delivery_special_records
        WHERE note_id = ANY($1)
        "#,
    )
    .bind(&note_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let mut products_by_note: HashMap<i64, Vec<Value>> = HashMap::new();
    for record in product_records {
        products_by_note
            .entry(record.note_id)
            .or_default()
            .push(product_record_value(record));
    }

    let mut specials_by_note: HashMap<i64, Vec<Value>> = HashMap::new();
    for record in special_records {
        specials_by_note
            .entry(record.note_id)
            .or_default()
            .push(special_record_value(record));
    }

    let values = notes
        .into_iter()
        .map(|note| {
            let note_id = note.id;

            json!({
                "id": Id(note_id),
                "autoId": note.auto_id,
                "projectId": Id(note.project_id),
                "comment": note.comment,
                "createdByUserId": note.created_by_user_id.map(Id),
                "createdAt": note.created_at,
                "effectiveTimestamp": note.effective_timestamp,
                "records": products_by_note.remove(&note_id).unwrap_or_default(),
                "specialRecords": specials_by_note.remove(&note_id).unwrap_or_default(),
            })
        })
        .collect();

    Ok(Value::Array(values))
}

fn product_record_value(record: ProductRecordRow) -> Value {
    json!({
        "id": Id(record.id),
        "noteId": Id(record.note_id),
        "productId": Id(record.product_id),
        "quantity": record.quantity,
        "unit": record.unit,
        "comment": record.comment,
    })
}

fn special_record_value(record: SpecialRecordRow) -> Value {
    json!({
        "id": Id(record.id),
        "noteId": Id(record.note_id),
        "name": record.name,
        "unit": record.unit,
        "amount": record.amount,
        "pricePerUnit": record.price_per_unit,
        "comment": record.comment,
    })
}

async fn create(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authorized_pool(state, context, "manage:deliveryNotes").await?;
    let input = input_object(&input)?;

    let project_id = input_id(input, "projectId")?;
    let effective_timestamp =
        optional_timestamp(input, "effectiveTimestamp")?.unwrap_or_else(Utc::now);
    let comment = nullable_text(input, "comment", 511)?;
    let product_records = parse_product_records(input.get("records"))?;
    let special_records = parse_special_records(input.get("specialRecords"))?;

    if product_records.is_empty() && special_records.is_empty() {
        return Err(bad_request("at least one record is required"));
    }

    let created_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    let note_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO product_delivery_notes (
            project_id,
            comment,
            created_by_user_id,
            effective_timestamp
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
    )
    .bind(project_id)
    .bind(comment)
    .bind(created_by_user_id)
    .bind(effective_timestamp)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;

    let base_units = load_base_units(&pool, &product_records).await?;

    for record in product_records {
        let unit = record
            .unit
            .or_else(|| base_units.get(&record.product_id).cloned())
            .ok_or_else(|| bad_request("product has no base unit"))?;

        sqlx::query(
            r#"
            INSERT INTO product_delivery_records (
                note_id,
                product_id,
                quantity,
                unit,
                comment
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(note_id)
        .bind(record.product_id)
        .bind(record.quantity)
        .bind(unit)
        .bind(record.comment)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    }

    insert_special_records(&mut transaction, note_id, special_records).await?;

    transaction.commit().await.map_err(internal)?;

    Ok(json!({ "id": Id(note_id) }))
}

async fn update(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:deliveryNotes").await?;
    let input = input_object(&input)?;
    let note_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let changes_products = changes.contains_key("records");
    let changes_specials = changes.contains_key("specialRecords");
    let changes_header = changes.contains_key("projectId")
        || changes.contains_key("comment")
        || changes.contains_key("effectiveTimestamp");

    if !changes_products && !changes_specials && !changes_header {
        return Err(bad_request("empty update"));
    }

    let current: Option<(i64, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        r#"
            SELECT project_id, comment, effective_timestamp
            FROM product_delivery_notes
            WHERE id = $1
            "#,
    )
    .bind(note_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;
    let Some((current_project, current_comment, current_timestamp)) = current else {
        return Err(not_found());
    };

    let project_id = if changes.contains_key("projectId") {
        optional_input_id(changes, "projectId")?
    } else {
        Some(current_project)
    };
    let comment = if changes.contains_key("comment") {
        nullable_text(changes, "comment", 511)?
    } else {
        current_comment
    };
    let effective_timestamp = if changes.contains_key("effectiveTimestamp") {
        optional_timestamp(changes, "effectiveTimestamp")?
    } else {
        Some(current_timestamp)
    };

    let product_records = if changes_products {
        Some(parse_product_records(changes.get("records"))?)
    } else {
        None
    };
    let special_records = if changes_specials {
        Some(parse_special_records(changes.get("specialRecords"))?)
    } else {
        None
    };

    let base_units = if let Some(records) = &product_records {
        load_base_units(&pool, records).await?
    } else {
        HashMap::new()
    };

    let mut transaction = pool.begin().await.map_err(internal)?;

    if changes_header {
        sqlx::query(
            r#"
            UPDATE product_delivery_notes
            SET
                project_id = $2,
                comment = $3,
                effective_timestamp = $4
            WHERE id = $1
            "#,
        )
        .bind(note_id)
        .bind(project_id)
        .bind(comment)
        .bind(effective_timestamp)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    }

    if let Some(records) = product_records {
        sqlx::query("DELETE FROM product_delivery_records WHERE note_id = $1")
            .bind(note_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;

        for record in records {
            let unit = record
                .unit
                .or_else(|| base_units.get(&record.product_id).cloned())
                .ok_or_else(|| bad_request("product has no base unit"))?;

            sqlx::query(
                r#"
                INSERT INTO product_delivery_records (
                    note_id,
                    product_id,
                    quantity,
                    unit,
                    comment
                )
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(note_id)
            .bind(record.product_id)
            .bind(record.quantity)
            .bind(unit)
            .bind(record.comment)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
        }
    }

    if let Some(records) = special_records {
        sqlx::query("DELETE FROM product_delivery_special_records WHERE note_id = $1")
            .bind(note_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;

        insert_special_records(&mut transaction, note_id, records).await?;
    }

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

async fn delete(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:deliveryNotes").await?;
    let note_id = input_id(input_object(&input)?, "id")?;

    let result = sqlx::query("DELETE FROM product_delivery_notes WHERE id = $1")
        .bind(note_id)
        .execute(&pool)
        .await
        .map_err(internal)?;

    // The old endpoint returned Forbidden for an unknown delivery note.
    if result.rows_affected() == 0 {
        return Err(forbidden());
    }

    Ok(success())
}

struct ProductRecordInput {
    product_id: i64,
    quantity: f64,
    unit: Option<String>,
    comment: Option<String>,
}

struct SpecialRecordInput {
    name: String,
    unit: String,
    amount: f64,
    price_per_unit: Option<f64>,
    comment: Option<String>,
}

fn parse_product_records(value: Option<&Value>) -> RpcResult<Vec<ProductRecordInput>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }

    let records = value
        .as_array()
        .ok_or_else(|| bad_request("invalid records"))?;
    records
        .iter()
        .map(|record| {
            let record = input_object(record)?;

            Ok(ProductRecordInput {
                product_id: input_id(record, "productId")?,
                quantity: require_number(record, "quantity")?,
                unit: nullable_text(record, "unit", 32)?,
                comment: nullable_text(record, "comment", 255)?,
            })
        })
        .collect()
}

fn parse_special_records(value: Option<&Value>) -> RpcResult<Vec<SpecialRecordInput>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }

    let records = value
        .as_array()
        .ok_or_else(|| bad_request("invalid specialRecords"))?;
    records
        .iter()
        .map(|record| {
            let record = input_object(record)?;

            Ok(SpecialRecordInput {
                name: required_text(record, "name", 255)?,
                unit: required_text(record, "unit", 32)?,
                amount: require_number(record, "amount")?,
                price_per_unit: record.get("pricePerUnit").and_then(Value::as_f64),
                comment: nullable_text(record, "comment", 255)?,
            })
        })
        .collect()
}

async fn load_base_units(
    pool: &PgPool,
    records: &[ProductRecordInput],
) -> RpcResult<HashMap<i64, String>> {
    let product_ids: Vec<i64> = records
        .iter()
        .filter(|record| record.unit.is_none())
        .map(|record| record.product_id)
        .collect();

    if product_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows: Vec<(i64, String)> = sqlx::query_as(
        r#"
        SELECT id, base_unit
        FROM products
        WHERE id = ANY($1)
        "#,
    )
    .bind(product_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().collect())
}

async fn insert_special_records(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    note_id: i64,
    records: Vec<SpecialRecordInput>,
) -> RpcResult<()> {
    for record in records {
        sqlx::query(
            r#"
            INSERT INTO product_delivery_special_records (
                note_id,
                name,
                unit,
                amount,
                price_per_unit,
                comment
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(note_id)
        .bind(record.name)
        .bind(record.unit)
        .bind(record.amount)
        .bind(record.price_per_unit)
        .bind(record.comment)
        .execute(&mut **transaction)
        .await
        .map_err(internal)?;
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
    let (_, pool) = authorized_pool(state, context, "view:deliveryNotes").await?;
    let note_id = input_id(input_object(&input)?, "id")?;

    let effective_timestamp: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"
        SELECT effective_timestamp
        FROM product_delivery_notes
        WHERE id = $1
        "#,
    )
    .bind(note_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?;
    let effective_timestamp = effective_timestamp.ok_or_else(not_found)?;

    let product_records = sqlx::query_as::<_, ProductRecordRow>(
        r#"
        SELECT id, note_id, product_id, quantity, unit, comment
        FROM product_delivery_records
        WHERE note_id = $1
        "#,
    )
    .bind(note_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;
    let product_ids: Vec<i64> = product_records
        .iter()
        .map(|record| record.product_id)
        .collect();

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
              AND timestamp <= $2
            ORDER BY product_id, timestamp DESC
            "#,
        )
        .bind(product_ids)
        .bind(effective_timestamp)
        .fetch_all(&pool)
        .await
        .map_err(internal)?
    };
    let prices_by_product: HashMap<i64, LatestPriceRow> = latest_prices
        .into_iter()
        .map(|price| (price.product_id, price))
        .collect();

    let mut total_cost = 0.0;
    let product_costs: Vec<Value> = product_records
        .into_iter()
        .map(|record| {
            let price = prices_by_product.get(&record.product_id);
            total_cost += record.quantity * price.map(|price| price.price).unwrap_or(0.0);

            json!({
                "recordId": Id(record.id),
                "productId": Id(record.product_id),
                "quantity": record.quantity,
                "priceRecord": price.map(price_record_value),
            })
        })
        .collect();

    let special_records = sqlx::query_as::<_, SpecialRecordRow>(
        r#"
        SELECT
            id,
            note_id,
            name,
            unit,
            amount,
            price_per_unit,
            comment
        FROM product_delivery_special_records
        WHERE note_id = $1
        "#,
    )
    .bind(note_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let special_costs: Vec<Value> = special_records
        .into_iter()
        .map(|record| {
            let record_cost = record.amount * record.price_per_unit.unwrap_or(0.0);
            total_cost += record_cost;

            json!({
                "recordId": Id(record.id),
                "name": record.name,
                "unit": record.unit,
                "amount": record.amount,
                "pricePerUnit": record.price_per_unit,
                "comment": record.comment,
                "totalCost": record_cost,
            })
        })
        .collect();

    Ok(json!({
        "noteId": Id(note_id),
        "totalCost": total_cost,
        "records": product_costs,
        "specialRecords": special_costs,
    }))
}

fn price_record_value(price: &LatestPriceRow) -> Value {
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

const MAX_SCAN_BYTES: i64 = 20 * 1024 * 1024;
const MAX_SCAN_FILES: usize = 20;
const MAX_SCAN_TOTAL_BYTES: i64 = 100 * 1024 * 1024;
const OCR_FALLBACK_CONFIDENCE: f64 = 0.72;
const OCR_JOB_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateScanUploadInput {
    file_name: String,
    mime_type: String,
    #[ts(type = "number")]
    size_bytes: i64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScanUpload {
    object_key: String,
    upload_url: String,
    #[ts(type = "Date")]
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParseScanInput {
    object_key: String,
    file_name: String,
    mime_type: String,
    #[ts(type = "number")]
    size_bytes: i64,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartScanInput {
    documents: Vec<ParseScanInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedScanDocument {
    job_id: i64,
    #[serde(flatten)]
    source: ParseScanInput,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScanJobInput {
    scan_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteScanInput {
    scan_id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScanJob {
    scan_id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScanJobStatus {
    state: ScanJobState,
    error: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScanHistoryEntry {
    id: Id,
    file_name: String,
    file_names: Vec<String>,
    state: ScanJobState,
    document_type: Option<ScanDocumentType>,
    error: Option<String>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
enum ScanJobState {
    Queued,
    Ocr,
    Matching,
    Completed,
    Failed,
}

#[derive(Debug, FromRow)]
struct ScanHistoryRow {
    id: i64,
    file_name: String,
    source_documents: Option<Json<Vec<PersistedScanDocument>>>,
    state: String,
    document_type: Option<String>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
struct ScanRecord {
    id: i64,
    tenant_name: String,
    job_id: Option<i64>,
    source_object_key: String,
    file_name: String,
    mime_type: String,
    size_bytes: i64,
    source_documents: Option<Json<Vec<PersistedScanDocument>>>,
    state: String,
    result: Option<Json<Value>>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryNoteOcrResult {
    text: String,
    confidence: f64,
    method: String,
    page_count: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScanResult {
    #[serde(default)]
    document_type: RawScanDocumentType,
    supplier: Option<String>,
    #[serde(alias = "deliveryNumber")]
    document_number: Option<String>,
    #[serde(alias = "deliveryDate")]
    document_date: Option<String>,
    comment: Option<String>,
    lines: Vec<RawScanLine>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum RawScanDocumentType {
    #[default]
    DeliveryNote,
    PriceList,
    Invoice,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScanLine {
    source_text: String,
    name: String,
    quantity: f64,
    unit: String,
    product_id: Option<Id>,
    price_per_unit: Option<f64>,
    confidence: f64,
    comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DeliveryNoteScanResult {
    supplier: Option<String>,
    delivery_number: Option<String>,
    delivery_date: Option<String>,
    comment: Option<String>,
    records: Vec<ScannedProductRecord>,
    special_records: Vec<ScannedSpecialRecord>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DocumentScanResult {
    document_type: ScanDocumentType,
    delivery_note: Option<DeliveryNoteScanResult>,
    price_list: Option<PriceListScanResult>,
}

impl DocumentScanResult {
    fn warnings_mut(&mut self) -> &mut Vec<String> {
        match (&mut self.delivery_note, &mut self.price_list) {
            (Some(delivery_note), _) => &mut delivery_note.warnings,
            (_, Some(price_list)) => &mut price_list.warnings,
            _ => unreachable!("a document scan result always has a payload"),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
enum ScanDocumentType {
    DeliveryNote,
    PriceList,
    Invoice,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct PriceListScanResult {
    supplier: Option<String>,
    document_number: Option<String>,
    effective_date: Option<String>,
    rows: Vec<ScannedPriceRow>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScannedPriceRow {
    source_text: String,
    product_id: Option<Id>,
    custom_id: Option<i32>,
    product_name: String,
    base_unit: String,
    source_unit: String,
    price_per_base_unit: f64,
    confidence: f64,
    comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScannedProductRecord {
    source_text: String,
    product_id: Id,
    custom_id: i32,
    product_name: String,
    quantity: f64,
    display_quantity: f64,
    unit: String,
    base_unit: String,
    confidence: f64,
    comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ScannedSpecialRecord {
    source_text: String,
    name: String,
    unit: String,
    amount: f64,
    price_per_unit: Option<f64>,
    confidence: f64,
    comment: Option<String>,
}

#[derive(Debug, FromRow)]
struct ScanProduct {
    id: i64,
    custom_id: i32,
    name: String,
    base_unit: String,
    other_units: Json<Value>,
}

pub fn register_contract(mut builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder = builder
        .mutation_stub::<CreateScanUploadInput, ScanUpload>("deliveryNotes.scan.createUpload");

    builder = builder
        .query_stub::<(), Vec<ScanHistoryEntry>>("deliveryNotes.scan.list")
        .mutation_stub::<StartScanInput, ScanJob>("deliveryNotes.scan.start")
        .query_stub::<ScanJobInput, ScanJobStatus>("deliveryNotes.scan.status")
        .mutation_stub::<CompleteScanInput, DocumentScanResult>("deliveryNotes.scan.complete");

    builder.mutation_stub::<ParseScanInput, DocumentScanResult>("deliveryNotes.scan.parse")
}

async fn create_scan_upload(
    state: &AppState,
    context: &RequestContext,
    input: CreateScanUploadInput,
) -> RpcResult<ScanUpload> {
    validate_scan_file(&input.file_name, &input.mime_type, input.size_bytes)?;

    let (auth, _) = authorized_pool(state, context, "manage:deliveryNotes").await?;
    llm::ensure_scan_access(state, &auth).await?;

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .ok_or_else(|| internal("Object storage configuration disappeared"))?;
    let object_key =
        object_storage::build_delivery_note_scan_object_key(&storage, user_id, &input.file_name);
    let upload = object_storage::create_upload_url(
        &storage,
        &object_key,
        &input.mime_type,
        Audience::Public,
    )?;

    Ok(ScanUpload {
        object_key,
        upload_url: upload.upload_url,
        expires_at: upload.expires_at,
    })
}

async fn scan_history(
    state: Arc<AppState>,
    context: &RequestContext,
) -> RpcResult<Vec<ScanHistoryEntry>> {
    let (auth, pool) = authorized_pool(&state, context, "manage:deliveryNotes").await?;
    llm::ensure_scan_access(&state, &auth).await?;

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let scans = sqlx::query_as::<_, ScanHistoryRow>(
        r#"
        SELECT
            id,
            file_name,
            source_documents,
            state,
            COALESCE(
                result ->> 'documentType',
                CASE WHEN result IS NOT NULL THEN 'deliveryNote' END
            ) AS document_type,
            error,
            created_at,
            updated_at
        FROM __delivery_note_scans
        WHERE tenant_name = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 50
        "#,
    )
    .bind(&auth.tenant)
    .bind(user_id)
    .fetch_all(state.tenants.master())
    .await
    .map_err(internal)?;

    for scan in &scans {
        if matches!(scan.state.as_str(), "queued" | "ocr" | "matching") {
            spawn_scan_processing(Arc::clone(&state), auth.clone(), pool.clone(), scan.id);
        }
    }

    scans
        .into_iter()
        .map(|scan| {
            let file_names = scan
                .source_documents
                .as_ref()
                .map(|documents| {
                    documents
                        .0
                        .iter()
                        .map(|document| document.source.file_name.clone())
                        .collect()
                })
                .unwrap_or_else(|| vec![scan.file_name.clone()]);

            Ok(ScanHistoryEntry {
                id: Id(scan.id),
                file_name: scan.file_name,
                file_names,
                state: parse_scan_state(&scan.state)?,
                document_type: scan
                    .document_type
                    .as_deref()
                    .map(parse_scan_document_type)
                    .transpose()?,
                error: scan.error,
                created_at: scan.created_at,
                updated_at: scan.updated_at,
            })
        })
        .collect()
}

async fn start_scan(
    state: Arc<AppState>,
    context: &RequestContext,
    input: StartScanInput,
) -> RpcResult<ScanJob> {
    validate_scan_documents(&input.documents)?;

    let (auth, pool) = authorized_pool(&state, context, "manage:deliveryNotes").await?;
    llm::ensure_scan_access(&state, &auth).await?;

    if !auth.can_do("view:products") {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "Product catalogue access is required for scan matching",
        ));
    }

    let storage = scan_storage(&state, &auth).await?;
    for document in &input.documents {
        validate_scan_object(&storage, &auth, &document.object_key)?;
    }

    let mut documents = Vec::with_capacity(input.documents.len());
    for source in input.documents {
        let job_id = enqueue_scan_ocr(&state, &auth, &source).await?;

        documents.push(PersistedScanDocument { job_id, source });
    }

    let first = documents
        .first()
        .expect("scan document validation rejects empty groups");
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let scan_id = sqlx::query_scalar(
        r#"
        INSERT INTO __delivery_note_scans (
            tenant_name,
            user_id,
            job_id,
            source_object_key,
            file_name,
            mime_type,
            size_bytes,
            source_documents
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(&auth.tenant)
    .bind(user_id)
    .bind(first.job_id)
    .bind(&first.source.object_key)
    .bind(&first.source.file_name)
    .bind(&first.source.mime_type)
    .bind(first.source.size_bytes)
    .bind(Json(&documents))
    .fetch_one(state.tenants.master())
    .await
    .map_err(internal)?;

    spawn_scan_processing(Arc::clone(&state), auth, pool, scan_id);

    Ok(ScanJob {
        scan_id: Id(scan_id),
    })
}

async fn scan_status(
    state: Arc<AppState>,
    context: &RequestContext,
    input: ScanJobInput,
) -> RpcResult<ScanJobStatus> {
    let (auth, pool) = authorized_pool(&state, context, "manage:deliveryNotes").await?;
    llm::ensure_scan_access(&state, &auth).await?;

    let scan = owned_scan(&state, &auth, input.scan_id.0).await?;
    if matches!(scan.state.as_str(), "queued" | "ocr" | "matching") {
        spawn_scan_processing(Arc::clone(&state), auth, pool, scan.id);
    }

    Ok(ScanJobStatus {
        state: parse_scan_state(&scan.state)?,
        error: scan.error,
    })
}

async fn complete_scan(
    state: Arc<AppState>,
    context: &RequestContext,
    input: CompleteScanInput,
) -> RpcResult<DocumentScanResult> {
    let (auth, pool) = authorized_pool(&state, context, "manage:deliveryNotes").await?;
    llm::ensure_scan_access(&state, &auth).await?;

    let scan = owned_scan(&state, &auth, input.scan_id.0).await?;

    match scan.state.as_str() {
        "completed" => {
            let result = scan
                .result
                .ok_or_else(|| internal("Completed scan has no result"))?;
            let value = result.0;

            if value.get("documentType").is_some() {
                serde_json::from_value(value).map_err(internal)
            } else {
                let delivery_note = serde_json::from_value(value).map_err(internal)?;

                Ok(DocumentScanResult {
                    document_type: ScanDocumentType::DeliveryNote,
                    delivery_note: Some(delivery_note),
                    price_list: None,
                })
            }
        }
        "failed" => Err(RpcError::new(
            ErrorCode::PreconditionFailed,
            scan.error
                .unwrap_or_else(|| "Delivery-note scan failed".to_owned()),
        )),
        "queued" | "ocr" | "matching" => {
            spawn_scan_processing(Arc::clone(&state), auth, pool, scan.id);

            Err(RpcError::new(
                ErrorCode::PreconditionFailed,
                "Delivery-note scan is still being processed",
            ))
        }
        _ => Err(internal("Delivery-note scan has an invalid state")),
    }
}

async fn owned_scan(
    state: &AppState,
    auth: &crate::auth::AuthResult,
    scan_id: i64,
) -> RpcResult<ScanRecord> {
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    sqlx::query_as::<_, ScanRecord>(
        r#"
        SELECT
            id,
            tenant_name,
            job_id,
            source_object_key,
            file_name,
            mime_type,
            size_bytes,
            source_documents,
            state,
            result,
            error
        FROM __delivery_note_scans
        WHERE id = $1 AND tenant_name = $2 AND user_id = $3
        "#,
    )
    .bind(scan_id)
    .bind(&auth.tenant)
    .bind(user_id)
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?
    .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Delivery-note scan not found"))
}

fn parse_scan_state(state: &str) -> RpcResult<ScanJobState> {
    match state {
        "queued" => Ok(ScanJobState::Queued),
        "ocr" => Ok(ScanJobState::Ocr),
        "matching" => Ok(ScanJobState::Matching),
        "completed" => Ok(ScanJobState::Completed),
        "failed" => Ok(ScanJobState::Failed),
        _ => Err(internal("Delivery-note scan has an invalid state")),
    }
}

fn parse_scan_document_type(value: &str) -> RpcResult<ScanDocumentType> {
    match value {
        "deliveryNote" => Ok(ScanDocumentType::DeliveryNote),
        "priceList" => Ok(ScanDocumentType::PriceList),
        "invoice" => Ok(ScanDocumentType::Invoice),
        _ => Err(internal("Document scan has an invalid document type")),
    }
}

fn spawn_scan_processing(
    state: Arc<AppState>,
    auth: crate::auth::AuthResult,
    pool: PgPool,
    scan_id: i64,
) {
    tokio::spawn(async move {
        if let Err(error) = process_scan(Arc::clone(&state), &auth, &pool, scan_id).await {
            let _ = mark_scan_failed(&state, scan_id, &error.message).await;
            let _ = cleanup_scan_files(&state, scan_id).await;
        }
    });
}

async fn process_scan(
    state: Arc<AppState>,
    auth: &crate::auth::AuthResult,
    pool: &PgPool,
    scan_id: i64,
) -> RpcResult<()> {
    let claimed = sqlx::query_scalar::<_, bool>(
        r#"
        UPDATE __delivery_note_scans
        SET
            processor_lease_expires_at = NOW() + INTERVAL '15 seconds',
            updated_at = NOW()
        WHERE id = $1
          AND state IN ('queued', 'ocr', 'matching')
          AND (
              processor_lease_expires_at IS NULL
              OR processor_lease_expires_at <= NOW()
          )
        RETURNING TRUE
        "#,
    )
    .bind(scan_id)
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?;

    if claimed.is_none() {
        return Ok(());
    }

    let scan = sqlx::query_as::<_, ScanRecord>(
        r#"
        SELECT
            id,
            tenant_name,
            job_id,
            source_object_key,
            file_name,
            mime_type,
            size_bytes,
            source_documents,
            state,
            result,
            error
        FROM __delivery_note_scans
        WHERE id = $1
        "#,
    )
    .bind(scan_id)
    .fetch_one(state.tenants.master())
    .await
    .map_err(internal)?;
    let documents = persisted_scan_documents(&scan)?;
    let mut recognized_documents = Vec::with_capacity(documents.len());

    for document in &documents {
        let (ocr, error) = wait_for_scan_ocr(&state, scan_id, document.job_id).await?;

        recognized_documents.push(RecognizedScanDocument {
            source: document.source.clone(),
            ocr,
            error,
        });
    }

    sqlx::query(
        r#"
        UPDATE __delivery_note_scans
        SET
            state = 'matching',
            processor_lease_expires_at = NOW() + INTERVAL '10 minutes',
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(scan_id)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    let storage = scan_storage(&state, auth).await?;
    let result = analyze_stored_scan(
        ScanAnalysisContext {
            state: &state,
            auth,
            pool,
            storage: &storage,
            scan_id: Some(scan_id),
        },
        recognized_documents,
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE __delivery_note_scans
        SET
            state = 'completed',
            result = $2,
            error = NULL,
            processor_lease_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(scan_id)
    .bind(Json(serde_json::to_value(&result).map_err(internal)?))
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    for document in documents {
        let _ = job_queue::delete_finished(&state, document.job_id).await;
        let _ = object_storage::delete_object(&storage, &document.source.object_key).await;
    }

    Ok(())
}

fn persisted_scan_documents(scan: &ScanRecord) -> RpcResult<Vec<PersistedScanDocument>> {
    if let Some(documents) = &scan.source_documents
        && !documents.0.is_empty()
    {
        return Ok(documents.0.clone());
    }

    let job_id = scan
        .job_id
        .ok_or_else(|| internal("Document scan has no OCR job"))?;

    Ok(vec![PersistedScanDocument {
        job_id,
        source: ParseScanInput {
            object_key: scan.source_object_key.clone(),
            file_name: scan.file_name.clone(),
            mime_type: scan.mime_type.clone(),
            size_bytes: scan.size_bytes,
        },
    }])
}

async fn wait_for_scan_ocr(
    state: &AppState,
    scan_id: i64,
    job_id: i64,
) -> RpcResult<(DeliveryNoteOcrResult, Option<String>)> {
    loop {
        let job = job_queue::get(state, job_id)
            .await?
            .ok_or_else(|| internal("OCR job disappeared"))?;

        match job.state.as_str() {
            "succeeded" | "failed" => return completed_ocr(job),
            "pending" | "processing" => {
                let scan_state = if job.state == "processing" {
                    "ocr"
                } else {
                    "queued"
                };

                sqlx::query(
                    r#"
                    UPDATE __delivery_note_scans
                    SET
                        state = $2,
                        processor_lease_expires_at = NOW() + INTERVAL '15 seconds',
                        updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(scan_id)
                .bind(scan_state)
                .execute(state.tenants.master())
                .await
                .map_err(internal)?;

                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            _ => return Err(internal("OCR job has an invalid state")),
        }
    }
}

async fn mark_scan_failed(state: &AppState, scan_id: i64, error: &str) -> RpcResult<()> {
    sqlx::query(
        r#"
        UPDATE __delivery_note_scans
        SET
            state = 'failed',
            error = $2,
            processor_lease_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1 AND state != 'completed'
        "#,
    )
    .bind(scan_id)
    .bind(error)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

async fn cleanup_scan_files(state: &AppState, scan_id: i64) -> RpcResult<()> {
    let scan = sqlx::query_as::<_, ScanRecord>(
        r#"
        SELECT
            id,
            tenant_name,
            job_id,
            source_object_key,
            file_name,
            mime_type,
            size_bytes,
            source_documents,
            state,
            result,
            error
        FROM __delivery_note_scans
        WHERE id = $1
        "#,
    )
    .bind(scan_id)
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?;

    let Some(scan) = scan else {
        return Ok(());
    };

    let documents = persisted_scan_documents(&scan).unwrap_or_default();

    for document in &documents {
        let _ = job_queue::delete_finished(state, document.job_id).await;
    }

    if let Ok(Some(storage)) =
        object_storage::tenant_config(&state.tenants, &scan.tenant_name, false).await
    {
        if documents.is_empty() {
            let _ = object_storage::delete_object(&storage, &scan.source_object_key).await;
        } else {
            for document in documents {
                let _ = object_storage::delete_object(&storage, &document.source.object_key).await;
            }
        }
    }

    Ok(())
}

async fn scan_storage(
    state: &AppState,
    auth: &crate::auth::AuthResult,
) -> RpcResult<object_storage::EnabledStorage> {
    object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .ok_or_else(|| internal("Object storage configuration disappeared"))
}

fn validate_scan_object(
    storage: &object_storage::EnabledStorage,
    auth: &crate::auth::AuthResult,
    object_key: &str,
) -> RpcResult<()> {
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let expected_prefix = object_storage::delivery_note_scan_object_prefix(storage, user_id);

    if !object_key.starts_with(&expected_prefix) {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "The scan does not belong to the signed-in user",
        ));
    }

    Ok(())
}

fn completed_ocr(job: job_queue::QueueJob) -> RpcResult<(DeliveryNoteOcrResult, Option<String>)> {
    match job.state.as_str() {
        "succeeded" => {
            let value = job
                .result
                .map(|result| result.0)
                .ok_or_else(|| internal("OCR job completed without a result"))?;
            let result: DeliveryNoteOcrResult = serde_json::from_value(value).map_err(internal)?;

            validate_ocr_result(&result)?;

            Ok((result, None))
        }
        "failed" => Ok((
            DeliveryNoteOcrResult {
                text: String::new(),
                confidence: 0.0,
                method: "unavailable".to_owned(),
                page_count: 0,
            },
            Some(
                job.last_error
                    .unwrap_or_else(|| "Local OCR failed".to_owned()),
            ),
        )),
        _ => Err(RpcError::new(
            ErrorCode::PreconditionFailed,
            "Local OCR has not finished",
        )),
    }
}

async fn parse_scan(
    state: &AppState,
    context: &RequestContext,
    input: ParseScanInput,
) -> RpcResult<DocumentScanResult> {
    validate_scan_file(&input.file_name, &input.mime_type, input.size_bytes)?;

    let (auth, pool) = authorized_pool(state, context, "manage:deliveryNotes").await?;
    llm::ensure_scan_access(state, &auth).await?;

    if !auth.can_do("view:products") {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "Product catalogue access is required for scan matching",
        ));
    }

    let storage = scan_storage(state, &auth).await?;
    validate_scan_object(&storage, &auth, &input.object_key)?;

    let result = parse_stored_scan(state, &auth, &pool, &storage, &input).await;

    // Scans are temporary input. A failed deletion must not hide a useful
    // parsing result or its provider error.
    let _ = object_storage::delete_object(&storage, &input.object_key).await;

    result
}

async fn parse_stored_scan(
    state: &AppState,
    auth: &crate::auth::AuthResult,
    pool: &PgPool,
    storage: &object_storage::EnabledStorage,
    input: &ParseScanInput,
) -> RpcResult<DocumentScanResult> {
    let (ocr, local_ocr_error) = match run_local_ocr(state, auth, input).await {
        Ok(result) => (result, None),
        Err(error) => (
            DeliveryNoteOcrResult {
                text: String::new(),
                confidence: 0.0,
                method: "unavailable".to_owned(),
                page_count: 0,
            },
            Some(error.message),
        ),
    };

    analyze_stored_scan(
        ScanAnalysisContext {
            state,
            auth,
            pool,
            storage,
            scan_id: None,
        },
        vec![RecognizedScanDocument {
            source: input.clone(),
            ocr,
            error: local_ocr_error,
        }],
    )
    .await
}

struct RecognizedScanDocument {
    source: ParseScanInput,
    ocr: DeliveryNoteOcrResult,
    error: Option<String>,
}

struct ScanAnalysisContext<'a> {
    state: &'a AppState,
    auth: &'a crate::auth::AuthResult,
    pool: &'a PgPool,
    storage: &'a object_storage::EnabledStorage,
    scan_id: Option<i64>,
}

async fn analyze_stored_scan(
    context: ScanAnalysisContext<'_>,
    documents: Vec<RecognizedScanDocument>,
) -> RpcResult<DocumentScanResult> {
    let ScanAnalysisContext {
        state,
        auth,
        pool,
        storage,
        scan_id,
    } = context;

    let ocr = combine_ocr_documents(&documents);
    let is_workbook = documents
        .iter()
        .all(|document| document.ocr.method == "xlsx");
    let mut originals = Vec::new();

    for document in &documents {
        let requires_fallback = document.ocr.method != "xlsx"
            && (document.error.is_some()
                || document.ocr.confidence < OCR_FALLBACK_CONFIDENCE
                || document.ocr.text.trim().len() < 40);

        if requires_fallback {
            originals.push(llm::ScanOriginal {
                bytes: download_scan(storage, &document.source).await?,
                mime_type: document.source.mime_type.clone(),
                file_name: document.source.file_name.clone(),
            });
        }
    }

    let configuration = llm::load_scan_configuration(state).await?.ok_or_else(|| {
        RpcError::new(
            ErrorCode::PreconditionFailed,
            "No scan LLM provider has been configured",
        )
    })?;
    let chunks = scan_transcript_chunks(&ocr.text, is_workbook);
    let chunk_count = chunks.len();
    let mut raw_result: Option<RawScanResult> = None;

    for (index, chunk) in chunks.into_iter().enumerate() {
        if let Some(scan_id) = scan_id {
            sqlx::query(
                r#"
                UPDATE __delivery_note_scans
                SET
                    processor_lease_expires_at = NOW() + INTERVAL '15 minutes',
                    updated_at = NOW()
                WHERE id = $1 AND state = 'matching'
                "#,
            )
            .bind(scan_id)
            .execute(state.tenants.master())
            .await
            .map_err(internal)?;
        }

        let chunk = if chunk_count > 1 {
            format!(
                "Workbook section {} of {}. Extract only the data rows in this section.\n\n{}",
                index + 1,
                chunk_count,
                chunk
            )
        } else {
            chunk
        };
        let completion = match llm::parse_document_scan(
            state,
            auth,
            &configuration,
            llm::DocumentScanInput {
                ocr_text: chunk,
                ocr_confidence: ocr.confidence,
                ocr_method: ocr.method.clone(),
                originals: if index == 0 {
                    originals.clone()
                } else {
                    Vec::new()
                },
                file_names: documents
                    .iter()
                    .map(|document| document.source.file_name.clone())
                    .collect(),
            },
        )
        .await
        {
            Ok(completion) => completion,
            Err(error) => {
                let usage = llm::TokenUsage::default();
                let _ = llm::record_scan_usage(
                    state,
                    auth,
                    &configuration,
                    &usage,
                    Some(&error.message),
                )
                .await;

                return Err(error);
            }
        };

        llm::record_scan_usage(state, auth, &configuration, &completion.usage, None).await?;

        let raw: RawScanResult = serde_json::from_str(&completion.content).map_err(|error| {
            internal(format!(
                "Scan LLM returned invalid structured data in section {}: {error}",
                index + 1
            ))
        })?;

        if let Some(result) = &mut raw_result {
            merge_raw_scan_result(result, raw);
        } else {
            raw_result = Some(raw);
        }
    }

    let raw = raw_result.ok_or_else(|| internal("Document scan produced no sections"))?;
    let locale = auth.user.locale.as_str();
    let mut result = normalize_scan_result(pool, raw, locale).await?;

    let local_ocr_errors = documents
        .iter()
        .filter_map(|document| {
            document
                .error
                .as_ref()
                .map(|error| format!("{}: {error}", document.source.file_name))
        })
        .collect::<Vec<_>>();

    if !local_ocr_errors.is_empty() {
        let errors = local_ocr_errors.join("; ");
        let warning = if locale == "en" {
            format!(
                "Local text recognition failed for one or more files; the originals were analyzed instead. ({errors})"
            )
        } else {
            format!(
                "Die lokale Texterkennung ist bei mindestens einer Datei fehlgeschlagen; stattdessen wurden die Originale ausgewertet. ({errors})"
            )
        };

        result.warnings_mut().push(warning);
    } else if !originals.is_empty() {
        let warning = if locale == "en" {
            "Local text recognition was uncertain, so the original was analyzed as well."
        } else {
            "Die lokale Texterkennung war unsicher; deshalb wurde zusätzlich das Original ausgewertet."
        };

        result.warnings_mut().push(warning.to_owned());
    }

    Ok(result)
}

fn combine_ocr_documents(documents: &[RecognizedScanDocument]) -> DeliveryNoteOcrResult {
    if let [document] = documents {
        return document.ocr.clone();
    }

    let mut transcript = Vec::with_capacity(documents.len());
    let mut weighted_confidence = 0.0;
    let mut confidence_weight = 0_i32;
    let mut page_count = 0_i32;

    for (index, document) in documents.iter().enumerate() {
        transcript.push(format!(
            "--- source {} of {}: {} ---\n{}",
            index + 1,
            documents.len(),
            document.source.file_name,
            document.ocr.text
        ));

        let weight = document.ocr.page_count.max(1);
        weighted_confidence += document.ocr.confidence * f64::from(weight);
        confidence_weight += weight;
        page_count += document.ocr.page_count;
    }

    DeliveryNoteOcrResult {
        text: transcript.join("\n\n"),
        confidence: if confidence_weight == 0 {
            0.0
        } else {
            weighted_confidence / f64::from(confidence_weight)
        },
        method: "mixed".to_owned(),
        page_count,
    }
}

const XLSX_ROWS_PER_LLM_REQUEST: usize = 25;

fn scan_transcript_chunks(transcript: &str, is_workbook: bool) -> Vec<String> {
    if !is_workbook {
        return vec![transcript.to_owned()];
    }

    let mut chunks = Vec::new();
    let mut sheet = String::new();
    let mut header = String::new();
    let mut rows = Vec::new();

    let flush = |chunks: &mut Vec<String>, sheet: &str, header: &str, rows: &mut Vec<String>| {
        if rows.is_empty() {
            return;
        }

        let mut lines = Vec::with_capacity(rows.len() + 2);
        if !sheet.is_empty() {
            lines.push(sheet.to_owned());
        }
        if !header.is_empty() {
            lines.push(header.to_owned());
        }
        lines.append(rows);
        chunks.push(lines.join("\n"));
    };

    for line in transcript
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
    {
        if line.starts_with("--- worksheet:") {
            flush(&mut chunks, &sheet, &header, &mut rows);
            sheet = line.to_owned();
            header.clear();
            continue;
        }
        if header.is_empty() {
            header = line.to_owned();
            continue;
        }

        rows.push(line.to_owned());
        if rows.len() == XLSX_ROWS_PER_LLM_REQUEST {
            flush(&mut chunks, &sheet, &header, &mut rows);
        }
    }

    flush(&mut chunks, &sheet, &header, &mut rows);

    if chunks.is_empty() {
        vec![transcript.to_owned()]
    } else {
        chunks
    }
}

fn merge_raw_scan_result(target: &mut RawScanResult, mut source: RawScanResult) {
    if target.document_type == RawScanDocumentType::DeliveryNote
        && source.document_type != RawScanDocumentType::DeliveryNote
    {
        target.document_type = source.document_type;
    }
    if target.supplier.is_none() {
        target.supplier = source.supplier.take();
    }
    if target.document_number.is_none() {
        target.document_number = source.document_number.take();
    }
    if target.document_date.is_none() {
        target.document_date = source.document_date.take();
    }
    if target.comment.is_none() {
        target.comment = source.comment.take();
    }
    target.lines.append(&mut source.lines);
}

async fn run_local_ocr(
    state: &AppState,
    auth: &crate::auth::AuthResult,
    input: &ParseScanInput,
) -> RpcResult<DeliveryNoteOcrResult> {
    let job_id = enqueue_scan_ocr(state, auth, input).await?;
    let deadline = tokio::time::Instant::now() + OCR_JOB_TIMEOUT;

    loop {
        let job = job_queue::get(state, job_id)
            .await?
            .ok_or_else(|| internal("OCR job disappeared"))?;

        match job.state.as_str() {
            "succeeded" => {
                let value = job
                    .result
                    .map(|result| result.0)
                    .ok_or_else(|| internal("OCR job completed without a result"))?;
                let result: DeliveryNoteOcrResult =
                    serde_json::from_value(value).map_err(internal)?;

                validate_ocr_result(&result)?;
                let _ = job_queue::delete_finished(state, job_id).await;

                return Ok(result);
            }
            "failed" => {
                let _ = job_queue::delete_finished(state, job_id).await;

                return Err(RpcError::new(
                    ErrorCode::PreconditionFailed,
                    job.last_error
                        .unwrap_or_else(|| "Local OCR failed".to_owned()),
                ));
            }
            _ if tokio::time::Instant::now() >= deadline => {
                return Err(RpcError::new(
                    ErrorCode::PreconditionFailed,
                    "Local OCR timed out",
                ));
            }
            _ => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

async fn enqueue_scan_ocr(
    state: &AppState,
    auth: &crate::auth::AuthResult,
    input: &ParseScanInput,
) -> RpcResult<i64> {
    job_queue::enqueue(
        state,
        &auth.tenant,
        DELIVERY_NOTE_OCR_JOB_TYPE,
        json!({
            "sourceObjectKey": input.object_key,
            "sourceMimeType": input.mime_type,
            "sourceFileName": input.file_name,
        }),
        1,
    )
    .await
}

fn validate_ocr_result(result: &DeliveryNoteOcrResult) -> RpcResult<()> {
    if !result.confidence.is_finite()
        || !(0.0..=1.0).contains(&result.confidence)
        || result.method.trim().is_empty()
        || !(0..=100).contains(&result.page_count)
        || result.text.len() > 2_000_000
    {
        return Err(internal("OCR runner returned an invalid result"));
    }

    Ok(())
}

async fn download_scan(
    storage: &object_storage::EnabledStorage,
    input: &ParseScanInput,
) -> RpcResult<Vec<u8>> {
    let download = object_storage::create_download_url(
        storage,
        &input.object_key,
        Some(&input.file_name),
        false,
        Audience::Internal,
    )?;
    let response = reqwest::Client::new()
        .get(download.download_url)
        .send()
        .await
        .map_err(internal)?;

    if !response.status().is_success() {
        return Err(RpcError::new(
            ErrorCode::PreconditionFailed,
            "The uploaded scan could not be read",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SCAN_BYTES as u64)
    {
        return Err(bad_request("scan exceeds the 20 MiB limit"));
    }

    let bytes = response.bytes().await.map_err(internal)?;
    if bytes.is_empty() || bytes.len() > MAX_SCAN_BYTES as usize {
        return Err(bad_request("invalid scan size"));
    }

    Ok(bytes.to_vec())
}

async fn normalize_scan_result(
    pool: &PgPool,
    raw: RawScanResult,
    locale: &str,
) -> RpcResult<DocumentScanResult> {
    let document_type = raw.document_type;

    match document_type {
        RawScanDocumentType::DeliveryNote => Ok(DocumentScanResult {
            document_type: ScanDocumentType::DeliveryNote,
            delivery_note: Some(normalize_delivery_note_result(pool, raw, locale).await?),
            price_list: None,
        }),
        RawScanDocumentType::PriceList | RawScanDocumentType::Invoice => {
            let document_type = if document_type == RawScanDocumentType::Invoice {
                ScanDocumentType::Invoice
            } else {
                ScanDocumentType::PriceList
            };

            Ok(DocumentScanResult {
                document_type,
                delivery_note: None,
                price_list: Some(normalize_price_list_result(pool, raw, locale).await?),
            })
        }
    }
}

async fn normalize_delivery_note_result(
    pool: &PgPool,
    raw: RawScanResult,
    locale: &str,
) -> RpcResult<DeliveryNoteScanResult> {
    if raw.lines.is_empty() {
        return Err(RpcError::new(
            ErrorCode::UnprocessableContent,
            "No delivery-note positions were recognized",
        ));
    }

    let mut records = Vec::new();
    let mut special_records = Vec::new();
    let mut warnings = Vec::new();

    for line in raw.lines {
        if !line.quantity.is_finite() || line.quantity <= 0.0 {
            return Err(RpcError::new(
                ErrorCode::UnprocessableContent,
                format!("Invalid quantity in recognized line: {}", line.source_text),
            ));
        }
        if line.name.trim().is_empty() || line.unit.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::UnprocessableContent,
                format!("Incomplete recognized line: {}", line.source_text),
            ));
        }

        let product = match line.product_id {
            Some(product_id) => sqlx::query_as::<_, ScanProduct>(
                r#"
                    SELECT id, custom_id, name, base_unit, other_units
                    FROM products
                    WHERE id = $1
                    "#,
            )
            .bind(product_id.0)
            .fetch_optional(pool)
            .await
            .map_err(internal)?,
            None => None,
        };

        let Some(product) = product else {
            if line.product_id.is_some() {
                let warning = if locale == "en" {
                    format!(
                        "“{}” could not be matched to an existing product because the suggested product ID was invalid.",
                        line.source_text
                    )
                } else {
                    format!(
                        "„{}“ konnte keinem vorhandenen Produkt zugeordnet werden, da die vorgeschlagene Produkt-ID ungültig war.",
                        line.source_text
                    )
                };

                warnings.push(warning);
            }

            special_records.push(special_from_line(line));
            continue;
        };

        let Some((unit, factor)) = product_unit_factor(&product, &line.unit) else {
            let warning = if locale == "en" {
                format!(
                    "“{}” uses the unit “{}”, which is not registered for “{}”, and was therefore added as a special item.",
                    line.source_text, line.unit, product.name
                )
            } else {
                format!(
                    "„{}“ verwendet die für „{}“ unbekannte Einheit „{}“ und wurde deshalb als Sonderposten übernommen.",
                    line.source_text, product.name, line.unit
                )
            };

            warnings.push(warning);
            special_records.push(special_from_line(line));
            continue;
        };

        records.push(ScannedProductRecord {
            source_text: line.source_text,
            product_id: Id(product.id),
            custom_id: product.custom_id,
            product_name: product.name,
            quantity: line.quantity * factor,
            display_quantity: line.quantity,
            unit,
            base_unit: product.base_unit,
            confidence: line.confidence.clamp(0.0, 1.0),
            comment: clean_optional_text(line.comment),
        });
    }

    Ok(DeliveryNoteScanResult {
        supplier: clean_optional_text(raw.supplier),
        delivery_number: clean_optional_text(raw.document_number),
        delivery_date: validate_optional_date(raw.document_date, &mut warnings, locale),
        comment: clean_optional_text(raw.comment),
        records,
        special_records,
        warnings,
    })
}

async fn normalize_price_list_result(
    pool: &PgPool,
    raw: RawScanResult,
    locale: &str,
) -> RpcResult<PriceListScanResult> {
    if raw.lines.is_empty() {
        return Err(RpcError::new(
            ErrorCode::UnprocessableContent,
            "No price rows were recognized",
        ));
    }

    let mut rows = Vec::with_capacity(raw.lines.len());
    let mut warnings = Vec::new();

    for line in raw.lines {
        let Some(source_price) = line
            .price_per_unit
            .filter(|price| price.is_finite() && *price >= 0.0)
        else {
            let warning = if locale == "en" {
                format!(
                    "“{}” has no usable net price and was skipped.",
                    line.source_text
                )
            } else {
                format!(
                    "„{}“ enthält keinen verwendbaren Nettopreis und wurde übersprungen.",
                    line.source_text
                )
            };
            warnings.push(warning);
            continue;
        };

        if line.name.trim().is_empty() || line.unit.trim().is_empty() {
            let warning = if locale == "en" {
                format!("“{}” is incomplete and was skipped.", line.source_text)
            } else {
                format!(
                    "„{}“ ist unvollständig und wurde übersprungen.",
                    line.source_text
                )
            };
            warnings.push(warning);
            continue;
        }

        let product = match line.product_id {
            Some(product_id) => sqlx::query_as::<_, ScanProduct>(
                r#"
                SELECT id, custom_id, name, base_unit, other_units
                FROM products
                WHERE id = $1
                "#,
            )
            .bind(product_id.0)
            .fetch_optional(pool)
            .await
            .map_err(internal)?,
            None => None,
        };

        let normalized = product.and_then(|product| {
            product_unit_factor(&product, &line.unit).map(|(source_unit, factor)| ScannedPriceRow {
                source_text: line.source_text.clone(),
                product_id: Some(Id(product.id)),
                custom_id: Some(product.custom_id),
                product_name: product.name,
                base_unit: product.base_unit,
                source_unit,
                price_per_base_unit: source_price / factor,
                confidence: line.confidence.clamp(0.0, 1.0),
                comment: clean_optional_text(line.comment.clone()),
            })
        });

        if let Some(row) = normalized {
            rows.push(row);
            continue;
        }

        if line.product_id.is_some() {
            let warning = if locale == "en" {
                format!(
                    "“{}” could not be converted to a catalogue unit and is proposed as a new product.",
                    line.source_text
                )
            } else {
                format!(
                    "„{}“ konnte nicht in eine Katalogeinheit umgerechnet werden und wird als neues Produkt vorgeschlagen.",
                    line.source_text
                )
            };
            warnings.push(warning);
        }

        rows.push(ScannedPriceRow {
            source_text: line.source_text,
            product_id: None,
            custom_id: None,
            product_name: line.name.trim().to_owned(),
            base_unit: line.unit.trim().to_owned(),
            source_unit: line.unit.trim().to_owned(),
            price_per_base_unit: source_price,
            confidence: line.confidence.clamp(0.0, 1.0),
            comment: clean_optional_text(line.comment),
        });
    }

    if rows.is_empty() {
        return Err(RpcError::new(
            ErrorCode::UnprocessableContent,
            "No usable price rows were recognized",
        ));
    }

    Ok(PriceListScanResult {
        supplier: clean_optional_text(raw.supplier),
        document_number: clean_optional_text(raw.document_number),
        effective_date: validate_optional_date(raw.document_date, &mut warnings, locale),
        rows,
        warnings,
    })
}

fn product_unit_factor(product: &ScanProduct, scanned_unit: &str) -> Option<(String, f64)> {
    let scanned_unit = scanned_unit.trim();

    if scanned_unit.eq_ignore_ascii_case(&product.base_unit) {
        return Some((product.base_unit.clone(), 1.0));
    }

    product
        .other_units
        .0
        .as_object()?
        .iter()
        .find(|(unit, _)| unit.eq_ignore_ascii_case(scanned_unit))
        .and_then(|(unit, factor)| {
            factor
                .as_f64()
                .filter(|factor| factor.is_finite() && *factor > 0.0)
                .map(|factor| (unit.clone(), factor))
        })
}

fn special_from_line(line: RawScanLine) -> ScannedSpecialRecord {
    ScannedSpecialRecord {
        source_text: line.source_text,
        name: line.name.trim().to_owned(),
        unit: line.unit.trim().to_owned(),
        amount: line.quantity,
        price_per_unit: line
            .price_per_unit
            .filter(|price| price.is_finite() && *price >= 0.0),
        confidence: line.confidence.clamp(0.0, 1.0),
        comment: clean_optional_text(line.comment),
    }
}

fn validate_optional_date(
    date: Option<String>,
    warnings: &mut Vec<String>,
    locale: &str,
) -> Option<String> {
    let date = clean_optional_text(date)?;

    if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_ok() {
        Some(date)
    } else {
        let warning = if locale == "en" {
            format!("The recognized date “{date}” could not be used.")
        } else {
            format!("Das erkannte Datum „{date}“ konnte nicht übernommen werden.")
        };

        warnings.push(warning);
        None
    }
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn validate_scan_file(file_name: &str, mime_type: &str, size_bytes: i64) -> RpcResult<()> {
    if file_name.trim().is_empty() || file_name.len() > 255 {
        return Err(bad_request("invalid scan fileName"));
    }
    if !(1..=MAX_SCAN_BYTES).contains(&size_bytes) {
        return Err(bad_request("scan must contain at most 20 MiB"));
    }
    if !matches!(
        mime_type,
        "application/pdf"
            | "image/jpeg"
            | "image/png"
            | "image/webp"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
        return Err(bad_request(
            "scan must be a PDF, XLSX, JPEG, PNG, or WebP file",
        ));
    }

    Ok(())
}

fn validate_scan_documents(documents: &[ParseScanInput]) -> RpcResult<()> {
    if documents.is_empty() || documents.len() > MAX_SCAN_FILES {
        return Err(bad_request("a scan must contain between 1 and 20 files"));
    }

    let mut total_bytes = 0_i64;
    for document in documents {
        validate_scan_file(
            &document.file_name,
            &document.mime_type,
            document.size_bytes,
        )?;

        total_bytes = total_bytes
            .checked_add(document.size_bytes)
            .ok_or_else(|| bad_request("invalid total scan size"))?;
    }

    if total_bytes > MAX_SCAN_TOTAL_BYTES {
        return Err(bad_request(
            "scan files must contain at most 100 MiB in total",
        ));
    }

    Ok(())
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

fn optional_timestamp(input: &Map<String, Value>, key: &str) -> RpcResult<Option<DateTime<Utc>>> {
    let Some(value) = optional_input_string(input, key) else {
        return Ok(None);
    };

    DateTime::parse_from_rfc3339(value)
        .map(|value| Some(value.with_timezone(&Utc)))
        .map_err(|_| bad_request(format!("invalid {key}")))
}

fn success() -> Value {
    json!({ "success": true })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        DeliveryNoteOcrResult, MAX_SCAN_BYTES, ParseScanInput, RecognizedScanDocument, ScanProduct,
        combine_ocr_documents, parse_product_records, parse_special_records, product_unit_factor,
        scan_transcript_chunks, validate_scan_documents, validate_scan_file,
    };
    use sqlx::types::Json;

    #[test]
    fn requires_at_least_one_record_for_creation() {
        let input = json!({
            "records": [],
            "specialRecords": []
        });

        let products = parse_product_records(input.get("records")).unwrap();
        let specials = parse_special_records(input.get("specialRecords")).unwrap();

        assert!(products.is_empty() && specials.is_empty());
    }

    #[test]
    fn scan_matching_uses_catalogue_unit_factors() {
        let product = ScanProduct {
            id: 1,
            custom_id: 42,
            name: "Kalkzementputz".to_owned(),
            base_unit: "kg".to_owned(),
            other_units: Json(json!({ "Sack": 25 })),
        };

        assert_eq!(
            product_unit_factor(&product, "sack"),
            Some(("Sack".to_owned(), 25.0))
        );
        assert_eq!(
            product_unit_factor(&product, "KG"),
            Some(("kg".to_owned(), 1.0))
        );
        assert_eq!(product_unit_factor(&product, "Palette"), None);
    }

    #[test]
    fn workbook_transcripts_are_split_with_context_for_every_section() {
        let rows = (1..=85)
            .map(|index| format!("Artikel {index}\tStk\t{index}.50"))
            .collect::<Vec<_>>()
            .join("\n");
        let transcript = format!("--- worksheet: Preisliste ---\nArtikel\tEinheit\tPreis\n{rows}");

        let chunks = scan_transcript_chunks(&transcript, true);

        assert_eq!(chunks.len(), 4);
        assert!(chunks.iter().all(|chunk| {
            chunk.starts_with("--- worksheet: Preisliste ---\nArtikel\tEinheit\tPreis\n")
        }));
        assert!(chunks[0].contains("Artikel 25\tStk\t25.50"));
        assert!(chunks[1].contains("Artikel 50\tStk\t50.50"));
        assert!(chunks[2].contains("Artikel 75\tStk\t75.50"));
        assert!(chunks[3].contains("Artikel 85\tStk\t85.50"));
    }

    #[test]
    fn scan_upload_accepts_camera_images_and_pdfs_but_rejects_unsafe_inputs() {
        assert!(validate_scan_file("lieferschein.pdf", "application/pdf", 1024).is_ok());
        assert!(validate_scan_file("foto.jpg", "image/jpeg", 1024).is_ok());
        assert!(validate_scan_file("foto.webp", "image/webp", 1024).is_ok());
        assert!(
            validate_scan_file(
                "preisliste.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                1024
            )
            .is_ok()
        );

        assert!(validate_scan_file("scan.svg", "image/svg+xml", 1024).is_err());
        assert!(validate_scan_file("scan.png", "image/png", 0).is_err());
        assert!(validate_scan_file("scan.png", "image/png", MAX_SCAN_BYTES + 1).is_err());
    }

    #[test]
    fn grouped_scans_keep_source_order_and_enforce_limits() {
        let document = |name: &str, text: &str| RecognizedScanDocument {
            source: ParseScanInput {
                object_key: format!("scans/{name}"),
                file_name: name.to_owned(),
                mime_type: "image/png".to_owned(),
                size_bytes: 1024,
            },
            ocr: DeliveryNoteOcrResult {
                text: text.to_owned(),
                confidence: 0.8,
                method: "tesseract".to_owned(),
                page_count: 1,
            },
            error: None,
        };
        let documents = vec![
            document("seite-1.png", "Erste Seite"),
            document("seite-2.png", "Zweite Seite"),
        ];
        let combined = combine_ocr_documents(&documents);

        assert!(
            combined.text.find("seite-1.png").unwrap() < combined.text.find("seite-2.png").unwrap()
        );
        assert!(combined.text.contains("Erste Seite"));
        assert!(combined.text.contains("Zweite Seite"));
        assert_eq!(combined.page_count, 2);

        let sources = documents
            .iter()
            .map(|document| document.source.clone())
            .collect::<Vec<_>>();
        assert!(validate_scan_documents(&sources).is_ok());
        assert!(validate_scan_documents(&[]).is_err());

        let too_many = vec![sources[0].clone(); 21];
        assert!(validate_scan_documents(&too_many).is_err());
    }
}
