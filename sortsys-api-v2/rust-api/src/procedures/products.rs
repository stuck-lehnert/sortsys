//! Product catalogue, vendor, category, unit, and price-record procedures.

use std::{collections::HashSet, sync::Arc};

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
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query_json("products.list", move |context, input| {
        let state = Arc::clone(&list_state);

        async move { list_products(&state, &context, input).await }
    });

    let get_state = Arc::clone(&state);
    builder = builder.query_json("products.get", move |context, input| {
        let state = Arc::clone(&get_state);

        async move { get_product(&state, &context, input).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("products.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create_product(&state, &context, input).await }
    });

    let update_state = Arc::clone(&state);
    builder = builder.mutation_json("products.update", move |context, input| {
        let state = Arc::clone(&update_state);

        async move { update_product(&state, &context, input).await }
    });

    let delete_state = Arc::clone(&state);
    builder = builder.mutation_json("products.delete", move |context, input| {
        let state = Arc::clone(&delete_state);

        async move { delete_product(&state, &context, input).await }
    });

    let category_list_state = Arc::clone(&state);
    builder = builder.query_json("products.categories.list", move |context, input| {
        let state = Arc::clone(&category_list_state);

        async move { list_categories(&state, &context, input).await }
    });

    let category_tag_state = Arc::clone(&state);
    builder = builder.mutation_json("products.categories.tag", move |context, input| {
        let state = Arc::clone(&category_tag_state);

        async move { tag_category(&state, &context, input).await }
    });

    let category_untag_state = Arc::clone(&state);
    builder = builder.mutation_json("products.categories.untag", move |context, input| {
        let state = Arc::clone(&category_untag_state);

        async move { untag_category(&state, &context, input).await }
    });

    let category_set_state = Arc::clone(&state);
    builder = builder.mutation_json("products.categories.set", move |context, input| {
        let state = Arc::clone(&category_set_state);

        async move { set_categories(&state, &context, input).await }
    });

    let unit_state = Arc::clone(&state);
    builder = builder.query_json("products.units.list", move |context, input| {
        let state = Arc::clone(&unit_state);

        async move { list_units(&state, &context, input).await }
    });

    let brand_state = Arc::clone(&state);
    builder = builder.query_json("products.brands.list", move |context, input| {
        let state = Arc::clone(&brand_state);

        async move { list_brands(&state, &context, input).await }
    });

    let vendor_list_state = Arc::clone(&state);
    builder = builder.query_json("products.vendors.list", move |context, input| {
        let state = Arc::clone(&vendor_list_state);

        async move { list_vendors(&state, &context, input).await }
    });

    let vendor_get_state = Arc::clone(&state);
    builder = builder.query_json("products.vendors.get", move |context, input| {
        let state = Arc::clone(&vendor_get_state);

        async move { get_vendor(&state, &context, input).await }
    });

    let vendor_create_state = Arc::clone(&state);
    builder = builder.mutation_json("products.vendors.create", move |context, input| {
        let state = Arc::clone(&vendor_create_state);

        async move { create_vendor(&state, &context, input).await }
    });

    let vendor_update_state = Arc::clone(&state);
    builder = builder.mutation_json("products.vendors.update", move |context, input| {
        let state = Arc::clone(&vendor_update_state);

        async move { update_vendor(&state, &context, input).await }
    });

    let vendor_delete_state = Arc::clone(&state);
    builder = builder.mutation_json("products.vendors.delete", move |context, input| {
        let state = Arc::clone(&vendor_delete_state);

        async move { delete_vendor(&state, &context, input).await }
    });

    let price_list_state = Arc::clone(&state);
    builder = builder.query_json("products.priceRecords.list", move |context, input| {
        let state = Arc::clone(&price_list_state);

        async move { list_price_records(&state, &context, input).await }
    });

    let price_create_state = Arc::clone(&state);
    builder = builder.mutation_json("products.priceRecords.create", move |context, input| {
        let state = Arc::clone(&price_create_state);

        async move { create_price_record(&state, &context, input).await }
    });

    let price_update_state = Arc::clone(&state);
    builder = builder.mutation_json("products.priceRecords.update", move |context, input| {
        let state = Arc::clone(&price_update_state);

        async move { update_price_record(&state, &context, input).await }
    });

    let price_delete_state = Arc::clone(&state);
    builder = builder.mutation_json("products.priceRecords.delete", move |context, input| {
        let state = Arc::clone(&price_delete_state);

        async move { delete_price_record(&state, &context, input).await }
    });

    let price_import_state = Arc::clone(&state);
    builder = builder.mutation(
        "products.priceImports.apply",
        move |context, input: ApplyPriceImportInput| {
            let state = Arc::clone(&price_import_state);

            async move { apply_price_import(&state, &context, input).await }
        },
    );

    builder.query_json("products.suggestNextCustomId", move |context, input| {
        let state = Arc::clone(&state);

        async move { suggest_next_custom_id(&state, &context, input).await }
    })
}

pub fn register_contract(mut builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder = builder.mutation_stub::<ApplyPriceImportInput, ApplyPriceImportResult>(
        "products.priceImports.apply",
    );

    builder
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyPriceImportInput {
    vendor_id: Id,
    #[ts(type = "Date")]
    effective_at: DateTime<Utc>,
    is_real_purchase: bool,
    rows: Vec<ApplyPriceImportRow>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyPriceImportRow {
    product_id: Option<Id>,
    product_name: String,
    base_unit: String,
    price_per_base_unit: f64,
    comment: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ApplyPriceImportResult {
    created_products: usize,
    created_price_records: usize,
}

#[derive(FromRow)]
struct ProductRow {
    id: i64,
    custom_id: i32,
    name: String,
    brand: Option<String>,
    description: Option<String>,
    base_unit: String,
    other_units: Json<Value>,
    categories: Vec<String>,
}

impl ProductRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "customId": self.custom_id,
            "name": self.name,
            "brand": self.brand,
            "description": self.description,
            "baseUnit": self.base_unit,
            "otherUnits": self.other_units.0,
            "categories": self.categories,
        })
    }
}

