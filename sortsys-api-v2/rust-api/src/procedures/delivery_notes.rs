//! Product delivery notes and their cost calculation.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgPool};

use super::common::{
    authorized_pool, bad_request, forbidden, input_id, input_object, input_string, internal,
    not_found, optional_input_id, optional_input_string,
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

    builder.query_json("deliveryNotes.costs.get", move |context, input| {
        let state = Arc::clone(&state);

        async move { costs(&state, &context, input).await }
    })
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

    use super::{parse_product_records, parse_special_records};

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
}
