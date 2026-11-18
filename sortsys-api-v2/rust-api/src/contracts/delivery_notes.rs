#![doc = " Product delivery notes and their cost calculation."]
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteScanInput {
    pub scan_id: Id,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScanHistoryEntry {
    pub id: Id,
    pub file_name: String,
    pub file_names: Vec<String>,
    pub state: ScanJobState,
    pub document_type: Option<ScanDocumentType>,
    pub error: Option<String>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub updated_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ScanJobState {
    Queued,
    Ocr,
    Matching,
    Completed,
    Failed,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryNoteScanResult {
    pub supplier: Option<String>,
    pub delivery_number: Option<String>,
    pub delivery_date: Option<String>,
    pub comment: Option<String>,
    pub records: Vec<ScannedProductRecord>,
    pub special_records: Vec<ScannedSpecialRecord>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentScanResult {
    pub document_type: ScanDocumentType,
    pub delivery_note: Option<DeliveryNoteScanResult>,
    pub price_list: Option<PriceListScanResult>,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ScanDocumentType {
    DeliveryNote,
    PriceList,
    Invoice,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PriceListScanResult {
    pub supplier: Option<String>,
    pub document_number: Option<String>,
    pub effective_date: Option<String>,
    pub rows: Vec<ScannedPriceRow>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPriceRow {
    pub source_text: String,
    pub product_id: Option<Id>,
    pub custom_id: Option<i32>,
    pub product_name: String,
    pub brand: Option<String>,
    pub description: Option<String>,
    #[ts(type = "Record<string, number>")]
    pub other_units: HashMap<String, f64>,
    pub base_unit: String,
    pub source_unit: String,
    pub price_per_base_unit: f64,
    pub confidence: f64,
    pub comment: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScannedProductRecord {
    pub source_text: String,
    pub product_id: Id,
    pub custom_id: i32,
    pub product_name: String,
    pub quantity: f64,
    pub display_quantity: f64,
    pub unit: String,
    pub base_unit: String,
    pub confidence: f64,
    pub comment: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScannedSpecialRecord {
    pub source_text: String,
    pub name: String,
    pub unit: String,
    pub amount: f64,
    pub price_per_unit: Option<f64>,
    pub confidence: f64,
    pub comment: Option<String>,
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Vec<ScanHistoryEntry>>("deliveryNotes.scan.list")
        .mutation_stub::<CompleteScanInput, DocumentScanResult>("deliveryNotes.scan.complete")
}