const PRODUCT_SELECT: &str = r#"
    SELECT
        product.id,
        product.custom_id,
        product.name,
        product.brand,
        product.description,
        product.base_unit,
        product.other_units,
        ARRAY_REMOVE(
            ARRAY_AGG(
                category.category
                ORDER BY LOWER(category.category)
            ),
            NULL
        ) AS categories
    FROM products AS product
    LEFT JOIN product_categories AS category
      ON category.product_id = product.id
     AND ($1::text IS NULL OR category.category = $1)
"#;

async fn list_products(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:products").await?;
    let input = input_object(&input)?;

    let category = optional_input_string(input, "category")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let search = optional_input_string(input, "search")
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let sql = format!(
        r#"
        {PRODUCT_SELECT}
        WHERE (
            $1::text IS NULL
            OR EXISTS (
                SELECT 1
                FROM product_categories AS filter_category
                WHERE filter_category.product_id = product.id
                  AND filter_category.category = $1
            )
        )
          AND (
              $2::text IS NULL
              OR product._search @@ create_query($2)
          )
        GROUP BY product.id
        ORDER BY product.custom_id
        "#
    );

    let rows = sqlx::query_as::<_, ProductRow>(&sql)
        .bind(category)
        .bind(search)
        .fetch_all(&pool)
        .await
        .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter().map(ProductRow::into_wire_value).collect(),
    ))
}

async fn get_product(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:products").await?;
    let product_id = input_id(input_object(&input)?, "id")?;

    let sql = format!(
        r#"
        {PRODUCT_SELECT}
        WHERE product.id = $2
        GROUP BY product.id
        "#
    );

    let row = sqlx::query_as::<_, ProductRow>(&sql)
        .bind(Option::<String>::None)
        .bind(product_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;

    Ok(row.into_wire_value())
}

async fn create_product(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:products").await?;
    let product = ProductData::for_create(input_object(&input)?)?;

    let product_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO products (
            custom_id,
            name,
            brand,
            description,
            base_unit,
            other_units
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(product.custom_id)
    .bind(product.name)
    .bind(product.brand)
    .bind(product.description)
    .bind(product.base_unit)
    .bind(Json(product.other_units))
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "id": Id(product_id) }))
}

