#![doc = " Product catalogue, vendor, category, unit, and price-record procedures."]
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;
pub fn register_contract(mut builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder = builder.mutation_stub::<ApplyPriceImportInput, ApplyPriceImportResult>(
        "products.priceImports.apply",
    );
    builder
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyPriceImportInput {
    #[ts(optional)]
    pub request_id: Option<String>,
    pub vendor_id: Id,
    #[ts(type = "Date")]
    pub effective_at: DateTime<Utc>,
    pub is_real_purchase: bool,
    pub rows: Vec<ApplyPriceImportRow>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyPriceImportRow {
    pub product_id: Option<Id>,
    pub product_name: String,
    pub brand: Option<String>,
    pub description: Option<String>,
    pub base_unit: String,
    #[serde(default)]
    pub other_units: HashMap<String, f64>,
    pub price_per_base_unit: f64,
    pub comment: Option<String>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPriceImportResult {
    pub created_products: usize,
    pub created_price_records: usize,
}