async fn update_product(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:products").await?;
    let input = input_object(&input)?;
    let product_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let current = load_product_data(&pool, product_id).await?;
    let product = ProductData::apply_changes(current, changes)?;

    sqlx::query(
        r#"
        UPDATE products
        SET
            custom_id = $2,
            name = $3,
            brand = $4,
            description = $5,
            base_unit = $6,
            other_units = $7
        WHERE id = $1
        "#,
    )
    .bind(product_id)
    .bind(product.custom_id)
    .bind(product.name)
    .bind(product.brand)
    .bind(product.description)
    .bind(product.base_unit)
    .bind(Json(product.other_units))
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(success())
}

async fn delete_product(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:products").await?;
    let product_id = input_id(input_object(&input)?, "id")?;

    delete_by_id(&pool, "products", product_id).await?;

    Ok(success())
}

struct ProductData {
    custom_id: i32,
    name: String,
    brand: Option<String>,
    description: Option<String>,
    base_unit: String,
    other_units: Value,
}

impl ProductData {
    fn for_create(input: &Map<String, Value>) -> RpcResult<Self> {
        let custom_id = require_nonnegative_i32(input, "customId")?;
        let name = required_text(input, "name", 255)?;
        let brand = nullable_text(input, "brand", 127)?;
        let description = nullable_text(input, "description", 511)?;
        let base_unit = required_text(input, "baseUnit", 8)?;
        let other_units = input
            .get("otherUnits")
            .cloned()
            .unwrap_or_else(|| json!({}));

        require_json_object(&other_units, "otherUnits")?;

        Ok(Self {
            custom_id,
            name,
            brand,
            description,
            base_unit,
            other_units,
        })
    }

    fn apply_changes(current: Self, changes: &Map<String, Value>) -> RpcResult<Self> {
        let custom_id = if changes.contains_key("customId") {
            require_nonnegative_i32(changes, "customId")?
        } else {
            current.custom_id
        };
        let name = if changes.contains_key("name") {
            required_text(changes, "name", 255)?
        } else {
            current.name
        };
        let brand = if changes.contains_key("brand") {
            nullable_text(changes, "brand", 127)?
        } else {
            current.brand
        };
        let description = if changes.contains_key("description") {
            nullable_text(changes, "description", 511)?
        } else {
            current.description
        };
        let base_unit = if changes.contains_key("baseUnit") {
            required_text(changes, "baseUnit", 10)?
        } else {
            current.base_unit
        };
        let other_units = if let Some(other_units) = changes.get("otherUnits") {
            require_json_object(other_units, "otherUnits")?;

            other_units.clone()
        } else {
            current.other_units
        };

        Ok(Self {
            custom_id,
            name,
            brand,
            description,
            base_unit,
            other_units,
        })
    }
}

#[derive(FromRow)]
struct ProductDataRow {
    custom_id: i32,
    name: String,
    brand: Option<String>,
    description: Option<String>,
    base_unit: String,
    other_units: Json<Value>,
}

async fn load_product_data(pool: &PgPool, product_id: i64) -> RpcResult<ProductData> {
    let row = sqlx::query_as::<_, ProductDataRow>(
        r#"
            SELECT
                custom_id,
                name,
                brand,
                description,
                base_unit,
                other_units
            FROM products
            WHERE id = $1
            "#,
    )
    .bind(product_id)
    .fetch_optional(pool)
    .await
    .map_err(internal)?;

    let row = row.ok_or_else(not_found)?;

    Ok(ProductData {
        custom_id: row.custom_id,
        name: row.name,
        brand: row.brand,
        description: row.description,
        base_unit: row.base_unit,
        other_units: row.other_units.0,
    })
}

async fn list_categories(
    state: &AppState,
    context: &RequestContext,
    _input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:products").await?;

    let categories: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT category
        FROM (
            SELECT DISTINCT category
            FROM product_categories
        ) AS categories
        ORDER BY LOWER(category)
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(json!(categories))
}

async fn tag_category(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:products").await?;
    let input = input_object(&input)?;

    let product_id = input_id(input, "id")?;
    let category = required_text(input, "category", 127)?;

    sqlx::query(
        r#"
        INSERT INTO product_categories (product_id, category)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(product_id)
    .bind(category)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(success())
}

async fn untag_category(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:products").await?;
    let input = input_object(&input)?;

    let product_id = input_id(input, "id")?;
    let category = required_text(input, "category", 127)?.to_lowercase();

    sqlx::query(
        r#"
        DELETE FROM product_categories
        WHERE product_id = $1
          AND LOWER(category) = $2
        "#,
    )
    .bind(product_id)
    .bind(category)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(success())
}

async fn set_categories(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:products").await?;
    let input = input_object(&input)?;

    let product_id = input_id(input, "id")?;
    let categories = input
        .get("categories")
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request("missing categories"))?;

    // Category uniqueness is case-insensitive. Preserve the first spelling
    // supplied by the client, exactly as the former Map-based code did.
    let mut normalized = HashSet::new();
    let mut unique_categories = Vec::new();
    for category in categories {
        let category = category
            .as_str()
            .ok_or_else(|| bad_request("invalid category"))?
            .trim();
        if category.is_empty() || category.len() > 127 {
            return Err(bad_request("invalid category"));
        }

        if normalized.insert(category.to_lowercase()) {
            unique_categories.push(category.to_owned());
        }
    }

    let mut transaction = pool.begin().await.map_err(internal)?;
    sqlx::query("DELETE FROM product_categories WHERE product_id = $1")
        .bind(product_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;

    for category in unique_categories {
        sqlx::query(
            r#"
            INSERT INTO product_categories (product_id, category)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(product_id)
        .bind(category)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    }

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

async fn list_units(state: &AppState, context: &RequestContext, _input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:products").await?;

    let units: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT UNNEST(_units) AS unit FROM products")
            .fetch_all(&pool)
            .await
            .map_err(internal)?;

    Ok(json!(units))
}

async fn list_brands(
    state: &AppState,
    context: &RequestContext,
    _input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:products").await?;

    let brands: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT brand
        FROM (
            SELECT DISTINCT brand
            FROM products
            WHERE brand IS NOT NULL
        ) AS brands
        ORDER BY LOWER(brand)
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(json!(brands))
}

#[derive(FromRow)]
struct VendorRow {
    id: i64,
    name: String,
    description: Option<String>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}

impl VendorRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "name": self.name,
            "description": self.description,
            "createdAt": self.created_at,
            "modifiedAt": self.modified_at,
        })
    }
}

async fn list_vendors(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:productVendors").await?;
    let input = input_object(&input)?;
    let search = optional_input_string(input, "search")
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let rows = sqlx::query_as::<_, VendorRow>(
        r#"
        SELECT id, name, description, created_at, modified_at
        FROM product_vendors
        WHERE $1::text IS NULL OR _search @@ create_query($1)
        ORDER BY LOWER(name)
        "#,
    )
    .bind(search)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter().map(VendorRow::into_wire_value).collect(),
    ))
}

async fn get_vendor(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:productVendors").await?;
    let vendor_id = input_id(input_object(&input)?, "id")?;

    let row = load_vendor(&pool, vendor_id).await?;

    Ok(row.into_wire_value())
}

async fn create_vendor(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:productVendors").await?;
    let input = input_object(&input)?;

    let name = required_text(input, "name", 127)?;
    let description = nullable_text(input, "description", 255)?;

    let vendor_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO product_vendors (name, description)
        VALUES ($1, $2)
        RETURNING id
        "#,
    )
    .bind(name)
    .bind(description)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "id": Id(vendor_id) }))
}

async fn update_vendor(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:productVendors").await?;
    let input = input_object(&input)?;
    let vendor_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let current = load_vendor(&pool, vendor_id).await?;
    let name = if changes.contains_key("name") {
        required_text(changes, "name", 127)?
    } else {
        current.name
    };
    let description = if changes.contains_key("description") {
        nullable_text(changes, "description", 255)?
    } else {
        current.description
    };

    sqlx::query(
        r#"
        UPDATE product_vendors
        SET name = $2, description = $3
        WHERE id = $1
        "#,
    )
    .bind(vendor_id)
    .bind(name)
    .bind(description)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(success())
}

async fn delete_vendor(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:productVendors").await?;
    let vendor_id = input_id(input_object(&input)?, "id")?;

    delete_by_id(&pool, "product_vendors", vendor_id).await?;

    Ok(success())
}

async fn load_vendor(pool: &PgPool, vendor_id: i64) -> RpcResult<VendorRow> {
    sqlx::query_as::<_, VendorRow>(
        r#"
        SELECT id, name, description, created_at, modified_at
        FROM product_vendors
        WHERE id = $1
        "#,
    )
    .bind(vendor_id)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)
}

#[derive(FromRow)]
struct PriceRecordRow {
    id: i64,
    product_id: i64,
    vendor_id: Option<i64>,
    timestamp: DateTime<Utc>,
    price: f64,
    is_real_purchase: bool,
    comment: Option<String>,
}

impl PriceRecordRow {
    fn into_wire_value(self) -> Value {
        json!({
            "id": Id(self.id),
            "productId": Id(self.product_id),
            "vendorId": self.vendor_id.map(Id),
            "timestamp": self.timestamp,
            "price": self.price,
            "isRealPurchase": self.is_real_purchase,
            "comment": self.comment,
        })
    }
}

async fn list_price_records(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:productPriceRecords").await?;
    let input = input_object(&input)?;

    let product_id = optional_input_id(input, "productId")?;
    let vendor_id = optional_input_id(input, "vendorId")?;
    let is_real_purchase = input.get("isRealPurchase").and_then(Value::as_bool);

    let rows = sqlx::query_as::<_, PriceRecordRow>(
        r#"
        SELECT
            id,
            product_id,
            vendor_id,
            timestamp,
            price,
            is_real_purchase,
            comment
        FROM product_price_records
        WHERE ($1::bigint IS NULL OR product_id = $1)
          AND ($2::bigint IS NULL OR vendor_id = $2)
          AND ($3::bool IS NULL OR is_real_purchase = $3)
        ORDER BY timestamp DESC
        "#,
    )
    .bind(product_id)
    .bind(vendor_id)
    .bind(is_real_purchase)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(Value::Array(
        rows.into_iter()
            .map(PriceRecordRow::into_wire_value)
            .collect(),
    ))
}

async fn create_price_record(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    // This intentionally retains the legacy procedure's view-role check.
    // Changing it would be an authorization-contract change during migration.
    let (_, pool) = authorized_pool(state, context, "view:productPriceRecords").await?;
    let record = PriceRecordData::for_create(input_object(&input)?)?;

    let record_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO product_price_records (
            product_id,
            vendor_id,
            price,
            timestamp,
            is_real_purchase,
            comment
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(record.product_id)
    .bind(record.vendor_id)
    .bind(record.price)
    .bind(record.timestamp)
    .bind(record.is_real_purchase)
    .bind(record.comment)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "id": Id(record_id) }))
}

async fn apply_price_import(
    state: &AppState,
    context: &RequestContext,
    input: ApplyPriceImportInput,
) -> RpcResult<ApplyPriceImportResult> {
    let (auth, pool) = authorized_pool(state, context, "view:productPriceRecords").await?;

    if input.rows.is_empty() || input.rows.len() > 20_000 {
        return Err(bad_request(
            "price import must contain between 1 and 20000 rows",
        ));
    }
    if input.rows.iter().any(|row| row.product_id.is_none()) && !auth.can_do("manage:products") {
        return Err(forbidden());
    }

    let vendor_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM product_vendors WHERE id = $1)")
            .bind(input.vendor_id.0)
            .fetch_one(&pool)
            .await
            .map_err(internal)?;
    if !vendor_exists {
        return Err(bad_request("selected vendor does not exist"));
    }

    for row in &input.rows {
        if !row.price_per_base_unit.is_finite() || row.price_per_base_unit < 0.0 {
            return Err(bad_request("price import contains an invalid net price"));
        }
        if row.product_name.trim().is_empty() || row.product_name.trim().len() > 255 {
            return Err(bad_request("price import contains an invalid product name"));
        }
        if row.base_unit.trim().is_empty() || row.base_unit.trim().len() > 10 {
            return Err(bad_request("price import contains an invalid base unit"));
        }
        if row
            .comment
            .as_deref()
            .is_some_and(|comment| comment.len() > 255)
        {
            return Err(bad_request("price import contains an overlong comment"));
        }
    }

    let mut transaction = pool.begin().await.map_err(internal)?;

    // Product numbers are tenant-local and sequential. The transaction lock
    // prevents two simultaneous imports from allocating the same number.
    sqlx::query("SELECT pg_advisory_xact_lock(736678011)")
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    let mut next_custom_id: i32 =
        sqlx::query_scalar("SELECT COALESCE(MAX(custom_id), 0) + 1 FROM products")
            .fetch_one(&mut *transaction)
            .await
            .map_err(internal)?;

    let mut created_products = 0;
    let mut created_price_records = 0;

    for row in input.rows {
        let product_id = if let Some(product_id) = row.product_id {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM products WHERE id = $1)")
                    .bind(product_id.0)
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(internal)?;
            if !exists {
                return Err(bad_request("price import references a missing product"));
            }

            product_id.0
        } else {
            let product_id: i64 = sqlx::query_scalar(
                r#"
                INSERT INTO products (
                    custom_id,
                    name,
                    brand,
                    description,
                    base_unit,
                    other_units
                )
                VALUES ($1, $2, NULL, NULL, $3, '{}'::jsonb)
                RETURNING id
                "#,
            )
            .bind(next_custom_id)
            .bind(row.product_name.trim())
            .bind(row.base_unit.trim())
            .fetch_one(&mut *transaction)
            .await
            .map_err(internal)?;

            next_custom_id = next_custom_id
                .checked_add(1)
                .ok_or_else(|| bad_request("no product numbers remain"))?;
            created_products += 1;
            product_id
        };

        sqlx::query(
            r#"
            INSERT INTO product_price_records (
                product_id,
                vendor_id,
                price,
                timestamp,
                is_real_purchase,
                comment
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(product_id)
        .bind(input.vendor_id.0)
        .bind(row.price_per_base_unit)
        .bind(input.effective_at)
        .bind(input.is_real_purchase)
        .bind(
            row.comment
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        )
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
        created_price_records += 1;
    }

    transaction.commit().await.map_err(internal)?;

    Ok(ApplyPriceImportResult {
        created_products,
        created_price_records,
    })
}

async fn update_price_record(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "manage:productPriceRecords").await?;
    let input = input_object(&input)?;
    let record_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    let current = load_price_record(&pool, record_id).await?;
    let record = PriceRecordData::apply_changes(current, changes)?;

    sqlx::query(
        r#"
        UPDATE product_price_records
        SET
            product_id = $2,
            vendor_id = $3,
            price = $4,
            timestamp = $5,
            is_real_purchase = $6,
            comment = $7
        WHERE id = $1
        "#,
    )
    .bind(record_id)
    .bind(record.product_id)
    .bind(record.vendor_id)
    .bind(record.price)
    .bind(record.timestamp)
    .bind(record.is_real_purchase)
    .bind(record.comment)
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(success())
}

async fn delete_price_record(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "delete:productPriceRecords").await?;
    let record_id = input_id(input_object(&input)?, "id")?;

    delete_by_id(&pool, "product_price_records", record_id).await?;

    Ok(success())
}

#[derive(FromRow)]
struct PriceRecordData {
    product_id: i64,
    vendor_id: Option<i64>,
    timestamp: DateTime<Utc>,
    price: f64,
    is_real_purchase: bool,
    comment: Option<String>,
}

impl PriceRecordData {
    fn for_create(input: &Map<String, Value>) -> RpcResult<Self> {
        Ok(Self {
            product_id: input_id(input, "productId")?,
            vendor_id: optional_input_id(input, "vendorId")?,
            timestamp: require_timestamp(input, "timestamp")?,
            price: require_number(input, "pricePerBaseUnit")?,
            is_real_purchase: input
                .get("isRealPurchase")
                .and_then(Value::as_bool)
                .ok_or_else(|| bad_request("missing isRealPurchase"))?,
            comment: nullable_text(input, "comment", 255)?,
        })
    }

    fn apply_changes(current: Self, changes: &Map<String, Value>) -> RpcResult<Self> {
        let product_id = if changes.contains_key("productId") {
            input_id(changes, "productId")?
        } else {
            current.product_id
        };
        let vendor_id = if changes.contains_key("vendorId") {
            optional_input_id(changes, "vendorId")?
        } else {
            current.vendor_id
        };
        let timestamp = if changes.contains_key("timestamp") {
            require_timestamp(changes, "timestamp")?
        } else {
            current.timestamp
        };
        let price = if changes.contains_key("pricePerBaseUnit") {
            require_number(changes, "pricePerBaseUnit")?
        } else {
            current.price
        };
        let is_real_purchase = if changes.contains_key("isRealPurchase") {
            changes
                .get("isRealPurchase")
                .and_then(Value::as_bool)
                .ok_or_else(|| bad_request("invalid isRealPurchase"))?
        } else {
            current.is_real_purchase
        };
        let comment = if changes.contains_key("comment") {
            nullable_text(changes, "comment", 255)?
        } else {
            current.comment
        };

        Ok(Self {
            product_id,
            vendor_id,
            timestamp,
            price,
            is_real_purchase,
            comment,
        })
    }
}

async fn load_price_record(pool: &PgPool, record_id: i64) -> RpcResult<PriceRecordData> {
    let row = sqlx::query_as::<_, PriceRecordData>(
        r#"
        SELECT
            product_id,
            vendor_id,
            timestamp,
            price,
            is_real_purchase,
            comment
        FROM product_price_records
        WHERE id = $1
        "#,
    )
    .bind(record_id)
    .fetch_optional(pool)
    .await
    .map_err(internal)?;

    row.ok_or_else(not_found)
}

async fn suggest_next_custom_id(
    state: &AppState,
    context: &RequestContext,
    _input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authorized_pool(state, context, "view:products").await?;

    let custom_id: Option<i32> = sqlx::query_scalar("SELECT MAX(custom_id) FROM products")
        .fetch_one(&pool)
        .await
        .map_err(internal)?;

    Ok(json!(custom_id.unwrap_or(0) + 1))
}

async fn delete_by_id(pool: &PgPool, table: &str, id: i64) -> RpcResult<()> {
    // Only module-private table constants reach this helper.
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

fn require_nonnegative_i32(input: &Map<String, Value>, key: &str) -> RpcResult<i32> {
    let value = input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad_request(format!("missing {key}")))?;

    if value < 0 || value > i64::from(i32::MAX) {
        return Err(bad_request(format!("invalid {key}")));
    }

    Ok(value as i32)
}

fn require_number(input: &Map<String, Value>, key: &str) -> RpcResult<f64> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad_request(format!("missing {key}")))
}

fn require_timestamp(input: &Map<String, Value>, key: &str) -> RpcResult<DateTime<Utc>> {
    let value = input_string(input, key)?;

    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| bad_request(format!("invalid {key}")))
}

fn require_json_object(value: &Value, key: &str) -> RpcResult<()> {
    if value.is_object() {
        Ok(())
    } else {
        Err(bad_request(format!("invalid {key}")))
    }
}

fn success() -> Value {
    json!({ "success": true })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{PriceRecordData, ProductData};

    #[test]
    fn normalizes_product_text_and_defaults_other_units() {
        let input = json!({
            "customId": 7,
            "name": "  Schraube  ",
            "baseUnit": "Stk"
        });
        let product = ProductData::for_create(input.as_object().unwrap()).unwrap();

        assert_eq!(product.name, "Schraube");
        assert_eq!(product.other_units, json!({}));
    }

    #[test]
    fn requires_complete_price_record_inputs() {
        let input = json!({
            "productId": "1",
            "pricePerBaseUnit": 2.5,
            "isRealPurchase": false
        });

        assert!(PriceRecordData::for_create(input.as_object().unwrap()).is_err());
    }
}
